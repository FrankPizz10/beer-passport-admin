import React from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { DiscoveryBatch } from "../api/types";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { fmtDate, fmtVal } from "../components/helpers";

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

const DiscoveryBatchesPage: React.FC = () => {
  const { data, loading, error, reload } = useApiData(
    () => apiGet<BatchesResponse>("/discovery/batches"),
    []
  );
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;

  const batches = data?.results ?? [];

  return (
    <div>
      <h1>Discovery Batches</h1>
      {batches.length === 0 ? (
        <EmptyState message="No discovery batches found. No batches have been ingested yet." />
      ) : (
        <div className="queue-list">
          {batches.map((batch) => (
            <section className="queue-card" key={batch.id}>
              <h2>
                <Link
                  to={`/admin/discovery/batches/${batch.id}/candidates`}
                >
                  {batch.title || batch.slug}
                </Link>
              </h2>
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
                  <span className="field-label">Status</span>
                  {batch.status}
                </div>
                <div>
                  <span className="field-label">Ingested</span>
                  {fmtDate(batch.ingested_at)}
                </div>
                <div>
                  <span className="field-label">Review Progress</span>
                  {batch.review_progress.decided}/
                  {batch.review_progress.total} reviewed (
                  {batch.review_progress.percent_reviewed}%)
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
                <BreakdownList
                  title="Review Statuses"
                  counts={batch.counts.by_review_status}
                />
              </div>
              <p>
                <Link
                  to={`/admin/discovery/batches/${batch.id}/candidates`}
                >
                  View candidates
                </Link>
              </p>
            </section>
          ))}
        </div>
      )}
    </div>
  );
};

export default DiscoveryBatchesPage;
