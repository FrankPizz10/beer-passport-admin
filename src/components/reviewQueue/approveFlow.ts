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
// The runner is deliberately re-entrant. Every run (including a
// Resume after a partial failure) first re-reads the current server
// state and performs only the steps that are still missing, so a
// retry can never record a duplicate decision:
// - an intent identical to the saved one is not re-saved;
// - a fetch that already carries an image decision is not
//   re-decided (and an already-decided 409 from the API is treated
//   as done, after re-checking the audit list);
// - a candidate that is already selected is not re-selected.
//
// Steps report live states through onSteps so the UI checklist
// shows pending / running / done / skipped / failed honestly, with
// the server's exact error on the failed step.

export type ApproveStepId = "intent" | "image" | "select";
export type ApproveStepStatus =
  | "pending"
  | "running"
  | "done"
  | "skipped"
  | "failed";

export interface ApproveStep {
  id: ApproveStepId;
  label: string;
  status: ApproveStepStatus;
  detail?: string;
  error?: string;
  // True when the intent step failed with the 409 revision
  // conflict: the UI offers a reload rather than a blind resume.
  conflict?: boolean;
}

export interface ApproveFlowResult {
  steps: ApproveStep[];
  ready: boolean;
}

export interface ApproveFlowInput {
  client: DiscoveryReviewClient;
  candidateId: number;
  // The reviewer's current, validated choice. The caller disables
  // the action entirely when no valid choice exists.
  desiredIntent: ReviewIntent;
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

// The fetch an image decision would bind to: the newest successful
// fetch (fetches are identified by increasing id).
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

  let state: LoadedState;
  try {
    state = await loadState(client, candidateId);
  } catch (e) {
    // Without a trustworthy snapshot no step may run: mark the
    // first step failed with the load error and stop.
    setStep("intent", { status: "failed", error: errorMessage(e) });
    return { steps, ready: false };
  }

  // --- (a) review intent -------------------------------------------------
  if (
    state.savedIntent &&
    intentsEqual(state.savedIntent.intent, desiredIntent)
  ) {
    setStep("intent", {
      status: "skipped",
      detail: `Already saved (revision ${state.savedIntent.id}); not saved again.`,
    });
  } else {
    setStep("intent", { status: "running" });
    try {
      const record = await client.saveReviewIntent(
        candidateId,
        state.savedIntent ? state.savedIntent.id : null,
        desiredIntent
      );
      state.savedIntent = { id: record.id, intent: record.intent };
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
      return { steps, ready: false };
    }
  }

  // --- (b) hash-bound image decision -------------------------------------
  const modeUsesImage =
    desiredIntent.mode === "image_only" || !!state.candidate.image_url;
  const latestFetch = latestSuccessfulFetch(state.fetches);
  if (!modeUsesImage) {
    setStep("image", {
      status: "skipped",
      detail: "This choice does not use the staged image.",
    });
  } else if (!latestFetch) {
    setStep("image", {
      status: "skipped",
      detail:
        "No stored image preview exists, so there are no bytes to " +
        "decide on. Fetch the image above to include an image " +
        "decision; the manifest will carry no approved image " +
        "otherwise.",
    });
  } else {
    const recorded =
      latestFetch.decision ??
      state.imageDecisions.find((d) => d.fetch_id === latestFetch.id) ??
      null;
    if (recorded) {
      setStep("image", {
        status: "done",
        detail: `Already recorded (${recorded.decision}) for fetch ${latestFetch.id}; not decided again.`,
      });
    } else {
      setStep("image", { status: "running" });
      try {
        await client.decideImage(candidateId, {
          fetch_id: latestFetch.id,
          decision: "approved",
          image_sha256: latestFetch.sha256 ?? undefined,
        });
        setStep("image", {
          status: "done",
          detail: `Approved fetch ${latestFetch.id} (SHA-256 bound).`,
        });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          // Someone (or an earlier partial run) decided this fetch
          // first. Re-check the audit list: recorded means done,
          // not failure.
          try {
            const again = await client.listImageDecisions(candidateId);
            const now = (again?.results ?? []).find(
              (d) => d.fetch_id === latestFetch.id
            );
            if (now) {
              setStep("image", {
                status: "done",
                detail: `Already recorded (${now.decision}) for fetch ${latestFetch.id}; not decided again.`,
              });
            } else {
              setStep("image", {
                status: "failed",
                error: errorMessage(e),
              });
              return { steps, ready: false };
            }
          } catch {
            setStep("image", { status: "failed", error: errorMessage(e) });
            return { steps, ready: false };
          }
        } else {
          setStep("image", { status: "failed", error: errorMessage(e) });
          return { steps, ready: false };
        }
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
    return { steps, ready: false };
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
    return { steps, ready: false };
  } else {
    setStep("select", { status: "running" });
    try {
      await client.decideCandidate(candidateId, { decision: "select" });
      setStep("select", { status: "done", detail: "Candidate selected." });
    } catch (e) {
      setStep("select", { status: "failed", error: errorMessage(e) });
      return { steps, ready: false };
    }
  }

  const ready = steps.every(
    (s) => s.status === "done" || s.status === "skipped"
  );
  return { steps, ready };
}
