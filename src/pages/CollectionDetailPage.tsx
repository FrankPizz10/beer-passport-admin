import React from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { CollectionDetail } from "../api/types";
import { DataTable } from "../components/DataTable";
import Pagination from "../components/Pagination";
import { ErrorState, Loading } from "../components/States";
import { fmtVal } from "../components/helpers";
import { useListControls } from "../components/useListControls";

const CollectionDetailPage: React.FC = () => {
  const { id } = useParams();
  const controls = useListControls("id");
  const { data, loading, error, reload } = useApiData(
    () => apiGet<CollectionDetail>(`/catalog/collections/${id}`, controls.params),
    [id, JSON.stringify(controls.params)]
  );
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return <ErrorState message="Collection not found" onRetry={reload} />;
  const members: any = data.beers || data.collection_beers;
  const rows = (members?.results ?? []).map((row: any) =>
    row.beer ? { id: row.id, beer_id: row.beer.id, name: row.beer.name } : row
  );
  return (
    <div>
      <h1>{data.name}</h1>
      <div className="detail-grid">
        <div><span className="field-label">ID</span>{data.id}</div>
        <div><span className="field-label">Difficulty</span>{fmtVal(data.difficulty)}</div>
        <div><span className="field-label">Description</span>{fmtVal(data.description)}</div>
        <div><span className="field-label">Badge holders</span>{data.badge_holder_count}</div>
      </div>
      <h2>Member Beers</h2>
      <DataTable rows={rows} emptyMessage="This collection has no member beers in this database."
        columns={[
          { key: "id", label: "Row ID" },
          { key: "name", label: "Beer", render: (r: any) => <Link to={`/admin/catalog/beers/${r.beer_id ?? r.id}`}>{r.name}</Link> },
        ]} />
      {members && <Pagination page={members.pagination.page} totalPages={members.pagination.total_pages} totalResults={members.pagination.total_results} pageSize={controls.pageSize} onPageChange={controls.setPage} onPageSizeChange={controls.onPageSizeChange} />}
    </div>
  );
};

export default CollectionDetailPage;
