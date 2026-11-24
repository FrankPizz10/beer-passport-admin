import React from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { DiscoveryCandidateDetail } from "../api/types";
import { ErrorState, Loading } from "../components/States";
import { fmtBool, fmtDate, fmtVal } from "../components/helpers";

const DiscoveryCandidateDetailPage: React.FC = () => {
  const { id } = useParams();
  const { data, loading, error, reload } = useApiData(
    () => apiGet<DiscoveryCandidateDetail>(`/discovery/candidates/${id}`),
    [id]
  );
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data)
    return <ErrorState message="Discovery candidate not found" onRetry={reload} />;

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

      <h2>Review State</h2>
      <div className="detail-grid">
        <div><span className="field-label">Review Status</span>{data.review_status}</div>
        <div><span className="field-label">Hold Reason</span>{fmtVal(data.hold_reason)}</div>
        <div><span className="field-label">Hold Note</span>{fmtVal(data.hold_note)}</div>
        <div><span className="field-label">Dedupe Outcome</span>{data.dedupe_outcome}</div>
        <div><span className="field-label">Matched Beer ID</span>{fmtVal(data.matched_beer_id)}</div>
        <div><span className="field-label">Duplicate Of Candidate ID</span>{fmtVal(data.duplicate_of_candidate_id)}</div>
      </div>

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
              )}
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
