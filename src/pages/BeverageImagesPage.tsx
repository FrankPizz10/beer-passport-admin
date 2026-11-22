import React, { useState } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { BeverageImage, ListResponse } from "../api/types";
import { DataTable } from "../components/DataTable";
import Pagination from "../components/Pagination";
import { ErrorState } from "../components/States";
import { fmtDate, fmtVal } from "../components/helpers";
import { useListControls } from "../components/useListControls";

const BeverageImagesPage: React.FC = () => {
  const controls = useListControls("id");
  const [beverageId, setBeverageId] = useState("");
  const [status, setStatus] = useState("");
  const params = { ...controls.params, beverage_id: beverageId || undefined, status: status || undefined };
  const { data, loading, error, reload } = useApiData(
    () => apiGet<ListResponse<BeverageImage>>("/catalog/beverage-images", params),
    [JSON.stringify(params)]
  );
  if (error && !loading) return <ErrorState message={error.message} onRetry={reload} />;
  return (
    <div>
      <h1>Beverage Images</h1>
      <div className="filters">
        <input aria-label="Beverage ID" placeholder="Beverage (beer) ID" value={beverageId} onChange={(e) => { setBeverageId(e.target.value); controls.setPage(1); }} />
        <select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); controls.setPage(1); }}>
          <option value="">Any status</option>
          <option value="approved">Approved</option>
          <option value="pending">Pending</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>
      <DataTable<BeverageImage>
        loading={loading} rows={data?.results ?? []} sort={controls.sort} direction={controls.direction} onSortChange={controls.onSortChange}
        emptyMessage="No beverage images found. The beverage_images table is empty in this database, or no rows match the filters."
        columns={[
          { key: "id", label: "ID", sortable: true },
          { key: "beverage_id", label: "Beer", render: (r) => <Link to={`/admin/catalog/beers/${r.beverage_id}`}>{r.beer?.name || r.beverage_id}</Link> },
          { key: "status", label: "Status" },
          { key: "source_type", label: "Source Type", render: (r) => fmtVal(r.source_type) },
          { key: "source_url", label: "Source URL", render: (r) => fmtVal(r.source_url) },
          { key: "license_type", label: "License", render: (r) => fmtVal(r.license_type) },
          { key: "attribution", label: "Attribution", render: (r) => fmtVal(r.attribution) },
          { key: "license_url", label: "License URL", render: (r) => r.license_url ? <a href={r.license_url}>{r.license_url}</a> : "None" },
          { key: "created_at", label: "Created", sortable: true, render: (r) => fmtDate(r.created_at) },
        ]}
      />
      {data && <Pagination page={data.pagination.page} totalPages={data.pagination.total_pages} totalResults={data.pagination.total_results} pageSize={controls.pageSize} onPageChange={controls.setPage} onPageSizeChange={controls.onPageSizeChange} />}
    </div>
  );
};

export default BeverageImagesPage;
