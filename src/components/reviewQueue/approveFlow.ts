import { ApiError } from "../../api/client";
import {
  DiscoveryReviewClient,
  ReviewIntent,
  intentsEqual,
} from "../../api/discoveryReview";
import {
  DiscoveryCandidateDetail,
  DiscoveryImageDecision,
  DiscoveryImageFetch,
} from "../../api/types";

// Approve-for-import orchestration: ONE reviewer action that
// performs, in order, the three records a manifest build needs -
// (a) the review intent, (b) the hash-bound image decision, (c) the
// candidate select decision - while keeping them three separate,
// audited server records. It never publishes or imports anything:
// a later manifest must still be built, hash-approved, and imported
// by the operator.
//
// IMAGE BINDING (Codex review fix): the image step approves EXACTLY
// the fetch the reviewer actually saw. The guided page passes a
// reviewed snapshot {fetchId, sha256} that is set only when a stored
// preview for that fetch successfully loaded and was displayed. The
// flow never substitutes the newest fetch at execution or resume
// time: if the reviewed fetch has disappeared, its recorded hash no
// longer matches the snapshot, or it now carries a decision, the
// step resolves by rule:
// - an APPROVED decision for exactly that fetch + hash: done;
// - a REJECTED decision for that fetch: HARD BLOCK - the flow
//   stops, the candidate is never reported ready, and no selection
//   is attempted (a manifest build would refuse it anyway);
// - any other drift: blocked - the reviewer must inspect and
//   explicitly approve the current preview before resuming.
// A 409 from the decision POST counts as success only after
// re-reading the audit list and verifying the exact reviewed fetch
// carries an APPROVED decision whose hash matches the snapshot.
//
// INTENT SAFETY: when the caller supplies the session baseline (the
// saved intent as this reviewer saw it when they made their choice,
// or the last revision this flow itself saved), a saved intent that
// has since changed to something else stops the run with a revision
// conflict instead of being silently overwritten. The server's
// expected_revision 409 protection applies on top of that.
//
// READINESS: "ready" mirrors the manifest builder's image rules
// (imageEligibility below), not just step completion: a selected
// candidate the builder would refuse is never reported ready.
//
// The runner is re-entrant. Every run (including a Resume after a
// partial failure) first re-reads the current server state and
// performs only the steps that are still missing, so a retry can
// never record a duplicate decision.

export type ApproveStepId = "intent" | "image" | "select";
export type ApproveStepStatus =
  | "pending"
  | "running"
  | "done"
  | "skipped"
  | "failed"
  | "blocked";

export interface ApproveStep {
  id: ApproveStepId;
  label: string;
  status: ApproveStepStatus;
  detail?: string;
  error?: string;
  // True when the intent step stopped on a revision conflict: the
  // UI offers a reload rather than a blind resume.
  conflict?: boolean;
}

// The exact stored preview the reviewer saw and is approving:
// set by the image panel only after the preview image for that
// fetch loaded successfully; cleared when the preview fails,
// changes, or disappears.
export interface ReviewedImageSnapshot {
  fetchId: number;
  sha256: string;
}

export type ImageBlockKind = "rejected" | "drift" | "no_snapshot" | null;

export interface ApproveFlowResult {
  steps: ApproveStep[];
  ready: boolean;
  // Human-readable manifest-eligibility blockers when the steps
  // completed but the candidate still is not importable.
  notReadyReasons: string[];
  // Why the image step blocked, so the page can react (a drift or
  // missing snapshot means the stored preview must be re-viewed
  // before any resume can approve an image).
  imageBlock: ImageBlockKind;
  // The saved intent as known at the end of the run (the record
  // this flow saved, or the one it found), so a resume in the same
  // session can use it as its baseline.
  savedIntent: { id: number; intent: ReviewIntent } | null;
}

export interface ApproveFlowInput {
  client: DiscoveryReviewClient;
  candidateId: number;
  // The reviewer's current, validated choice. The caller disables
  // the action entirely when no valid choice exists.
  desiredIntent: ReviewIntent;
  // The stored preview the reviewer actually saw, or null when no
  // preview has successfully loaded in this session.
  reviewedImage?: ReviewedImageSnapshot | null;
  // The saved intent this session started from (or last saved
  // through this flow). Omit to disable the cross-reviewer drift
  // check; pass null to assert "no intent was saved when this
  // session began".
  baselineIntent?: { id: number; intent: ReviewIntent } | null;
  onSteps?: (steps: ApproveStep[]) => void;
}

