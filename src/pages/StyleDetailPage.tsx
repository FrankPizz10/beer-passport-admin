import React from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { StyleDetail } from "../api/types";
import { DataTable } from "../components/DataTable";
import Pagination from "../components/Pagination";
import { ErrorState, Loading } from "../components/States";
import { fmtDate } from "../components/helpers";
import { useListControls } from "../components/useListControls";
import { styleName } from "./StylesPage";

const StyleDetailPage: React.FC = () => {
  const { id } = useParams();
  const controls = useListControls("id");
  const { data, loading, error, reload } = useApiData(
    () => apiGet<StyleDetail>(`/catalog/styles/${id}`, controls.params),
    [id, JSON.stringify(controls.params)]
  );
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return <ErrorState message="Style not found" onRetry={reload} />;
  return (
    <div>
      <h1>{styleName(data)}</h1>
      <div className="detail-grid">
        <div><span className="field-label">ID</span>{data.id}</div>
        <div><span className="field-label">Category</span>{data.category ? <Link to={`/admin/catalog/categories/${data.category.id}`}>{data.category.name}</Link> : "None"}</div>
        <div><span className="field-label">Beer count</span>{data.beer_count}</div>
        <div><span className="field-label">Last Modified</span>{fmtDate(data.last_mod)}</div>
      </div>
      <h2>Beers</h2>
      <DataTable rows={data.beers?.results ?? []} emptyMessage="This style has no beers in this database."
        columns={[
          { key: "id", label: "ID" },
          { key: "name", label: "Name", render: (r: any) => <Link to={`/admin/catalog/beers/${r.id}`}>{r.name}</Link> },
        ]} />
      {data.beers && <Pagination page={data.beers.pagination.page} totalPages={data.beers.pagination.total_pages} totalResults={data.beers.pagination.total_results} pageSize={controls.pageSize} onPageChange={controls.setPage} onPageSizeChange={controls.onPageSizeChange} />}
    </div>
  );
};

export default StyleDetailPage;
