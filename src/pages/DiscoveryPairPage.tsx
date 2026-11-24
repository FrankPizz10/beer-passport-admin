import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet, apiPost, ApiError } from "../api/client";
import { useApiData } from "../api/useApiData";
import { DiscoveryPairDetail, DiscoveryPairSide } from "../api/types";
import { ErrorState, Loading } from "../components/States";
import { fmtDate, fmtVal } from "../components/helpers";

// Side-by-side duplicate review for one ambiguous pair (issues/001):
// the flagged candidate and its rival (a staged candidate from any
// batch, an external reference when the rival is not staged, and the
// live catalog beer when the candidate collided with one at ingest).
// The pair decision is the candidate-selection gate's duplicate
// resolution: "same" supersedes the flagged candidate as a duplicate
// of the rival; "distinct" leaves both candidates untouched.
const SideCard: React.FC<{ title: string; side: DiscoveryPairSide | null }> = ({
  title,
  side,
}) => (
  <div className="pair-side">
    <h3>{title}</h3>
    {side ? (
      <div className="detail-grid">
        <div>
          <span className="field-label">Name</span>
          <Link to={`/admin/discovery/candidates/${side.id}`}>{side.name}</Link>
        </div>
        <div><span className="field-label">Brewery</span>{fmtVal(side.brewery_name)}</div>
        <div><span className="field-label">Style</span>{fmtVal(side.style)}</div>
        <div><span className="field-label">ABV</span>{fmtVal(side.abv)}</div>
        <div><span className="field-label">Barcode</span>{fmtVal(side.barcode)}</div>
        <div><span className="field-label">Source</span>{side.source}</div>
        <div><span className="field-label">Source Record ID</span>{side.source_record_id}</div>
        <div>
          <span className="field-label">Source URL</span>
          {side.source_url ? <a href={side.source_url}>{side.source_url}</a> : "None"}
        </div>
        <div><span className="field-label">Origin Bucket</span>{fmtVal(side.origin_bucket)}</div>
        <div><span className="field-label">Image Status</span>{fmtVal(side.image_status)}</div>
        <div><span className="field-label">Image Status (Normalized)</span>{fmtVal(side.image_status_normalized)}</div>
        <div><span className="field-label">Review Status</span>{side.review_status}</div>
        <div><span className="field-label">Hold Reason</span>{fmtVal(side.hold_reason)}</div>
      </div>
    ) : (
      <p>Not staged in the hub (it lives in another batch).</p>
    )}
  </div>
);

const DiscoveryPairPage: React.FC = () => {
  const { pairId } = useParams();
  const { data, loading, error, reload } = useApiData(
    () => apiGet<DiscoveryPairDetail>(`/discovery/pairs/${pairId}`),
    [pairId]
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data)
    return <ErrorState message="Discovery pair not found" onRetry={reload} />;

  const candidateFinal =
    data.candidate !== null &&
    (data.candidate.review_status === "rejected" ||
      data.candidate.review_status === "superseded");
  const pending = data.status === "pending";

  const decide = async (decision: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await apiPost(`/discovery/pairs/${pairId}/decide`, {
        decision,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setNote("");
      reload();
    } catch (e) {
      setActionError(
        e instanceof ApiError ? e.message : "The pair decision could not be recorded."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1>Duplicate Pair Review</h1>
      <div className="detail-grid">
        <div><span className="field-label">Comparison</span>{fmtVal(data.comparison)}</div>
        <div><span className="field-label">Method</span>{fmtVal(data.method)}</div>
        <div><span className="field-label">Similarity Score</span>{fmtVal(data.score)}</div>
        <div><span className="field-label">Status</span>{data.status}</div>
        {data.decided_by && (
          <div>
            <span className="field-label">Decided By</span>
            {data.decided_by.user_name} | {fmtDate(data.decided_at)}
          </div>
        )}
        {data.candidate && data.candidate.matched_beer_id !== null && (
          <div>
            <span className="field-label">Live Catalog Match</span>
            <Link to={`/admin/catalog/beers/${data.candidate.matched_beer_id}`}>
              Beer {data.candidate.matched_beer_id}
            </Link>
          </div>
        )}
      </div>

      <div className="pair-compare">
        <SideCard title="Candidate" side={data.candidate} />
        <SideCard
          title={
            data.rival
              ? "Rival candidate"
              : `Rival (external): ${fmtVal(data.external_ref)}`
          }
          side={data.rival}
        />
      </div>

      <h2>Pair Decision</h2>
      {pending ? (
        <div className="decision-form">
          {candidateFinal && (
            <p>
              The candidate is {data.candidate?.review_status}, a final
              state, so it cannot be marked as a duplicate. The pair can
              still be recorded as distinct.
            </p>
          )}
          <div>
            <label htmlFor="pair-decision-note">Note (optional)</label>
            <textarea
              id="pair-decision-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
            />
          </div>
          <div className="decision-actions">
            <button
              type="button"
              disabled={busy || candidateFinal}
              onClick={() => decide("same")}
            >
              Same beer: mark candidate as duplicate
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => decide("distinct")}
            >
              Distinct beers
            </button>
          </div>
          {actionError && (
            <div className="queue-preview-failed" role="alert">
              {actionError}
            </div>
          )}
        </div>
      ) : (
        <p>
          This pair was decided as {data.status}
          {data.decided_by
            ? ` by ${data.decided_by.user_name} on ${fmtDate(data.decided_at)}`
            : ""}
          .
        </p>
      )}
    </div>
  );
};

export default DiscoveryPairPage;