const STEP_LABELS: Record<ApproveStepId, string> = {
  intent: "Save review intent",
  image: "Approve image (hash-bound)",
  select: "Select candidate",
};

const initialSteps = (): ApproveStep[] =>
  (Object.keys(STEP_LABELS) as ApproveStepId[]).map((id) => ({
    id,
    label: STEP_LABELS[id],
    status: "pending" as ApproveStepStatus,
  }));

// The newest successful fetch (fetches are identified by increasing
// id). Used for display state only - the approve flow NEVER picks
// the fetch to approve from this; it approves the reviewed snapshot.
export const latestSuccessfulFetch = (
  fetches: DiscoveryImageFetch[]
): DiscoveryImageFetch | null => {
  let best: DiscoveryImageFetch | null = null;
  for (const f of fetches) {
    if (f.outcome === "success" && (best === null || f.id > best.id)) {
      best = f;
    }
  }
  return best;
};

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : "The request failed.";

// --- Manifest image eligibility (client mirror) ---------------------------
// Mirrors ONLY the image rules of evaluateEligibility in
// server/src/discoveryManifestCore.ts (the manifest builder):
// - hasImage = the candidate's staged image_url is a non-empty
//   string.
// - hasImage and the candidate's current image decision is
//   'rejected' -> blocker 'image_rejected'.
// - hasImage and (the current decision is not 'approved', or there
//   is no binding approved decision row for
//   image_decision_fetch_id) -> blocker 'image_unverified'.
// - intent mode 'image_only' with no approved image disposition ->
//   blocker 'approved_image_required'.
// - a new beer with NO staged image carries no image requirement.
// The builder's other rules (selection decision present, pairs
// resolved, brewery/style resolution) are enforced at build time
// and are not mirrored here; the select step surfaces the ones the
// decision endpoint itself refuses.
export interface ImageEligibility {
  ok: boolean;
  blockers: string[];
}

export const imageEligibility = (input: {
  mode: ReviewIntent["mode"];
  candidate: DiscoveryCandidateDetail;
  imageDecisions: DiscoveryImageDecision[];
  fetches: DiscoveryImageFetch[];
}): ImageEligibility => {
  const { candidate } = input;
  const blockers: string[] = [];
  const hasImage =
    typeof candidate.image_url === "string" &&
    candidate.image_url.trim() !== "";
  let hasApprovedImage = false;
  if (hasImage) {
    if (candidate.image_decision === "rejected") {
      blockers.push(
        `The candidate's current image decision is REJECTED (fetch ` +
          `${candidate.image_decision_fetch_id ?? "?"}), so a manifest ` +
          `build would refuse this candidate (image_rejected). Fetch a ` +
          `new image above and approve the new preview: the new ` +
          `decision replaces the rejected one as the current decision.`
      );
    } else if (candidate.image_decision !== "approved") {
      blockers.push(
        "The staged image has no approved decision, so a manifest " +
          "build would refuse this candidate (image_unverified) " +
          "until the exact stored preview is approved."
      );
    } else {
      const fetchId = candidate.image_decision_fetch_id;
      const fromList = input.imageDecisions.some(
        (d) => d.fetch_id === fetchId && d.decision === "approved"
      );
      const fromFetch = input.fetches.some(
        (f) => f.id === fetchId && f.decision?.decision === "approved"
      );
      if (fetchId !== null && fetchId !== undefined && (fromList || fromFetch)) {
        hasApprovedImage = true;
      } else {
        blockers.push(
          "The candidate is marked image-approved but no binding " +
            "approved decision row can be verified for fetch " +
            `${fetchId ?? "?"}, so a manifest build would refuse ` +
            "this candidate (image_unverified)."
        );
      }
    }
  }
  if (input.mode === "image_only" && !hasApprovedImage) {
    if (!hasImage) {
      blockers.push(
        "An image-only import requires an approved image decision " +
          "(approved_image_required), but this candidate has no " +
          "staged image to fetch and approve."
      );
    } else if (candidate.image_decision !== "rejected") {
      blockers.push(
        "An image-only import requires an approved image decision " +
          "(approved_image_required); none is recorded yet."
      );
    }
  }
  return { ok: blockers.length === 0, blockers };
};

