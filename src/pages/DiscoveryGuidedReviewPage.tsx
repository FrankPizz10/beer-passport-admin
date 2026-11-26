import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError } from "../api/client";
import {
  CandidateEditableField,
  DiscoveryReviewClient,
  ReviewIntent,
  ReviewIntentRecord,
  buildNewBeerIntent,
  httpDiscoveryReviewClient,
  intentsEqual,
  originalFieldValue,
  proposedFromIntentBeer,
  validateFieldValue,
  REVIEW_FIELDS,
} from "../api/discoveryReview";
import {
  DiscoveryCandidateDetail,
  DiscoveryDecision,
} from "../api/types";
import HelpTip from "../components/HelpTip";
import StatusChip from "../components/StatusChip";
import { ErrorState, Loading } from "../components/States";
import { fmtDate, fmtVal } from "../components/helpers";
import GuidedImagePanel from "../components/reviewQueue/GuidedImagePanel";
import { ReviewedImageSnapshot } from "../components/reviewQueue/approveFlow";
import GuidedIntentEditor, {
  GuidedIntentMode,
  GuidedTarget,
} from "../components/reviewQueue/GuidedIntentEditor";
import MatchSuggestionsPanel from "../components/reviewQueue/MatchSuggestionsPanel";
import {
  ApproveChecklist,
  useApproveForImport,
} from "../components/reviewQueue/ApproveForImport";
import {
  prefetchCandidate,
  takePrefetched,
} from "../components/reviewQueue/prefetchCache";
import {
  QUEUE_WORKED_KEY,
  queueFilterDef,
  readStoredQueueIds,
  readStoredQueueState,
  storeQueueIds,
} from "../components/reviewQueue/queueFilters";
import { MatchSuggestions } from "../api/discoveryReview";

// Guided review: one screen per candidate, built for continuous
// work in the review queue. Order on the page: staged beer summary
// (technical history in an expandable details), likely catalog
// matches, the stored image, the four choices (Add new / Add image
// to existing beer / Hold / Reject), and the primary Approve for
// import action, which performs the intent save, image decision,
// and candidate selection in order (see approveFlow.ts).
//
// Nothing here auto-approves, auto-selects a target, or writes
// anything on load: every write is a reviewer action. The next
// candidate's data is prefetched read-only so moving forward is
// fast.

const HOLD_REASONS = [
  "missing_brewery",
  "origin_uncertain",
  "market_fit_uncertain",
  "duplicate_unresolved",
  "image_unverified",
  "metadata_incomplete",
  "out_of_scope",
  "other",
];

const stagedProposed = (
  candidate: DiscoveryCandidateDetail
): Partial<Record<CandidateEditableField, string>> => {
  const values: Partial<Record<CandidateEditableField, string>> = {};
  for (const def of REVIEW_FIELDS) {
    if (def.editable) values[def.field] = originalFieldValue(candidate, def.field);
  }
  return values;
};

