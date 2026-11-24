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
import HelpTip from "../components/HelpTip";
import StatusChip from "../components/StatusChip";
import DiscoveryImageReviewPanel from "./DiscoveryImageReviewPanel";
import DiscoveryCandidateFieldReview from "../components/DiscoveryCandidateFieldReview";

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

// Section header for the five-step review flow: a numbered badge,
// the step title, and an optional contextual help tip. The steps
// are separate records on the server and stay visually separate
// here: an intent (step 2), an image decision (step 3), and the
// candidate decision (step 4) never imply each other.
const ReviewStepHeader: React.FC<{
  step: number;
  id: string;
  title: string;
  helpTopic?: string;
  helpText?: React.ReactNode;
}> = ({ step, id, title, helpTopic, helpText }) => (
  <div className="review-section-header">
    <span className="step-badge" aria-hidden="true">
      {step}
    </span>
    <h2 id={id}>{title}</h2>
    {helpTopic && helpText ? (
      <HelpTip topic={helpTopic}>{helpText}</HelpTip>
    ) : null}
  </div>
);

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
  // Bumped when the review-intent section saves an intent, so the
  // image panel's existing-beer panel re-reads the saved intent.
  const [intentTick, setIntentTick] = useState(0);

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
      <p>
        <Link
          to={`/admin/discovery/batches/${data.batch.id}/candidates`}
        >
          Back to candidates in {data.batch.title || data.batch.slug}
        </Link>
      </p>
      <div className="page-title-row">
        <h1>{data.name}</h1>
        <StatusChip status={status} />
      </div>
      <p className="page-lede">
        Review this staged candidate in five steps. Each step is a
        separate record: the review intent (step 2) says what should
        be imported, the image decision (step 3) judges the fetched
        image bytes, and the candidate decision (step 4) selects,
        holds, or rejects the candidate itself. None of them implies
        another, and nothing on this page publishes or imports
        anything.
      </p>

      <section className="review-section" aria-labelledby="review-step-1">
        <ReviewStepHeader
          step={1}
          id="review-step-1"
          title="Staged beer and source evidence"
        />
        <p className="section-intro">
          What the source staged for this candidate, exactly as
          recorded. Staged values are evidence, not catalog facts:
          check them before confirming anything in step 2.
        </p>
        <h3>Staged beer</h3>
        <div className="detail-grid">
          <div><span className="field-label">Name</span>{data.name}</div>
          <div><span className="field-label">Brewery</span>{fmtVal(data.brewery_name)}</div>
          <div><span className="field-label">Style</span>{fmtVal(data.style)}</div>
          <div><span className="field-label">ABV</span>{fmtVal(data.abv)}</div>
          <div><span className="field-label">IBU</span>{fmtVal(data.ibu)}</div>
          <div><span className="field-label">Barcode</span>{fmtVal(data.barcode)}</div>
          <div><span className="field-label">Description</span>{fmtVal(data.description)}</div>
        </div>

        <h3>Provenance</h3>
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

        <h3>Origin</h3>
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

        <h3>Staged image</h3>
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

        <h3>Review state</h3>
        <div className="detail-grid">
          <div><span className="field-label">Review Status</span>{data.review_status}</div>
          <div><span className="field-label">Hold Reason</span>{fmtVal(data.hold_reason)}</div>
          <div><span className="field-label">Hold Note</span>{fmtVal(data.hold_note)}</div>
          <div><span className="field-label">Dedupe Outcome</span>{data.dedupe_outcome}</div>
          <div><span className="field-label">Matched Beer ID</span>{fmtVal(data.matched_beer_id)}</div>
          <div><span className="field-label">Duplicate Of Candidate ID</span>{fmtVal(data.duplicate_of_candidate_id)}</div>
        </div>
      </section>

      <section className="review-section" aria-labelledby="review-step-2">
        <ReviewStepHeader
          step={2}
          id="review-step-2"
          title="Review intent"
          helpTopic="review intent"
          helpText="A review intent records what should be imported for this candidate: a new beer with confirmed field values, or only an image for one existing catalog beer. It is saved as an audited snapshot and is separate from the candidate decision in step 4."
        />
        <DiscoveryCandidateFieldReview
          candidate={data}
          onIntentSaved={() => setIntentTick((t) => t + 1)}
        />
      </section>

      <section className="review-section" aria-labelledby="review-step-3">
        <ReviewStepHeader
          step={3}
          id="review-step-3"
          title="Image review"
          helpTopic="image decision"
          helpText="An image decision judges one server-fetched copy of the staged image. The API stores the exact bytes and records their SHA-256; approving binds to those bytes only. It never publishes or imports the image by itself."
        />
        <p className="section-intro">
          Fetch the staged image so the server stores its exact
          bytes, inspect the stored preview, then approve or reject
          it. The origin URL above is provenance text only; the
          preview below is the only image this page renders.
        </p>
        <DiscoveryImageReviewPanel
          candidate={data}
          onDecisionRecorded={reload}
          intentRefreshKey={intentTick}
        />
      </section>

      <section className="review-section" aria-labelledby="review-step-4">
        <ReviewStepHeader
          step={4}
          id="review-step-4"
          title="Candidate decision"
          helpTopic="candidate selection"
          helpText="Selecting marks this candidate as wanted for a future import manifest. It does not import anything by itself, and it is separate from the review intent (step 2) and the image decision (step 3). Hold pauses the candidate with a reason; reject closes it."
        />
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
              <label htmlFor="decision-reason">
                Reason (required for hold and reject)
              </label>
              <HelpTip topic="hold reasons">
                Hold and reject need a reason from the fixed
                vocabulary so the audit trail says why a candidate
                was paused or closed. Use "other" only with a note
                explaining it. Select and unhold do not need a reason.
              </HelpTip>
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
                className="btn btn-primary"
                disabled={busy || status !== "pending" || selectBlockedByPair}
                onClick={() => decide("select")}
              >
                Select candidate
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy || (status !== "pending" && status !== "selected")}
                onClick={() => decide("hold")}
              >
                Hold candidate
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => decide("reject")}
              >
                Reject candidate
              </button>
              <button
                type="button"
                className="btn"
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

        <h3>Decision history</h3>
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

        <h3>Duplicate pairs</h3>
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
      </section>

      <section className="review-section" aria-labelledby="review-step-5">
        <ReviewStepHeader
          step={5}
          id="review-step-5"
          title="What happens next"
        />
        <p>
          When a batch's candidates are selected, a reviewer builds
          an import manifest from them on the{" "}
          <Link to="/admin/discovery/batches">Batches page</Link>.
          The manifest freezes the selected candidates, their review
          intents, their approved image decisions, and the live
          catalog fingerprint into canonical bytes.
          <HelpTip topic="manifest hash">
            Every manifest has an exact ID and SHA-256 hash of its
            canonical bytes. Approval binds to that hash: if anything
            in the manifest or the catalog changes afterwards, the
            hash no longer matches and the manifest is stale.
          </HelpTip>
        </p>
        <p>
          Approval of the exact manifest ID and SHA-256 is a separate
          gate on the{" "}
          <Link to="/admin/discovery/manifests">Manifests page</Link>,
          restricted to the approver account. Import itself is an
          operator step
          <HelpTip topic="import">
            Importing runs outside this UI, through the operator
            executor, and only against a manifest whose exact hash
            was approved. The executor re-validates every record at
            import time and aborts if the catalog has drifted.
          </HelpTip>{" "}
          and never happens from this page. Approving an image in
          step 3 or selecting this candidate in step 4 publishes
          nothing on its own.
        </p>
      </section>
    </div>
  );
};

export default DiscoveryCandidateDetailPage;
