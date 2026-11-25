import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiGet, apiPost, ApiError } from "../api/client";
import { useApiData } from "../api/useApiData";
import {
  DiscoveryBatch,
  DiscoveryManifest,
  DiscoveryManifestBlocker,
} from "../api/types";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { fmtDate, fmtVal } from "../components/helpers";
import HelpTip from "../components/HelpTip";
import StatusChip from "../components/StatusChip";

interface BatchesResponse {
  results: DiscoveryBatch[];
}

const BreakdownList: React.FC<{
  title: string;
  counts: Record<string, number>;
}> = ({ title, counts }) => {
  const entries = Object.entries(counts).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return (
    <div>
      <span className="field-label">{title}</span>
      {entries.length > 0 ? (
        <ul>
          {entries.map(([label, count]) => (
            <li key={label}>
              {label}: {count}
            </li>
          ))}
        </ul>
      ) : (
        <p>None recorded</p>
      )}
    </div>
  );
};

interface BuildFailure {
  batchId: number;
  message: string;
  blockers: DiscoveryManifestBlocker[];
}

const DiscoveryBatchesPage: React.FC = () => {
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApiData(
    () => apiGet<BatchesResponse>("/discovery/batches"),
    []
  );
  const [buildingId, setBuildingId] = useState<number | null>(null);
  const [buildFailure, setBuildFailure] = useState<BuildFailure | null>(null);
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;

  const batches = data?.results ?? [];

  // Phase 5: build a draft import manifest from the batch's selected
  // candidates. The API refuses (422) when any selected candidate is
  // not import-eligible and names every blocker; nothing is built in
  // that case. On success the manifest still needs Frank's separate
  // hash approval before the operator executor can import it.
  const buildManifest = async (batch: DiscoveryBatch) => {
    setBuildingId(batch.id);
    setBuildFailure(null);
    try {
      const manifest = await apiPost<DiscoveryManifest>(
        `/discovery/batches/${batch.id}/manifests`,
        {}
      );
      navigate(`/admin/discovery/manifests/${manifest.id}`);
    } catch (e) {
      const blockers =
        e instanceof ApiError && Array.isArray(e.details?.blockers)
          ? (e.details.blockers as DiscoveryManifestBlocker[])
          : [];
      setBuildFailure({
        batchId: batch.id,
        message:
          e instanceof Error ? e.message : "The manifest build failed.",
        blockers,
      });
    } finally {
      setBuildingId(null);
    }
  };

  return (
    <div>
      <h1>Discovery Batches</h1>
      <p className="page-lede">
        Each batch is a full staged set of candidate records from
        one source (never a sample). Reviewers work through its
        candidates, then a manifest can be built from the selected
        ones. Counts below are the batch's real totals as reported
        by the API.
      </p>
      {batches.length === 0 ? (
        <EmptyState message="No discovery batches found. No batches have been ingested yet." />
      ) : (
        <div className="queue-list">
          {batches.map((batch) => (
            <section className="queue-card" key={batch.id}>
              <div className="page-title-row">
                <h2>
                  <Link
                    to={`/admin/discovery/batches/${batch.id}/candidates`}
                  >
                    {batch.title || batch.slug}
                  </Link>
                </h2>
                <StatusChip status={batch.status} />
              </div>
              <div className="detail-grid">
                <div>
                  <span className="field-label">Source</span>
                  {batch.source}
                </div>
                <div>
                  <span className="field-label">Source Summary</span>
                  {fmtVal(batch.source_summary)}
                </div>
                <div>
                  <span className="field-label">Record Count</span>
                  {batch.record_count}
                </div>
                <div>
                  <span className="field-label">Ingested</span>
                  {fmtDate(batch.ingested_at)}
                </div>
              </div>
              <div className="batch-progress">
                <div className="progress-label">
                  <span>Review progress</span>
                  <span>
                    {batch.review_progress.decided}/
                    {batch.review_progress.total} reviewed (
                    {batch.review_progress.percent_reviewed}%)
                  </span>
                </div>
                <div
                  className="progress-track"
                  role="progressbar"
                  aria-label={`Review progress for ${batch.title || batch.slug}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={batch.review_progress.percent_reviewed}
                >
                  <div
                    className="progress-fill"
                    style={{
                      width: `${batch.review_progress.percent_reviewed}%`,
                    }}
                  />
                </div>
                <div className="chip-row">
                  {Object.entries(batch.counts.by_review_status)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([status, count]) => (
                      <StatusChip
                        key={status}
                        status={status}
                        label={`${status}: ${count}`}
                      />
                    ))}
                </div>
              </div>
              <div className="detail-grid">
                <BreakdownList
                  title="Origin Buckets"
                  counts={batch.counts.by_origin_bucket}
                />
                <BreakdownList
                  title="Image Statuses"
                  counts={batch.counts.by_image_status}
                />
                <BreakdownList
                  title="Hold Reasons"
                  counts={batch.counts.by_hold_reason}
                />
              </div>
              <p>
                <Link
                  to={`/admin/discovery/review-queue?batch=${batch.id}`}
                >
                  Open review queue
                </Link>{" "}
                |{" "}
                <Link
                  to={`/admin/discovery/batches/${batch.id}/candidates`}
                >
                  View candidates
                </Link>{" "}
                |{" "}
                <Link
                  to={`/admin/discovery/batches/${batch.id}/decisions`}
                >
                  Decision audit
                </Link>
              </p>
              <p>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => buildManifest(batch)}
                  disabled={buildingId !== null}
                >
                  {buildingId === batch.id
                    ? "Building manifest..."
                    : "Build import manifest"}
                </button>
                <HelpTip topic="manifest hash">
                  Building freezes this batch's selected candidates,
                  their review intents, and their approved image
                  decisions into a manifest with an exact ID and
                  SHA-256 hash. The manifest still needs separate
                  hash approval before the operator can import it;
                  building alone imports nothing.
                </HelpTip>
              </p>
              {buildFailure && buildFailure.batchId === batch.id ? (
                <div className="queue-preview-failed" role="alert">
                  <p>{buildFailure.message}</p>
                  {buildFailure.blockers.length > 0 ? (
                    <ul>
                      {buildFailure.blockers.map((blocker) => (
                        <li key={blocker.candidate_id}>
                          {blocker.candidate_key} (candidate{" "}
                          {blocker.candidate_id}):{" "}
                          {blocker.reasons.join(", ")}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </div>
  );
};

export default DiscoveryBatchesPage;
