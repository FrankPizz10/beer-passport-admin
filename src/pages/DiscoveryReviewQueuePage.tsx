import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  DiscoveryReviewClient,
  httpDiscoveryReviewClient,
} from "../api/discoveryReview";
import {
  DiscoveryBatch,
  DiscoveryCandidate,
  ListResponse,
} from "../api/types";
import HelpTip from "../components/HelpTip";
import StatusChip from "../components/StatusChip";
import { ErrorState, Loading } from "../components/States";
import { fmtVal } from "../components/helpers";
import {
  QUEUE_FILTERS,
  QUEUE_WORKED_KEY,
  QueueFilterId,
  imageIndicator,
  queueFilterDef,
  readStoredQueueState,
  storeQueueIds,
  storeQueueState,
} from "../components/reviewQueue/queueFilters";

// Fast review queue: the work list for one batch, built for
// continuous reviewing. Filters map to the existing batch
// candidates endpoint's own parameters (one server-side query per
// view, page size at most 100 - never a client-side filter over a
// whole batch). Queue position (batch, filter, page) lives in the
// URL and in sessionStorage, so returning from a guided review
// lands on the same page with the worked item highlighted.
//
// Bulk actions are deliberately narrow: Hold and Reject only, for
// items the reviewer explicitly checked on this page, behind a
// confirmation summary, executed one by one with per-item
// outcomes. There is no bulk Approve, no bulk image decision, and
// no bulk intent - those judgments are per-candidate.

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

interface BulkOutcome {
  id: number;
  name: string;
  ok: boolean;
  error?: string;
}

const PAGE_SIZES = [25, 50, 100];

