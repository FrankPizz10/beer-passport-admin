import React from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { Beer, CategoryDetail, ListResponse } from "../api/types";
import { DataTable } from "../components/DataTable";
import Pagination from "../components/Pagination";
import { ErrorState, Loading } from "../components/States";
import { fmtDate } from "../components/helpers";
import { useListControls } from "../components/useListControls";
import { categoryName } from "./CategoriesPage";

const CategoryDetailPage: React.FC = () => {
  const { id } = useParams();
  const controls = useListControls("id");
  const { data, loading, error, reload } = useApiData(
    () => apiGet<CategoryDetail>(`/catalog/categories/${id}`),
    [id]
  );
  // The category detail endpoint returns no beers and no pagination.
  // Category beers are the beers list filtered by category_id, which
  // uses the standard { results, pagination } envelope.
  const beers = useApiData(
    () => apiGet<ListResponse<Beer>>("/catalog/beers", { ...controls.params, category_id: id }),
    [id, JSON.stringify(controls.params)]
  );
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return <ErrorState message="Category not found" onRetry={reload} />;
  return (
    <div>
      <h1>{categoryName(data)}</h1>
      <div className="detail-grid">
        <div><span className="field-label">ID</span>{data.id}</div>
        <div><span className="field-label">Beer count</span>{data.beer_count}</div>
        <div><span className="field-label">Last Modified</span>{fmtDate(data.last_mod)}</div>
      </div>
      <h2>Styles</h2>
      {data.styles && data.styles.length > 0 ? (
        <ul>{data.styles.map((s) => <li key={s.id}><Link to={`/admin/catalog/styles/${s.id}`}>{s.style_name}</Link></li>)}</ul>
      ) : <p>No styles in this category.</p>}
      <h2>Beers</h2>
      {beers.error ? (
        <ErrorState message={beers.error.message} onRetry={beers.reload} />
      ) : (
        <>
          <DataTable loading={beers.loading} rows={beers.data?.results ?? []} emptyMessage="This category has no beers in this database."
            columns={[
              { key: "id", label: "ID" },
              { key: "name", label: "Name", render: (r: Beer) => <Link to={`/admin/catalog/beers/${r.id}`}>{r.name}</Link> },
            ]} />
          {beers.data && <Pagination page={beers.data.pagination.page} totalPages={beers.data.pagination.total_pages} totalResults={beers.data.pagination.total_results} pageSize={controls.pageSize} onPageChange={controls.setPage} onPageSizeChange={controls.onPageSizeChange} />}
        </>
      )}
    </div>
  );
};

export default CategoryDetailPage;