const DiscoveryGuidedReviewPage: React.FC<{
  client?: DiscoveryReviewClient;
}> = ({ client = httpDiscoveryReviewClient }) => {
  const { candidateId: candidateIdParam } = useParams();
  const candidateId = Number(candidateIdParam);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const batchId = searchParams.get("batch")
    ? Number(searchParams.get("batch"))
    : readStoredQueueState()?.batchId ?? null;
  const filter = queueFilterDef(searchParams.get("filter"));
  const sub = searchParams.get("sub") ?? filter.subs?.[0]?.value;
  const query = searchParams.get("q") ?? "";
  const brewery = searchParams.get("brewery") ?? "";
  const style = searchParams.get("style") ?? "";
  const queuePage = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);

  const [candidate, setCandidate] =
    useState<DiscoveryCandidateDetail | null>(null);
  const [savedRecord, setSavedRecord] = useState<ReviewIntentRecord | null>(
    null
  );
  const [initialFetches, setInitialFetches] = useState<
    Parameters<typeof GuidedImagePanel>[0]["initialFetches"]
  >(undefined);
  const [initialDecisions, setInitialDecisions] = useState<
    Parameters<typeof GuidedImagePanel>[0]["initialDecisions"]
  >(undefined);
  const [initialSuggestions, setInitialSuggestions] =
    useState<MatchSuggestions | null | undefined>(undefined);
  const [history, setHistory] = useState<DiscoveryDecision[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [imageTick, setImageTick] = useState(0);
  // The exact stored preview currently displayed in the image
  // panel (reported by the panel only after a successful load).
  // Approve for import binds to this snapshot and nothing else.
  const [reviewedImage, setReviewedImage] =
    useState<ReviewedImageSnapshot | null>(null);

  const [mode, setMode] = useState<GuidedIntentMode | null>(null);
  const [proposed, setProposed] = useState<
    Partial<Record<CandidateEditableField, string>>
  >({});
  const [target, setTarget] = useState<GuidedTarget | null>(null);
  const [targetConfirmed, setTargetConfirmed] = useState(false);
  const seededForRef = useRef<string | null>(null);

  const [holdReason, setHoldReason] = useState("");
  const [holdNote, setHoldNote] = useState("");
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionMessage, setDecisionMessage] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);

  const [queueIds, setQueueIds] = useState<number[]>(() =>
    readStoredQueueIds()
  );
  const [queueTotal, setQueueTotal] = useState<number | null>(null);

  const queueUrl = useMemo(() => {
    const q = new URLSearchParams();
    if (batchId !== null) q.set("batch", String(batchId));
    q.set("filter", filter.id);
    if (sub) q.set("sub", sub);
    if (query) q.set("q", query);
    if (brewery) q.set("brewery", brewery);
    if (style) q.set("style", style);
    q.set("page", String(queuePage));
    return `/admin/discovery/review-queue?${q.toString()}`;
  }, [batchId, filter.id, sub, queuePage, query, brewery, style]);

  const guidedUrl = useCallback(
    (id: number, page: number) => {
      const q = new URLSearchParams();
      if (batchId !== null) q.set("batch", String(batchId));
      q.set("filter", filter.id);
      if (sub) q.set("sub", sub);
      if (query) q.set("q", query);
      if (brewery) q.set("brewery", brewery);
      if (style) q.set("style", style);
      q.set("page", String(page));
      return `/admin/discovery/review-queue/${id}?${q.toString()}`;
    },
    [batchId, filter.id, sub, query, brewery, style]
  );

  // --- Load the candidate bundle (prefetch-aware) -------------------------
  const loadAll = useCallback(async () => {
    setLoadError(null);
    try {
      const prefetched = takePrefetched(candidateId);
      const bundle = prefetched
        ? await prefetched.catch(() => null)
        : null;
      if (bundle) {
        setCandidate(bundle.candidate);
        setSavedRecord(bundle.intent);
        setInitialFetches(bundle.fetches);
        setInitialDecisions(bundle.imageDecisions);
        setInitialSuggestions(bundle.suggestions);
      } else {
        const [cand, intent] = await Promise.all([
          client.getCandidate(candidateId),
          client.getReviewIntent(candidateId),
        ]);
        setCandidate(cand);
        setSavedRecord(intent);
        setInitialFetches(undefined);
        setInitialDecisions(undefined);
        setInitialSuggestions(undefined);
      }
      const decisions = await client
        .getCandidateDecisions(candidateId)
        .catch(() => null);
      setHistory(decisions?.results ?? []);
    } catch (e) {
      setLoadError(
        e instanceof Error ? e.message : "The candidate could not be loaded."
      );
    }
  }, [candidateId, client]);

  useEffect(() => {
    setCandidate(null);
    seededForRef.current = null;
    loadAll();
  }, [loadAll]);

  // Seed the choice state from the saved intent (data only - a
  // saved intent preselects the mode/fields/target it recorded; it
  // is not a new decision).
  useEffect(() => {
    if (!candidate) return;
    const key = `${candidate.id}|${savedRecord?.id ?? "none"}`;
    if (seededForRef.current === key) return;
    seededForRef.current = key;
    if (savedRecord?.intent.mode === "image_only") {
      setMode("image_only");
      setProposed(stagedProposed(candidate));
      setTarget({
        id: savedRecord.intent.target_beer_id,
        name: "",
        breweryName: null,
      });
      setTargetConfirmed(true);
    } else if (savedRecord?.intent.mode === "new_beer") {
      setMode("new_beer");
      setProposed(proposedFromIntentBeer(savedRecord.intent.beer));
      setTarget(null);
      setTargetConfirmed(false);
    } else {
      setMode(null);
      setProposed(stagedProposed(candidate));
      setTarget(null);
      setTargetConfirmed(false);
    }
  }, [candidate, savedRecord]);

  // Resolve the name of a target seeded from a saved intent.
  useEffect(() => {
    if (target && target.name === "") {
      let cancelled = false;
      client
        .getCatalogBeer(target.id)
        .then((beer) => {
          if (!cancelled) {
            setTarget({
              id: beer.id,
              name: beer.name,
              breweryName: beer.brewery ? beer.brewery.name : null,
            });
          }
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }
  }, [target, client]);

  // --- Queue position / prev-next -----------------------------------------
  // Navigation NEVER trusts the stored page: a decision (by this
  // reviewer or anyone else) removes a row from the pending filter
  // and shifts every later page. goTo re-resolves the neighbor from
  // FRESH list data for the active filter, anchored on the current
  // candidate's ID; when the candidate itself has left the filter,
  // its last-known index into the fresh ordering names the
  // successor (next) or predecessor (previous), so items are never
  // skipped or repeated as pages shift.
  const position = queueIds.indexOf(candidateId);

  const fetchPageIds = useCallback(
    async (page: number) => {
      if (batchId === null) return null;
      const stored = readStoredQueueState();
      const resp = await client.listBatchCandidates(batchId, {
        ...filter.params(sub),
        q: query || undefined,
        brewery: brewery || undefined,
        style: style || undefined,
        page,
        page_size: stored?.pageSize ?? 50,
        sort: "name",
        direction: "asc",
      });
      return {
        ids: (resp?.results ?? []).map((r) => r.id),
        total: resp?.pagination.total_results ?? null,
      };
    },
    [batchId, client, filter, sub, query, brewery, style]
  );

  const applyPage = useCallback(
    (ids: number[], total: number | null) => {
      storeQueueIds(ids);
      setQueueIds(ids);
      if (total !== null) setQueueTotal(total);
    },
    []
  );

  useEffect(() => {
    if (queueIds.length === 0 && batchId !== null) {
      fetchPageIds(queuePage)
        .then((r) => {
          if (r) applyPage(r.ids, r.total);
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);

  const goTo = useCallback(
    async (direction: 1 | -1) => {
      if (batchId === null) return;
      const size = readStoredQueueState()?.pageSize ?? 50;
      const recordedIndex = queueIds.indexOf(candidateId);
      const land = (
        id: number,
        page: number,
        ids: number[],
        total: number | null
      ) => {
        applyPage(ids, total);
        navigate(guidedUrl(id, page));
      };

      // Anchor: find the current candidate in fresh data, starting
      // with its last-known page, then the adjacent pages (a shift
      // smaller than a page can move it across a boundary).
      const anchorPages = [queuePage, queuePage - 1, queuePage + 1].filter(
        (p) => p >= 1
      );
      let anchor: { page: number; ids: number[]; total: number | null; index: number } | null =
        null;
      let currentPageData: { ids: number[]; total: number | null } | null =
        null;
      for (const p of anchorPages) {
        const data = await fetchPageIds(p).catch(() => null);
        if (!data) continue;
        if (p === queuePage) currentPageData = data;
        const idx = data.ids.indexOf(candidateId);
        if (idx >= 0) {
          anchor = { page: p, ids: data.ids, total: data.total, index: idx };
          break;
        }
      }

      if (anchor) {
        const within = anchor.ids[anchor.index + direction];
        if (within !== undefined) {
          land(within, anchor.page, anchor.ids, anchor.total);
          return;
        }
        const neighborPage = anchor.page + direction;
        if (neighborPage < 1) return;
        const neighbor = await fetchPageIds(neighborPage).catch(() => null);
        if (!neighbor || neighbor.ids.length === 0) return;
        const targetId =
          direction === 1
            ? neighbor.ids[0]
            : neighbor.ids[neighbor.ids.length - 1];
        land(targetId, neighborPage, neighbor.ids, neighbor.total);
        return;
      }

      // The candidate has left the filter entirely. Its recorded
      // global index, read into the fresh ordering, is where its
      // successor now sits; the predecessor is one slot earlier.
      if (recordedIndex < 0) return;
      const recordedGlobal = (queuePage - 1) * size + recordedIndex;
      const targetGlobal =
        direction === 1 ? recordedGlobal : recordedGlobal - 1;
      if (targetGlobal < 0) return;
      const targetPage = Math.floor(targetGlobal / size) + 1;
      const targetIndex = targetGlobal % size;
      const targetData =
        targetPage === queuePage
          ? currentPageData
          : await fetchPageIds(targetPage).catch(() => null);
      if (!targetData || targetIndex >= targetData.ids.length) return;
      land(
        targetData.ids[targetIndex],
        targetPage,
        targetData.ids,
        targetData.total
      );
    },
    [batchId, queueIds, candidateId, queuePage, fetchPageIds, applyPage, guidedUrl, navigate]
  );

  // Prefetch the next candidate's reads (never writes).
  useEffect(() => {
    if (!candidate) return;
    const idx = queueIds.indexOf(candidateId);
    const nextId =
      idx >= 0 && idx + 1 < queueIds.length ? queueIds[idx + 1] : undefined;
    if (nextId !== undefined) prefetchCandidate(client, nextId);
  }, [candidate, queueIds, candidateId, client]);

  // --- Choice validity ------------------------------------------------------
  const hardErrorCount = useMemo(() => {
    if (!candidate || mode !== "new_beer") return 0;
    let count = 0;
    for (const def of REVIEW_FIELDS) {
      if (!def.editable) continue;
      const issue = validateFieldValue(
        def.field,
        proposed[def.field] ?? originalFieldValue(candidate, def.field)
      );
      if (issue && issue.level === "error") count += 1;
    }
    return count;
  }, [candidate, mode, proposed]);

  const desiredIntent: ReviewIntent | null = useMemo(() => {
    if (!candidate) return null;
    if (mode === "new_beer") {
      return hardErrorCount === 0 ? buildNewBeerIntent(proposed) : null;
    }
    if (mode === "image_only") {
      return target && targetConfirmed
        ? { mode: "image_only", target_beer_id: target.id }
        : null;
    }
    return null;
  }, [candidate, mode, proposed, target, targetConfirmed, hardErrorCount]);

  const approveDisabledReason: string | null = useMemo(() => {
    if (!candidate) return null;
    if (candidate.review_status !== "pending") {
      return `This candidate is ${candidate.review_status}; Approve for import is available only while a candidate is pending.`;
    }
    if (mode === null) {
      return "Choose Add new or Add image to existing beer first.";
    }
    if (mode === "new_beer" && hardErrorCount > 0) {
      return `Fix the ${hardErrorCount} field error${hardErrorCount === 1 ? "" : "s"} above before approving.`;
    }
    if (mode === "image_only" && !target) {
      return "Choose an image-only target from the suggestions or catalog search first.";
    }
    if (mode === "image_only" && target && !targetConfirmed) {
      return "Confirm the exact target beer before approving.";
    }
    return null;
  }, [candidate, mode, hardErrorCount, target, targetConfirmed]);

  const refreshAfterWrite = useCallback(async () => {
    const [cand, intent] = await Promise.all([
      client.getCandidate(candidateId),
      client.getReviewIntent(candidateId),
    ]);
    setCandidate(cand);
    setSavedRecord(intent);
    setImageTick((t) => t + 1);
    const decisions = await client
      .getCandidateDecisions(candidateId)
      .catch(() => null);
    setHistory(decisions?.results ?? []);
    try {
      sessionStorage.setItem(QUEUE_WORKED_KEY, String(candidateId));
    } catch {
      // Convenience only.
    }
  }, [candidateId, client]);

  const runner = useApproveForImport({
    candidateId,
    client,
    desiredIntent,
    reviewedImage,
    baselineIntent: savedRecord
      ? { id: savedRecord.id, intent: savedRecord.intent }
      : null,
    onCompleted: refreshAfterWrite,
    onResult: (result) => {
      // The preview the flow was bound to drifted or never loaded:
      // clear the snapshot and remount the image panel so the
      // reviewer must actually view the current stored preview
      // before a resume can approve any image. A rejected-image
      // block is different: the panel stays, and the recovery is
      // the explicit Fetch button there.
      if (result.imageBlock === "drift" || result.imageBlock === "no_snapshot") {
        setReviewedImage(null);
        setImageTick((t) => t + 1);
      }
    },
  });

  // --- Hold / Reject ---------------------------------------------------------
  const decide = async (decision: "hold" | "reject" | "unhold") => {
    if (decision !== "unhold" && !holdReason) {
      setDecisionError(
        `Choose a reason before recording a ${decision} decision.`
      );
      return;
    }
    setDecisionBusy(true);
    setDecisionError(null);
    setDecisionMessage(null);
    try {
      await client.decideCandidate(candidateId, {
        decision,
        reason: decision === "unhold" ? undefined : holdReason,
        note: holdNote.trim() ? holdNote.trim() : undefined,
      });
      setDecisionMessage(
        decision === "unhold"
          ? "Candidate returned to pending. You can change its review choice."
          : decision === "hold"
          ? "Candidate held. It stays in the batch with this reason on record."
          : "Candidate rejected. That state is final."
      );
      await refreshAfterWrite();
    } catch (e) {
      setDecisionError(
        e instanceof ApiError
          ? e.message
          : "The decision could not be recorded."
      );
    } finally {
      setDecisionBusy(false);
    }
  };

  // --- Keyboard shortcuts -----------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "Enter") {
        if (desiredIntent !== null && !runner.running) {
          e.preventDefault();
          runner.run();
        }
        return;
      }
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "[" || e.key === "ArrowLeft") {
        e.preventDefault();
        goTo(-1);
      } else if (e.key === "]" || e.key === "ArrowRight") {
        e.preventDefault();
        goTo(1);
      } else if (["1", "2", "3", "4"].includes(e.key)) {
        const control = document.querySelector<HTMLElement>(
          `[data-choice="${e.key}"]`
        );
        if (control) {
          e.preventDefault();
          control.focus();
          control.scrollIntoView({ block: "center" });
        }
      } else if (e.key === "?") {
        e.preventDefault();
        setShowShortcuts((s) => !s);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [goTo, desiredIntent, runner]);

  if (loadError) {
    return <ErrorState message={loadError} onRetry={loadAll} />;
  }
  if (!candidate) return <Loading />;

  const status = candidate.review_status;
  const alreadySavedIdentical =
    savedRecord !== null &&
    desiredIntent !== null &&
    intentsEqual(savedRecord.intent, desiredIntent);

  return (
    <div className="guided-review">
      <p>
        <Link to={queueUrl}>Back to the review queue</Link>
      </p>
      <div className="page-title-row">
        <h1>{candidate.name}</h1>
        <StatusChip status={status} />
        {candidate.hold_reason && (
          <span className="status-chip status-chip--neutral">
            {candidate.hold_reason}
          </span>
        )}
      </div>
      <p className="page-lede">
        Guided review: check the staged beer and the likely matches,
        look at the stored image, choose what should be imported,
        then Approve for import. Approving records the intent, the
        image decision, and the selection - it publishes and imports
        nothing.
      </p>
      <p className="rq-position" role="status">
        {position >= 0
          ? `Item ${position + 1} of ${queueIds.length} on this queue page` +
            (queueTotal !== null ? ` · ${queueTotal} in the current filter` : "")
          : "Opened outside the queue list"}
        {" · "}Batch: {candidate.batch.title || candidate.batch.slug}
      </p>

      <section className="review-section" aria-labelledby="guided-staged">
        <h2 id="guided-staged">Staged beer</h2>
        <div className="detail-grid">
          <div><span className="field-label">Name</span>{candidate.name}</div>
          <div><span className="field-label">Brewery</span>{fmtVal(candidate.brewery_name)}</div>
          <div><span className="field-label">Style</span>{fmtVal(candidate.style)}</div>
          <div><span className="field-label">ABV</span>{fmtVal(candidate.abv)}</div>
          <div><span className="field-label">IBU</span>{fmtVal(candidate.ibu)}</div>
          <div><span className="field-label">Barcode</span>{fmtVal(candidate.barcode)}</div>
          <div><span className="field-label">Description</span>{fmtVal(candidate.description)}</div>
          <div><span className="field-label">Dedupe Outcome</span>{candidate.dedupe_outcome}</div>
        </div>
        <details className="technical-details">
          <summary>Technical history and provenance</summary>
          <div className="detail-grid">
            <div><span className="field-label">Source</span>{candidate.source}</div>
            <div><span className="field-label">Source Record ID</span>{candidate.source_record_id}</div>
            <div>
              <span className="field-label">Source URL</span>
              {candidate.source_url ? (
                <a href={candidate.source_url}>{candidate.source_url}</a>
              ) : (
                "None"
              )}
            </div>
            <div><span className="field-label">Retrieved</span>{fmtDate(candidate.retrieved_at)}</div>
            <div><span className="field-label">Tier</span>{fmtVal(candidate.tier)}</div>
            <div><span className="field-label">Candidate Key</span>{candidate.candidate_key}</div>
            <div><span className="field-label">Origin Bucket</span>{fmtVal(candidate.origin_bucket)}</div>
            <div><span className="field-label">Image Status</span>{fmtVal(candidate.image_status)}</div>
            <div><span className="field-label">Hold Note</span>{fmtVal(candidate.hold_note)}</div>
            <div><span className="field-label">Matched Beer ID</span>{fmtVal(candidate.matched_beer_id)}</div>
          </div>
          {candidate.origin_evidence && candidate.origin_evidence.length > 0 && (
            <>
              <h3>Origin evidence</h3>
              <ul>
                {candidate.origin_evidence.map((ev, idx) => (
                  <li key={`${ev.signal}-${idx}`}>
                    {ev.signal}: {ev.value}
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3>Decision history</h3>
          {history.length > 0 ? (
            <ul>
              {history.map((d) => (
                <li key={d.id}>
                  {d.decision}
                  {d.reason ? ` | Reason: ${d.reason}` : ""} | By{" "}
                  {d.decided_by ? d.decided_by.user_name : "unknown"} |{" "}
                  {fmtDate(d.created_at)}
                  {d.note ? ` | Note: ${d.note}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p>No decisions recorded yet</p>
          )}
          {candidate.pairs && candidate.pairs.length > 0 && (
            <>
              <h3>Duplicate pairs</h3>
              <ul>
                {candidate.pairs.map((pair) => (
                  <li key={pair.id}>
                    {fmtVal(pair.comparison)} | Status: {pair.status} |{" "}
                    <Link to={`/admin/discovery/pairs/${pair.id}`}>
                      Review pair {pair.id}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </details>
      </section>

      <section className="review-section" aria-labelledby="guided-matches">
        <h2 id="guided-matches">Likely matches</h2>
        <MatchSuggestionsPanel
          candidateId={candidateId}
          client={client}
          initialData={initialSuggestions}
          onUseTarget={(t) => {
            setMode("image_only");
            setTarget(t);
            setTargetConfirmed(false);
          }}
        />
      </section>

      <section className="review-section" aria-labelledby="guided-image">
        <h2 id="guided-image">
          Image
          <HelpTip topic="image decision">
            An image decision judges one server-fetched copy of the
            staged image and binds to its SHA-256. Approving it never
            publishes or imports the image by itself.
          </HelpTip>
        </h2>
        <GuidedImagePanel
          key={`${candidateId}-${imageTick}`}
          candidate={candidate}
          client={client}
          initialFetches={initialFetches}
          initialDecisions={initialDecisions}
          onStateChange={(s) => setReviewedImage(s.reviewedSnapshot)}
        />
      </section>

      <section className="review-section" aria-labelledby="guided-choices">
        <h2 id="guided-choices">Your choice</h2>
        <p className="section-intro">
          Pick what should be imported for this candidate. Choices 1
          and 2 record a review intent; choices 3 and 4 are candidate
          decisions and end the review of this item. Existing-beer
          field updates are not supported anywhere here: Add new
          creates a beer, Add image changes no beer.
        </p>
        <GuidedIntentEditor
          candidate={candidate}
          client={client}
          savedRecord={savedRecord}
          mode={mode}
          onModeChange={setMode}
          proposed={proposed}
          onProposedChange={setProposed}
          target={target}
          onTargetChange={setTarget}
          targetConfirmed={targetConfirmed}
          onTargetConfirmedChange={setTargetConfirmed}
          onIntentSaved={(record) => setSavedRecord(record)}
        />

        <div className="guided-hold-reject">
          <h3>Or close this candidate</h3>
          <div>
            <label htmlFor="guided-decision-reason">
              Reason (required for hold and reject)
            </label>
            <select
              id="guided-decision-reason"
              value={holdReason}
              onChange={(e) => setHoldReason(e.target.value)}
            >
              <option value="">Select a reason</option>
              {HOLD_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="guided-decision-note">Note (optional)</label>
            <textarea
              id="guided-decision-note"
              value={holdNote}
              onChange={(e) => setHoldNote(e.target.value)}
              rows={2}
            />
          </div>
          <div className="decision-actions">
            {status === "held" && (
              <button type="button" className="btn" disabled={decisionBusy} onClick={() => decide("unhold")}>
                Return to pending
              </button>
            )}
            <button
              type="button"
              className="btn"
              data-choice="3"
              disabled={decisionBusy || (status !== "pending" && status !== "selected")}
              onClick={() => decide("hold")}
            >
              3. Hold
            </button>
            <button
              type="button"
              className="btn btn-danger"
              data-choice="4"
              disabled={decisionBusy || status === "rejected" || status === "superseded"}
              onClick={() => decide("reject")}
            >
              4. Reject
            </button>
          </div>
          {decisionMessage && (
            <p className="field-review-save-state" role="status">
              {decisionMessage}
            </p>
          )}
          {decisionError && (
            <div className="queue-preview-failed" role="alert">
              {decisionError}
            </div>
          )}
        </div>

        <div className="guided-approve">
          <h3>Approve for import</h3>
          {alreadySavedIdentical && (
            <p role="note">
              Your current choice matches the saved intent; Approve
              will skip re-saving it.
            </p>
          )}
          <div className="approve-flow-header">
            <button
              type="button"
              className="btn btn-primary approve-button"
              data-approve-button="true"
              disabled={
                runner.running ||
                desiredIntent === null ||
                status !== "pending"
              }
              onClick={runner.run}
            >
              {runner.running
                ? "Approving..."
                : runner.hasFailure || runner.hasBlock
                  ? "Resume - finish the remaining steps"
                  : "Approve for import"}
            </button>
            <HelpTip topic="approve for import">
              Approve for import records, in order: your review
              intent, the image approval bound to the exact stored
              preview you viewed above (when your choice uses the
              image), and the candidate selection. If the preview
              changes or was rejected, the run stops instead of
              approving different bytes. It does not publish or
              import anything: a manifest still has to be built,
              approved by its exact hash, and imported by the
              operator.
            </HelpTip>
          </div>
          {desiredIntent === null && approveDisabledReason && (
            <p className="approve-disabled-reason">{approveDisabledReason}</p>
          )}
          <ApproveChecklist runner={runner} />
        </div>
      </section>

      <div className="shortcut-hints" aria-label="Keyboard shortcuts">
        <span>
          <kbd>[</kbd>/<kbd>]</kbd> prev/next candidate
        </span>
        <span>
          <kbd>1</kbd>-<kbd>4</kbd> jump to a choice
        </span>
        <span>
          <kbd>Ctrl</kbd>+<kbd>Enter</kbd> approve for import
        </span>
        <span>
          <kbd>?</kbd> all shortcuts
        </span>
      </div>
      {showShortcuts && (
        <div className="callout callout-info" role="dialog" aria-label="Keyboard shortcuts">
          <h3>Keyboard shortcuts</h3>
          <ul>
            <li><kbd>[</kbd> or <kbd>←</kbd> - previous candidate in the queue</li>
            <li><kbd>]</kbd> or <kbd>→</kbd> - next candidate in the queue</li>
            <li><kbd>1</kbd> - Add new · <kbd>2</kbd> - Add image to existing beer · <kbd>3</kbd> - Hold · <kbd>4</kbd> - Reject</li>
            <li><kbd>Ctrl</kbd>+<kbd>Enter</kbd> - Approve for import (when enabled)</li>
            <li><kbd>?</kbd> - show or hide this list</li>
          </ul>
          <p>Shortcuts never fire while you are typing in a field.</p>
          <button type="button" className="btn" onClick={() => setShowShortcuts(false)}>
            Close
          </button>
        </div>
      )}

      <div className="guided-action-bar">
        <button
          type="button"
          className="btn"
          onClick={() => goTo(-1)}
          disabled={position <= 0 && queuePage <= 1}
        >
          ← Previous
        </button>
        <span className="guided-action-position">
          {position >= 0
            ? `${position + 1} / ${queueIds.length}`
            : candidate.name}
        </span>
        <button
          type="button"
          className="btn"
          onClick={() => goTo(1)}
        >
          Next →
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            runner.running || desiredIntent === null || status !== "pending"
          }
          onClick={runner.run}
        >
          {runner.hasFailure || runner.hasBlock
            ? "Resume"
            : "Approve for import"}
        </button>
      </div>
    </div>
  );
};

export default DiscoveryGuidedReviewPage;