const DiscoveryReviewQueuePage: React.FC<{
  client?: DiscoveryReviewClient;
}> = ({ client = httpDiscoveryReviewClient }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [batches, setBatches] = useState<DiscoveryBatch[] | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [data, setData] = useState<ListResponse<DiscoveryCandidate> | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [bulkReason, setBulkReason] = useState("");
  const [bulkConfirm, setBulkConfirm] = useState<
    "hold" | "reject" | null
  >(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkOutcomes, setBulkOutcomes] = useState<BulkOutcome[] | null>(
    null
  );
  // The confirmed bulk run, snapshotted at confirmation time: the
  // exact decision, reason, and item set the reviewer confirmed.
  // Retry uses ONLY this snapshot, so editing the reason input,
  // changing the filter, or reloading rows afterwards can never
  // change what a retry applies or which items it touches.
  const [bulkSnapshot, setBulkSnapshot] = useState<{
    decision: "hold" | "reject";
    reason: string;
    items: { id: number; name: string }[];
  } | null>(null);
  const [workedId, setWorkedId] = useState<number | null>(() => {
    try {
      const raw = sessionStorage.getItem(QUEUE_WORKED_KEY);
      return raw ? Number(raw) : null;
    } catch {
      return null;
    }
  });

  // Restore stored position when the URL carries none.
  useEffect(() => {
    if (Array.from(searchParams.keys()).length === 0) {
      const stored = readStoredQueueState();
      if (stored) {
        const next = new URLSearchParams();
        next.set("batch", String(stored.batchId));
        next.set("filter", stored.filter);
        if (stored.sub) next.set("sub", stored.sub);
        if (stored.q) next.set("q", stored.q);
        if (stored.brewery) next.set("brewery", stored.brewery);
        if (stored.style) next.set("style", stored.style);
        next.set("page", String(stored.page));
        next.set("page_size", String(stored.pageSize));
        setSearchParams(next, { replace: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const batchIdParam = searchParams.get("batch");
  const query = searchParams.get("q") ?? "";
  const brewery = searchParams.get("brewery") ?? "";
  const style = searchParams.get("style") ?? "";
  const filter = queueFilterDef(searchParams.get("filter"));
  const sub = searchParams.get("sub") ?? filter.subs?.[0]?.value;
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
  const pageSize = PAGE_SIZES.includes(Number(searchParams.get("page_size")))
    ? Number(searchParams.get("page_size"))
    : 50;

  useEffect(() => {
    let cancelled = false;
    client
      .listBatches()
      .then((resp) => {
        if (!cancelled) setBatches(resp?.results ?? []);
      })
      .catch((e) => {
        if (!cancelled) {
          setBatchError(
            e instanceof Error ? e.message : "Batches could not be loaded."
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const batchId = useMemo(() => {
    if (batchIdParam) return Number(batchIdParam);
    return batches && batches.length > 0 ? batches[0].id : null;
  }, [batchIdParam, batches]);

  const updateParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next);
  };

  // Load the current page of the queue.
  useEffect(() => {
    if (batchId === null) return;
    let cancelled = false;
    setLoading(true);
    setListError(null);
    client
      .listBatchCandidates(batchId, {
        ...filter.params(sub),
        q: query || undefined,
        brewery: brewery || undefined,
        style: style || undefined,
        page,
        page_size: pageSize,
        sort: "name",
        direction: "asc",
      })
      .then((resp) => {
        if (cancelled) return;
        setData(resp);
        setLoading(false);
        storeQueueIds((resp?.results ?? []).map((r) => r.id));
        storeQueueState({
          batchId,
          filter: filter.id as QueueFilterId,
          sub,
          page,
          pageSize,
          q: query,
          brewery,
          style,
        });
      })
      .catch((e) => {
        if (!cancelled) {
          setListError(
            e instanceof Error ? e.message : "Candidates could not be loaded."
          );
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, batchId, filter.id, sub, page, pageSize, query, brewery, style, reloadTick]);

  // Selection and bulk state belong to one page view only.
  useEffect(() => {
    setChecked(new Set());
    setBulkConfirm(null);
    setBulkOutcomes(null);
    setBulkSnapshot(null);
  }, [batchId, filter.id, sub, page, query, brewery, style]);

  // Scroll the returned-to item into view.
  useEffect(() => {
    if (workedId !== null && data) {
      const el = document.querySelector(
        `[data-queue-row="${workedId}"]`
      );
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "center" });
      }
    }
  }, [workedId, data]);

  const rows = data?.results ?? [];
  const totalPages = data?.pagination.total_pages ?? 1;
  const totalResults = data?.pagination.total_results ?? 0;
  const batch = batches?.find((b) => b.id === batchId) ?? null;

  const toggleChecked = (id: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runBulk = async (
    decision: "hold" | "reject",
    reason: string,
    items: { id: number; name: string }[]
  ): Promise<BulkOutcome[]> => {
    const outcomes: BulkOutcome[] = [];
    for (const item of items) {
      try {
        await client.decideCandidate(item.id, { decision, reason });
        outcomes.push({ id: item.id, name: item.name, ok: true });
      } catch (e) {
        outcomes.push({
          id: item.id,
          name: item.name,
          ok: false,
          error: e instanceof Error ? e.message : "Decision failed.",
        });
      }
    }
    return outcomes;
  };

  const confirmBulk = async () => {
    if (!bulkConfirm || bulkReason === "") return;
    // Snapshot BEFORE running: the decision, the reason, and the
    // exact items (with the names shown in the confirmation), so
    // the run and any later retry are immune to input changes.
    const snapshot = {
      decision: bulkConfirm,
      reason: bulkReason,
      items: rows
        .filter((r) => checked.has(r.id))
        .map((r) => ({ id: r.id, name: r.name })),
    };
    if (snapshot.items.length === 0) return;
    setBulkSnapshot(snapshot);
    setBulkBusy(true);
    const outcomes = await runBulk(
      snapshot.decision,
      snapshot.reason,
      snapshot.items
    );
    setBulkOutcomes(outcomes);
    setBulkBusy(false);
    setBulkConfirm(null);
    setChecked(new Set(outcomes.filter((o) => !o.ok).map((o) => o.id)));
    setReloadTick((t) => t + 1);
  };

  // Retry ONLY the failed items from the confirmed snapshot, with
  // the snapshot's decision and ORIGINALLY confirmed reason - even
  // if the reason input, the note field, or the filter has changed
  // since. Successful items are never re-decided.
  const retryFailed = async () => {
    if (!bulkOutcomes || !bulkSnapshot) return;
    const failedIds = new Set(
      bulkOutcomes.filter((o) => !o.ok).map((o) => o.id)
    );
    if (failedIds.size === 0) return;
    const items = bulkSnapshot.items.filter((i) => failedIds.has(i.id));
    setBulkBusy(true);
    const retried = await runBulk(
      bulkSnapshot.decision,
      bulkSnapshot.reason,
      items
    );
    const byId = new Map(retried.map((o) => [o.id, o]));
    setBulkOutcomes(
      bulkOutcomes.map((o) => (byId.has(o.id) ? byId.get(o.id)! : o))
    );
    setChecked(
      new Set(retried.filter((o) => !o.ok).map((o) => o.id))
    );
    setBulkBusy(false);
    setReloadTick((t) => t + 1);
  };

  const guidedLink = (candidateId: number) => {
    const q = new URLSearchParams();
    if (batchId !== null) q.set("batch", String(batchId));
    q.set("filter", filter.id);
    if (sub) q.set("sub", sub);
    if (query) q.set("q", query);
    if (brewery) q.set("brewery", brewery);
    if (style) q.set("style", style);
    q.set("page", String(page));
    return `/admin/discovery/review-queue/${candidateId}?${q.toString()}`;
  };

  const markWorked = (id: number) => {
    setWorkedId(id);
    try {
      sessionStorage.setItem(QUEUE_WORKED_KEY, String(id));
    } catch {
      // Highlighting is a convenience only.
    }
  };

  return (
    <div className="review-queue-page">
      <h1>Review Queue</h1>
      <p className="page-lede">
        Work through a batch's staged candidates one at a time with
        the guided review: staged values, likely catalog matches, the
        stored image, and one Approve for import action per candidate.
        The queue is the full filtered set reported by the API (never
        a sample); reviewing here records intents and decisions, and
        imports nothing - import stays a later manifest step gated on
        the exact manifest hash, run by the operator.
      </p>

      {batchError && (
        <ErrorState message={batchError} onRetry={() => window.location.reload()} />
      )}

      <div className="filters rq-filters">
        <div><label htmlFor="rq-brewery">Brewery</label><input id="rq-brewery" value={brewery} onChange={(e) => updateParams({ brewery: e.target.value || null, page: "1" })} /></div>
        <div><label htmlFor="rq-style">Style</label><input id="rq-style" value={style} onChange={(e) => updateParams({ style: e.target.value || null, page: "1" })} /></div>
        <div>
          <label htmlFor="rq-search">Search beer or brewery</label>
          <input id="rq-search" value={query} onChange={(e) => updateParams({ q: e.target.value || null, page: "1" })} />
        </div>
        <div>
          <label htmlFor="rq-batch">Batch</label>
          <select
            id="rq-batch"
            value={batchId ?? ""}
            onChange={(e) =>
              updateParams({ batch: e.target.value, page: "1" })
            }
          >
            {batches === null && <option value="">Loading batches...</option>}
            {(batches ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.title || b.slug} ({b.record_count} records)
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="rq-filter">Filter</label>
          <select
            id="rq-filter"
            value={filter.id}
            onChange={(e) =>
              updateParams({ filter: e.target.value, sub: null, page: "1" })
            }
          >
            {QUEUE_FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        {filter.subs && (
          <div>
            <label htmlFor="rq-filter-sub">{filter.label} detail</label>
            <select
              id="rq-filter-sub"
              value={sub ?? filter.subs[0].value}
              onChange={(e) => updateParams({ sub: e.target.value, page: "1" })}
            >
              {filter.subs.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="rq-page-size">Page size</label>
          <select
            id="rq-page-size"
            value={pageSize}
            onChange={(e) =>
              updateParams({ page_size: e.target.value, page: "1" })
            }
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="rq-filter-desc">
        {filter.description}{" "}
        {batch && (
          <>
            Batch progress: {batch.review_progress.decided}/
            {batch.review_progress.total} reviewed (
            {batch.review_progress.percent_reviewed}%).
          </>
        )}
      </p>

      {loading && <Loading />}
      {listError && (
        <ErrorState message={listError} onRetry={() => setReloadTick((t) => t + 1)} />
      )}

      {!loading && !listError && (
        <>
          <p role="status">
            {totalResults} candidates in this view · Page {page} of{" "}
            {totalPages}
          </p>
          {rows.length === 0 ? (
            <div className="state-box">
              No candidates match this filter. Try another filter, or
              check the batch's full candidate list.
            </div>
          ) : (
            <ul className="rq-list">
              {rows.map((row) => (
                <li
                  key={row.id}
                  data-queue-row={row.id}
                  className={
                    workedId === row.id
                      ? "rq-row rq-row--worked"
                      : "rq-row"
                  }
                >
                  <label className="rq-check">
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.name} for bulk action`}
                      checked={checked.has(row.id)}
                      onChange={() => toggleChecked(row.id)}
                    />
                  </label>
                  <div className="rq-row-main">
                    <Link
                      to={guidedLink(row.id)}
                      onClick={() => markWorked(row.id)}
                    >
                      <strong>{row.name}</strong>
                    </Link>{" "}
                    <span className="rq-row-sub">
                      {fmtVal(row.brewery_name)} · ABV {fmtVal(row.abv)} ·{" "}
                      {imageIndicator(row)}
                    </span>
                    <span className="chip-row">
                      <StatusChip status={row.review_status} />
                      {row.hold_reason && (
                        <span className="status-chip status-chip--neutral">
                          {row.hold_reason.replace(/_/g, " ")}
                        </span>
                      )}
                      {row.matched_beer_id !== null &&
                        row.matched_beer_id !== undefined && (
                          <span className="status-chip status-chip--neutral">
                            Detector match #{row.matched_beer_id}
                          </span>
                        )}
                    </span>
                  </div>
                  <Link
                    className="btn rq-review-btn"
                    to={guidedLink(row.id)}
                    onClick={() => markWorked(row.id)}
                  >
                    Review
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <div className="pagination">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => updateParams({ page: String(page - 1) })}
            >
              Previous page
            </button>
            <span>
              Page {page} of {totalPages} ({totalResults} total)
            </span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => updateParams({ page: String(page + 1) })}
            >
              Next page
            </button>
          </div>

          {checked.size > 0 && (
            <div className="rq-bulk-bar">
              <strong>{checked.size} checked</strong>
              <label htmlFor="rq-bulk-reason">
                Reason (required for hold and reject)
              </label>
              <select
                id="rq-bulk-reason"
                value={bulkReason}
                onChange={(e) => setBulkReason(e.target.value)}
              >
                <option value="">Select a reason</option>
                {HOLD_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn"
                disabled={bulkReason === "" || bulkBusy}
                onClick={() => setBulkConfirm("hold")}
              >
                Hold checked
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={bulkReason === "" || bulkBusy}
                onClick={() => setBulkConfirm("reject")}
              >
                Reject checked
              </button>
              <span className="rq-bulk-note">
                Bulk covers Hold and Reject only. There is no bulk
                Approve, no bulk image decision, and no bulk intent:
                those judgments are per-candidate in the guided
                review.
                <HelpTip topic="bulk actions">
                  Bulk hold/reject applies one decision, with the
                  reason you chose, to exactly the items checked on
                  this page. Each item reports its own outcome, and
                  failures stay checked so you can retry just them.
                </HelpTip>
              </span>
            </div>
          )}

          {bulkConfirm && (
            <div className="callout callout-warning" role="alertdialog" aria-label={`Confirm bulk ${bulkConfirm}`}>
              <h3>
                Confirm bulk {bulkConfirm}: {checked.size} candidates
              </h3>
              <p>
                Reason: {bulkReason}. This records a {bulkConfirm}{" "}
                decision for each of these candidates:
              </p>
              <ul>
                {rows
                  .filter((r) => checked.has(r.id))
                  .map((r) => (
                    <li key={r.id}>
                      {r.name} (#{r.id})
                    </li>
                  ))}
              </ul>
              <div className="decision-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={bulkBusy}
                  onClick={confirmBulk}
                >
                  {bulkBusy
                    ? "Working..."
                    : `Confirm ${bulkConfirm} for ${checked.size} candidates`}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={bulkBusy}
                  onClick={() => setBulkConfirm(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {bulkOutcomes && (
            <div className="rq-bulk-outcomes" role="status">
              <h3>Bulk results</h3>
              <ul>
                {bulkOutcomes.map((o) => (
                  <li key={o.id}>
                    {o.ok ? "✓" : "✗"} {o.name} (#{o.id})
                    {o.ok ? " - done" : ` - failed: ${o.error}`}
                  </li>
                ))}
              </ul>
              {bulkOutcomes.some((o) => !o.ok) && (
                <p>
                  The failed items are still checked above.{" "}
                  <button
                    type="button"
                    className="btn"
                    disabled={bulkBusy}
                    onClick={retryFailed}
                  >
                    Retry failed only
                  </button>{" "}
                  retries just those items with the decision and the
                  originally confirmed reason, even if the reason
                  input has changed since; succeeded items are not
                  decided again.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default DiscoveryReviewQueuePage;
