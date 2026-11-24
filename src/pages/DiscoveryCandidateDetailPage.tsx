import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet, apiPost, ApiError } from "../api/client";
import { useApiData } from "../api/useApiData";
import {
  DiscoveryCandidateDetail,
  DiscoveryDecision,
  ListResponse,
} from "../api/types";
import { ErrorState, Loading } from "../components/States";
import { fmtBool, fmtDate, fmtVal } from "../components/helpers";
import DiscoveryImageReviewPanel from "./DiscoveryImageReviewPanel";

// The hold-reason vocabulary (issues/001); the API requires one for
// hold and reject decisions and refuses the decision without it.
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

const FINAL_STATUSES = ["rejected", "superseded"];

const DiscoveryCandidateDetailPage: React.FC = () => {
  const { id } = useParams();
  const { data, loading, error, reload } = useApiData(
    () => apiGet<DiscoveryCandidateDetail>(`/discovery/candidates/${id}`),
    [id]
  );
  const [historyTick, setHistoryTick] = useState(0);
  const { data: history } = useApiData(
    () =>
      apiGet<ListResponse<DiscoveryDecision>>(
        `/discovery/candidates/${id}/decisions`,
        { page_size: 100 }
      ),
    [id, historyTick]
  );
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data)
    return <ErrorState message="Discovery candidate not found" onRetry={reload} />;

  const status = data.review_status;
  const isFinal = FINAL_STATUSES.includes(status);
  const pendingPairs = (data.pairs || []).filter((p) => p.status === "pending");
  const selectBlockedByPair = status === "pending" && pendingPairs.length > 0;

  const decide = async (decision: string) => {
    if ((decision === "hold" || decision === "reject") && !reason) {
      setActionError(`Choose a reason before recording a ${decision} decision.`);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const body: Record<string, string> = { decision };
      if (reason) body.reason = reason;
      if (note.trim()) body.note = note.trim();
      await apiPost(`/discovery/candidates/${id}/decide`, body);
      setReason("");
      setNote("");
      setHistoryTick((t) => t + 1);
      reload();
    } catch (e) {
      setActionError(
        e instanceof ApiError ? e.message : "The decision could not be recorded."
      );
    } finally {
      setBusy(false);
    }
  };

  const dimensions =
    data.image_width !== null && data.image_width !== undefined &&
    data.image_height !== null && data.image_height !== undefined
      ? `${data.image_width} x ${data.image_height}`
      : null;

  return (
    <div>
      <h1>{data.name}</h1>

      <h2>Overview</h2>
      <div className="detail-grid">
        <div><span className="field-label">Name</span>{data.name}</div>
        <div><span className="field-label">Brewery</span>{fmtVal(data.brewery_name)}</div>
        <div><span className="field-label">Style</span>{fmtVal(data.style)}</div>
        <div><span className="field-label">ABV</span>{fmtVal(data.abv)}</div>
        <div><span className="field-label">IBU</span>{fmtVal(data.ibu)}</div>
        <div><span className="field-label">Barcode</span>{fmtVal(data.barcode)}</div>
        <div><span className="field-label">Description</span>{fmtVal(data.description)}</div>
      </div>

      <h2>Provenance</h2>
      <div className="detail-grid">
        <div><span className="field-label">Source</span>{data.source}</div>
        <div><span className="field-label">Source Record ID</span>{data.source_record_id}</div>
        <div><span className="field-label">Source URL</span>{data.source_url ? <a href={data.source_url}>{data.source_url}</a> : "None"}</div>
        <div><span className="field-label">Retrieved</span>{fmtDate(data.retrieved_at)}</div>
        <div><span className="field-label">Tier</span>{fmtVal(data.tier)}</div>
        <div><span className="field-label">Candidate Key</span>{data.candidate_key}</div>
        <div>
          <span className="field-label">Batch</span>
          <Link to={`/admin/discovery/batches/${data.batch.id}/candidates`}>
            {data.batch.title || data.batch.slug}
          </Link>
        </div>
        <div><span className="field-label">Created</span>{fmtDate(data.created_at)}</div>
        <div><span className="field-label">Updated</span>{fmtDate(data.updated_at)}</div>
      </div>

      <h2>Origin</h2>
      <div className="detail-grid">
        <div><span className="field-label">Origin Bucket</span>{fmtVal(data.origin_bucket)}</div>
      </div>
      {data.origin_evidence && data.origin_evidence.length > 0 ? (
        <ul>
          {data.origin_evidence.map((evidence, idx) => (
            <li key={`${evidence.signal}-${idx}`}>
              {evidence.signal}: {evidence.value}
            </li>
          ))}
        </ul>
      ) : (
        <p>No origin evidence recorded</p>
      )}

      <h2>Image</h2>
      <div className="detail-grid">
        <div><span className="field-label">Image Status</span>{fmtVal(data.image_status)}</div>
        <div><span className="field-label">Image Status (Normalized)</span>{fmtVal(data.image_status_normalized)}</div>
        <div><span className="field-label">Image Verified</span>{fmtBool(data.image_verified)}</div>
        <div><span className="field-label">Image URL</span>{data.image_url ? <a href={data.image_url}>{data.image_url}</a> : "None"}</div>
        <div><span className="field-label">Image Source</span>{fmtVal(data.image_source)}</div>
        <div><span className="field-label">Image Tier</span>{fmtVal(data.image_tier)}</div>
        <div><span className="field-label">Dimensions</span>{fmtVal(dimensions)}</div>
        <div><span className="field-label">Flag Reason</span>{fmtVal(data.image_flag_reason)}</div>
        <div><span className="field-label">License</span>{fmtVal(data.image_license)}</div>
        <div><span className="field-label">Image Page URL</span>{data.image_page_url ? <a href={data.image_page_url}>{data.image_page_url}</a> : "None"}</div>
      </div>

      <DiscoveryImageReviewPanel candidate={data} onDecisionRecorded={reload} />

      <h2>Review State</h2>
      <div className="detail-grid">
        <div><span className="field-label">Review Status</span>{data.review_status}</div>
        <div><span className="field-label">Hold Reason</span>{fmtVal(data.hold_reason)}</div>
        <div><span className="field-label">Hold Note</span>{fmtVal(data.hold_note)}</div>
        <div><span className="field-label">Dedupe Outcome</span>{data.dedupe_outcome}</div>
        <div><span className="field-label">Matched Beer ID</span>{fmtVal(data.matched_beer_id)}</div>
        <div><span className="field-label">Duplicate Of Candidate ID</span>{fmtVal(data.duplicate_of_candidate_id)}</div>
      </div>

      <h2>Review Decision</h2>
      {isFinal ? (
        <p>
          This candidate is {status}. That state is final and it cannot be
          decided again.
        </p>
      ) : (
        <div className="decision-form">
          {status === "held" && (
            <p>
              This candidate is held, and a held candidate cannot be
              selected. Unhold it first if the hold no longer applies.
            </p>
          )}
          {selectBlockedByPair && (
            <p>
              Selection is blocked until the unresolved duplicate pair
              {pendingPairs.length > 1 ? "s are" : " is"} resolved:{" "}
              {pendingPairs.map((p, i) => (
                <span key={p.id}>
                  {i > 0 ? ", " : ""}
                  <Link to={`/admin/discovery/pairs/${p.id}`}>
                    review pair {p.id}
                  </Link>
                </span>
              ))}
              .
            </p>
          )}
          <div>
            <label htmlFor="decision-reason">Reason (required for hold and reject)</label>
            <select
              id="decision-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              <option value="">Select a reason</option>
              {HOLD_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="decision-note">Note (optional; required with reason other)</label>
            <textarea
              id="decision-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
            />
          </div>
          <div className="decision-actions">
            <button
              type="button"
              disabled={busy || status !== "pending" || selectBlockedByPair}
              onClick={() => decide("select")}
            >
              Select candidate
            </button>
            <button
              type="button"
              disabled={busy || (status !== "pending" && status !== "selected")}
              onClick={() => decide("hold")}
            >
              Hold candidate
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => decide("reject")}
            >
              Reject candidate
            </button>
            <button
              type="button"
              disabled={busy || status !== "held"}
              onClick={() => decide("unhold")}
            >
              Unhold candidate
            </button>
          </div>
          {actionError && (
            <div className="queue-preview-failed" role="alert">
              {actionError}
            </div>
          )}
        </div>
      )}

      <h2>Decision History</h2>
      {history && history.results.length > 0 ? (
        <ul>
          {history.results.map((d) => (
            <li key={d.id}>
              {d.decision}
              {d.from_status || d.to_status
                ? ` (${fmtVal(d.from_status)} -> ${fmtVal(d.to_status)})`
                : ""}
              {d.reason ? ` | Reason: ${d.reason}` : ""}
              {d.pair_id ? ` | Pair ${d.pair_id}` : ""} | By{" "}
              {d.decided_by ? d.decided_by.user_name : "unknown"} |{" "}
              {fmtDate(d.created_at)}
              {d.note ? ` | Note: ${d.note}` : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p>No decisions recorded yet</p>
      )}

      <h2>Duplicate Pairs</h2>
      {data.pairs && data.pairs.length > 0 ? (
        <ul>
          {data.pairs.map((pair) => (
            <li key={pair.id}>
              {fmtVal(pair.comparison)} | Method: {fmtVal(pair.method)} | Score:{" "}
              {fmtVal(pair.score)} | Status: {pair.status} | Rival:{" "}
              {pair.rival ? (
                <Link to={`/admin/discovery/candidates/${pair.rival.id}`}>
                  {pair.rival.name}
                  {pair.rival.brewery_name ? ` (${pair.rival.brewery_name})` : ""}
                </Link>
              ) : (
                fmtVal(pair.external_ref)
              )}{" "}
              | <Link to={`/admin/discovery/pairs/${pair.id}`}>Review pair</Link>
            </li>
          ))}
        </ul>
      ) : (
        <p>No duplicate pairs recorded</p>
      )}
    </div>
  );
};

export default DiscoveryCandidateDetailPage;