// The recorded decision for one fetch, from whichever read model
// carries it (the fetch row embeds its decision; the decisions list
// is the audit). Returns the decision value and, when known from
// the audit list, the hash the decision bound to.
const decisionForFetch = (
  fetch: DiscoveryImageFetch,
  decisions: DiscoveryImageDecision[]
): { decision: string; imageSha256: string | null } | null => {
  const listed = decisions.find((d) => d.fetch_id === fetch.id);
  if (listed) {
    return { decision: listed.decision, imageSha256: listed.image_sha256 };
  }
  if (fetch.decision) {
    return { decision: fetch.decision.decision, imageSha256: null };
  }
  return null;
};

interface LoadedState {
  candidate: DiscoveryCandidateDetail;
  savedIntent: { id: number; intent: ReviewIntent } | null;
  fetches: DiscoveryImageFetch[];
  imageDecisions: DiscoveryImageDecision[];
}

const loadState = async (
  client: DiscoveryReviewClient,
  candidateId: number
): Promise<LoadedState> => {
  const [candidate, intent, fetchResp, decisionResp] = await Promise.all([
    client.getCandidate(candidateId),
    client.getReviewIntent(candidateId),
    client.listImageFetches(candidateId),
    client.listImageDecisions(candidateId),
  ]);
  return {
    candidate,
    savedIntent: intent ? { id: intent.id, intent: intent.intent } : null,
    fetches: fetchResp?.results ?? [],
    imageDecisions: decisionResp?.results ?? [],
  };
};

