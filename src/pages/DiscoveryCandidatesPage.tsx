import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { DiscoveryCandidate, ListResponse } from "../api/types";
import { DataTable } from "../components/DataTable";
import Pagination from "../components/Pagination";
import StatusChip from "../components/StatusChip";
import { ErrorState } from "../components/States";
import { fmtVal } from "../components/helpers";
import { useListControls } from "../components/useListControls";

const DiscoveryCandidatesPage: React.FC = () => {
  const { batchId } = useParams();
  const controls = useListControls("name");
  const [q, setQ] = useState("");
  const [originBucket, setOriginBucket] = useState("");
  const [imageStatus, setImageStatus] = useState("");
  const [holdReason, setHoldReason] = useState("");
  const [reviewStatus, setReviewStatus] = useState("");
  const [source, setSource] = useState("");

  const params = {
    ...controls.params,
    q: q || undefined,
    origin_bucket: originBucket || undefined,
    image_status: imageStatus || undefined,
    hold_reason: holdReason || undefined,
    review_status: reviewStatus || undefined,
    source: source || undefined,
  };
  const { data, loading, error, reload } = useApiData(
    () =>
      apiGet<ListResponse<DiscoveryCandidate>>(
        `/discovery/batches/${batchId}/candidates`,
        params
      ),
    [batchId, JSON.stringify(params)]
  );

  if (error && !loading)
    return <ErrorState message={error.message} onRetry={reload} />;

  return (
    <div>
      <h1>Discovery Candidates</h1>
      <p>
        <Link to="/admin/discovery/batches">Back to Discovery Batches</Link>
      </p>
      <div className="filters">
        <label className="visually-hidden" htmlFor="discovery-filter-q">Search candidates</label>
        <input
          id="discovery-filter-q"
          aria-label="Search candidates"
          placeholder="Search candidates"
          value={q}
          onChange={(e) => { setQ(e.target.value); controls.setPage(1); }}
        />
        <label className="visually-hidden" htmlFor="discovery-filter-origin-bucket">Origin bucket</label>
        <select id="discovery-filter-origin-bucket" aria-label="Origin bucket" value={originBucket}
          onChange={(e) => { setOriginBucket(e.target.value); controls.setPage(1); }}>
          <option value="">Any origin</option>
          <option value="us_produced">us_produced</option>
          <option value="us_market">us_market</option>
          <option value="uncertain">uncertain</option>
        </select>
        <label className="visually-hidden" htmlFor="discovery-filter-image-status">Image status</label>
        <select id="discovery-filter-image-status" aria-label="Image status" value={imageStatus}
          onChange={(e) => { setImageStatus(e.target.value); controls.setPage(1); }}>
          <option value="">Any image status</option>
          <option value="verified">verified</option>
          <option value="gate_passed_unverified">gate_passed_unverified</option>
          <option value="failed">failed</option>
          <option value="none">none</option>
          <option value="not_staged">not_staged</option>
        </select>
        <label className="visually-hidden" htmlFor="discovery-filter-hold-reason">Hold reason</label>
        <select id="discovery-filter-hold-reason" aria-label="Hold reason" value={holdReason}
          onChange={(e) => { setHoldReason(e.target.value); controls.setPage(1); }}>
          <option value="">Any hold reason</option>
          <option value="missing_brewery">missing_brewery</option>
          <option value="origin_uncertain">origin_uncertain</option>
          <option value="market_fit_uncertain">market_fit_uncertain</option>
          <option value="duplicate_unresolved">duplicate_unresolved</option>
          <option value="image_unverified">image_unverified</option>
          <option value="metadata_incomplete">metadata_incomplete</option>
          <option value="out_of_scope">out_of_scope</option>
          <option value="other">other</option>
          <option value="none">none</option>
        </select>
        <label className="visually-hidden" htmlFor="discovery-filter-review-status">Review status</label>
        <select id="discovery-filter-review-status" aria-label="Review status" value={reviewStatus}
          onChange={(e) => { setReviewStatus(e.target.value); controls.setPage(1); }}>
          <option value="">Any review status</option>
          <option value="pending">pending</option>
        </select>
        <label className="visually-hidden" htmlFor="discovery-filter-source">Source</label>
        <input id="discovery-filter-source" aria-label="Source" placeholder="Source" value={source}
          onChange={(e) => { setSource(e.target.value); controls.setPage(1); }} />
      </div>
      <DataTable<DiscoveryCandidate>
        loading={loading}
        rows={data?.results ?? []}
        sort={controls.sort}
        direction={controls.direction}
        onSortChange={controls.onSortChange}
        emptyMessage="No discovery candidates found. This batch has no candidates, or no rows match the filters."
        columns={[
          { key: "name", label: "Name", sortable: true, render: (r) => <Link to={`/admin/discovery/candidates/${r.id}`}>{r.name}</Link> },
          { key: "brewery_name", label: "Brewery", sortable: true, render: (r) => fmtVal(r.brewery_name) },
          { key: "style", label: "Style", render: (r) => fmtVal(r.style) },
          { key: "abv", label: "ABV", sortable: true, render: (r) => r.abv ?? "None" },
          { key: "origin_bucket", label: "Origin", render: (r) => fmtVal(r.origin_bucket) },
          { key: "image_status_normalized", label: "Image Status", render: (r) => fmtVal(r.image_status_normalized) },
          { key: "hold_reason", label: "Hold Reason", render: (r) => r.hold_reason ? <span className="status-chip status-chip--neutral">{r.hold_reason}</span> : fmtVal(r.hold_reason) },
          { key: "review_status", label: "Review Status", render: (r) => <StatusChip status={r.review_status} /> },
        ]}
      />
      {data && (
        <Pagination page={data.pagination.page} totalPages={data.pagination.total_pages}
          totalResults={data.pagination.total_results} pageSize={controls.pageSize}
          onPageChange={controls.setPage} onPageSizeChange={controls.onPageSizeChange} />
      )}
    </div>
  );
};

export default DiscoveryCandidatesPage;
