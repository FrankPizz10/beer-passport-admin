import React, { useState } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { Collection, ListResponse } from "../api/types";
import { DataTable } from "../components/DataTable";
import Pagination from "../components/Pagination";
import { ErrorState } from "../components/States";
import { fmtVal } from "../components/helpers";
import { useListControls } from "../components/useListControls";

const CollectionsPage: React.FC = () => {
  const controls = useListControls("id");
  const [q, setQ] = useState("");
  const params = { ...controls.params, q: q || undefined };
  const { data, loading, error, reload } = useApiData(
    () => apiGet<ListResponse<Collection>>("/catalog/collections", params),
    [JSON.stringify(params)]
  );
  if (error && !loading) return <ErrorState message={error.message} onRetry={reload} />;
  return (
    <div>
      <h1>Collections</h1>
      <div className="filters">
        <input aria-label="Search collections" placeholder="Search collections" value={q} onChange={(e) => { setQ(e.target.value); controls.setPage(1); }} />
      </div>
      <DataTable<Collection>
        loading={loading} rows={data?.results ?? []} sort={controls.sort} direction={controls.direction} onSortChange={controls.onSortChange}
        emptyMessage="No collections found. The collections table is empty in this database, or no rows match the filters."
        columns={[
          { key: "id", label: "ID", sortable: true },
          { key: "name", label: "Name", sortable: true, render: (r) => <Link to={`/admin/catalog/collections/${r.id}`}>{r.name}</Link> },
          { key: "difficulty", label: "Difficulty", render: (r) => fmtVal(r.difficulty) },
          { key: "description", label: "Description", render: (r) => fmtVal(r.description) },
          { key: "beer_count", label: "Member Beers", render: (r) => fmtVal(r.beer_count ?? r.member_count) },
          { key: "badge_holder_count", label: "Badge Holders", render: (r) => fmtVal(r.badge_holder_count) },
        ]}
      />
      {data && <Pagination page={data.pagination.page} totalPages={data.pagination.total_pages} totalResults={data.pagination.total_results} pageSize={controls.pageSize} onPageChange={controls.setPage} onPageSizeChange={controls.onPageSizeChange} />}
    </div>
  );
};

export default CollectionsPage;