export async function runApproveFlow(
  input: ApproveFlowInput
): Promise<ApproveFlowResult> {
  const { client, candidateId, desiredIntent } = input;
  const steps = initialSteps();
  const emit = () => {
    if (input.onSteps) input.onSteps(steps.map((s) => ({ ...s })));
  };
  const setStep = (id: ApproveStepId, patch: Partial<ApproveStep>) => {
    const step = steps.find((s) => s.id === id);
    if (step) Object.assign(step, patch);
    emit();
  };
  emit();

  const finish = (
    state: LoadedState | null,
    extra?: Partial<ApproveFlowResult>
  ): ApproveFlowResult => ({
    steps,
    ready: false,
    notReadyReasons: [],
    imageBlock: null,
    savedIntent: state ? state.savedIntent : null,
    ...extra,
  });

  let state: LoadedState;
  try {
    state = await loadState(client, candidateId);
  } catch (e) {
    // Without a trustworthy snapshot no step may run: mark the
    // first step failed with the load error and stop.
    setStep("intent", { status: "failed", error: errorMessage(e) });
    return finish(null);
  }

  // --- (a) review intent -------------------------------------------------
  let baseline = input.baselineIntent;
  if (
    state.savedIntent &&
    intentsEqual(state.savedIntent.intent, desiredIntent)
  ) {
    baseline = state.savedIntent;
    setStep("intent", {
      status: "skipped",
      detail: `Already saved (revision ${state.savedIntent.id}); not saved again.`,
    });
  } else {
    if (baseline !== undefined) {
      // The saved intent must be exactly what this session started
      // from (or last saved through this flow). Anything else means
      // another reviewer changed it: stop, never overwrite blind.
      const baselineMatches =
        baseline === null
          ? state.savedIntent === null
          : state.savedIntent !== null &&
            (state.savedIntent.id === baseline.id ||
              intentsEqual(state.savedIntent.intent, baseline.intent));
      if (!baselineMatches) {
        setStep("intent", {
          status: "failed",
          conflict: true,
          error:
            "The saved intent was changed by someone else since " +
            "this review began, and it does not match your choice. " +
            "Nothing was overwritten. Reload the page to see the " +
            "latest intent, then decide again.",
        });
        return finish(state);
      }
    }
    setStep("intent", { status: "running" });
    try {
      const record = await client.saveReviewIntent(
        candidateId,
        state.savedIntent ? state.savedIntent.id : null,
        desiredIntent
      );
      state.savedIntent = { id: record.id, intent: record.intent };
      baseline = state.savedIntent;
      setStep("intent", {
        status: "done",
        detail: `Saved (revision ${record.id}).`,
      });
    } catch (e) {
      setStep("intent", {
        status: "failed",
        error: errorMessage(e),
        conflict: e instanceof ApiError && e.status === 409,
      });
      return finish(state);
    }
  }

  // --- (b) hash-bound image decision, bound to the reviewed preview ------
  const hasImage =
    typeof state.candidate.image_url === "string" &&
    state.candidate.image_url.trim() !== "";
  const modeUsesImage = desiredIntent.mode === "image_only" || hasImage;
  const eligibilityNow = () =>
    imageEligibility({
      mode: desiredIntent.mode,
      candidate: state.candidate,
      imageDecisions: state.imageDecisions,
      fetches: state.fetches,
    });

  if (!modeUsesImage) {
    setStep("image", {
      status: "skipped",
      detail:
        "This choice does not use a staged image: the candidate " +
        "has no image URL, and a manifest build needs no image " +
        "decision for it.",
    });
  } else {
    const snapshot = input.reviewedImage ?? null;
    let imageStepSettled = false;

    if (snapshot === null) {
      // No preview was successfully viewed in this session, so
      // there is nothing this flow may approve. If the image
      // dimension is already satisfied by an existing approved
      // decision, the step is done without any new decision.
      if (eligibilityNow().ok) {
        setStep("image", {
          status: "done",
          detail:
            `An approved image decision is already recorded ` +
            `(fetch ${state.candidate.image_decision_fetch_id}); ` +
            `no new decision was made.`,
        });
        imageStepSettled = true;
      } else if (!hasImage) {
        // Image-only with no staged image at all: nothing can ever
        // be fetched or approved here, so name the real blocker.
        setStep("image", {
          status: "blocked",
          error: eligibilityNow().blockers.join(" "),
        });
        return finish(state, {
          imageBlock: "no_snapshot",
          notReadyReasons: eligibilityNow().blockers,
        });
      } else {
        setStep("image", {
          status: "blocked",
          error:
            "Approve for import binds to the exact stored preview " +
            "you viewed, and no preview has loaded in this session " +
            "(it may have failed to load). No image was approved. " +
            "View the stored preview in the Image section above, " +
            "then resume.",
        });
        return finish(state, { imageBlock: "no_snapshot" });
      }
    } else {
      const reviewed = state.fetches.find((f) => f.id === snapshot.fetchId);
      if (
        !reviewed ||
        reviewed.outcome !== "success" ||
        reviewed.sha256 !== snapshot.sha256
      ) {
        setStep("image", {
          status: "blocked",
          error:
            "The stored preview you reviewed is no longer the " +
            "current one (the fetch is gone or its recorded hash " +
            "changed). No image was approved. Inspect the current " +
            "preview in the Image section, then resume.",
        });
        return finish(state, { imageBlock: "drift" });
      }
      const recorded = decisionForFetch(reviewed, state.imageDecisions);
      if (recorded?.decision === "rejected") {
        setStep("image", {
          status: "blocked",
          error:
            `The image you reviewed (fetch ${reviewed.id}) has ` +
            `been REJECTED, so it cannot be approved and this ` +
            `candidate cannot be reported ready. Recovery: fetch a ` +
            `new image in the Image section above - a new fetch can ` +
            `be decided - view its preview, and approve that one ` +
            `instead. The rejected decision itself is permanent ` +
            `for this fetch.`,
        });
        return finish(state, { imageBlock: "rejected" });
      }
      if (recorded?.decision === "approved") {
        if (
          recorded.imageSha256 !== null &&
          recorded.imageSha256 !== snapshot.sha256
        ) {
          setStep("image", {
            status: "blocked",
            error:
              "The recorded approval for the reviewed fetch binds " +
              "to different bytes than the preview you saw. No " +
              "action was taken. Inspect the current preview, " +
              "then resume.",
          });
          return finish(state, { imageBlock: "drift" });
        }
        setStep("image", {
          status: "done",
          detail:
            `Fetch ${reviewed.id} already carries an approved ` +
            `decision for exactly the bytes you reviewed; not ` +
            `decided again.`,
        });
        imageStepSettled = true;
      } else {
        setStep("image", { status: "running" });
        try {
          const decision = await client.decideImage(candidateId, {
            fetch_id: reviewed.id,
            decision: "approved",
            image_sha256: snapshot.sha256,
          });
          // Mirror the server's projection locally (the decision
          // POST projects image_decision / image_decision_fetch_id
          // onto the candidate) so the readiness verdict below
          // uses post-decision state.
          state.imageDecisions = [
            decision,
            ...state.imageDecisions.filter(
              (d) => d.fetch_id !== reviewed.id
            ),
          ];
          state.candidate = {
            ...state.candidate,
            image_decision: "approved",
            image_decision_fetch_id: reviewed.id,
          };
          setStep("image", {
            status: "done",
            detail:
              `Approved fetch ${reviewed.id}: exactly the preview ` +
              `you reviewed (SHA-256 bound).`,
          });
          imageStepSettled = true;
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            // Someone (or an earlier partial run) decided this
            // fetch first. Success ONLY if re-reading proves the
            // exact reviewed fetch now carries an APPROVED decision
            // bound to the reviewed hash.
            let verified: "approved" | "rejected" | "other" = "other";
            try {
              const again = await client.listImageDecisions(candidateId);
              const list = again?.results ?? [];
              state.imageDecisions = list;
              const now = list.find((d) => d.fetch_id === reviewed.id);
              if (
                now &&
                now.decision === "approved" &&
                now.image_sha256 === snapshot.sha256
              ) {
                verified = "approved";
                state.candidate = {
                  ...state.candidate,
                  image_decision: "approved",
                  image_decision_fetch_id: reviewed.id,
                };
              } else if (now && now.decision === "rejected") {
                verified = "rejected";
              }
            } catch {
              verified = "other";
            }
            if (verified === "approved") {
              setStep("image", {
                status: "done",
                detail:
                  `Fetch ${reviewed.id} was approved concurrently ` +
                  `for exactly the bytes you reviewed; not decided ` +
                  `again.`,
              });
              imageStepSettled = true;
            } else if (verified === "rejected") {
              setStep("image", {
                status: "blocked",
                error:
                  `The image you reviewed (fetch ${reviewed.id}) ` +
                  `was REJECTED by another decision while this ran, ` +
                  `so it cannot be approved and this candidate ` +
                  `cannot be reported ready. Recovery: fetch a new ` +
                  `image in the Image section above, view its ` +
                  `preview, and approve that one instead.`,
              });
              return finish(state, { imageBlock: "rejected" });
            } else {
              setStep("image", {
                status: "failed",
                error: errorMessage(e),
              });
              return finish(state);
            }
          } else {
            setStep("image", { status: "failed", error: errorMessage(e) });
            return finish(state);
          }
        }
      }
    }

    // Whatever path settled the step, the candidate must actually
    // be manifest-eligible on the image dimension: e.g. the
    // reviewed fetch was approved earlier, but a LATER decision on
    // another fetch made the candidate's current decision
    // 'rejected'. Never select (or call ready) a candidate the
    // builder would refuse.
    if (imageStepSettled) {
      const verdict = eligibilityNow();
      if (!verdict.ok) {
        setStep("image", {
          status: "blocked",
          error: verdict.blockers.join(" "),
        });
        return finish(state, {
          imageBlock:
            state.candidate.image_decision === "rejected"
              ? "rejected"
              : "drift",
          notReadyReasons: verdict.blockers,
        });
      }
    }
  }

  // --- (c) candidate select decision -------------------------------------
  // Re-read the candidate: the steps above may have run against a
  // snapshot taken before another reviewer acted.
  let fresh: DiscoveryCandidateDetail;
  try {
    fresh = await client.getCandidate(candidateId);
  } catch (e) {
    setStep("select", { status: "failed", error: errorMessage(e) });
    return finish(state);
  }
  if (fresh.review_status === "selected") {
    setStep("select", {
      status: "skipped",
      detail: "Already selected; not selected again.",
    });
  } else if (fresh.review_status !== "pending") {
    setStep("select", {
      status: "failed",
      error:
        `Candidate is ${fresh.review_status}, so it cannot be ` +
        "selected now. Resolve that state first (for example unhold " +
        "it on the candidate page), then resume.",
    });
    return finish(state);
  } else {
    setStep("select", { status: "running" });
    try {
      await client.decideCandidate(candidateId, { decision: "select" });
      setStep("select", { status: "done", detail: "Candidate selected." });
    } catch (e) {
      setStep("select", { status: "failed", error: errorMessage(e) });
      return finish(state);
    }
  }

  const stepsComplete = steps.every(
    (s) => s.status === "done" || s.status === "skipped"
  );
  const verdict = eligibilityNow();
  const ready = stepsComplete && verdict.ok;
  return {
    steps,
    ready,
    notReadyReasons: ready ? [] : verdict.blockers,
    imageBlock: null,
    savedIntent: state.savedIntent,
  };
}
