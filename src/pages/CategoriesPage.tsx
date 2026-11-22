import React, { useState } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { Category, ListResponse } from "../api/types";
import { DataTable } from "../components/DataTable";
import Pagination from "../components/Pagination";
import { ErrorState } from "../components/States";
import { fmtDate, fmtVal } from "../components/helpers";
import { useListControls } from "../components/useListControls";

export const categoryName = (c: Category) => c.cat_name || c.name || "";

const CategoriesPage: React.FC = () => {
  const controls = useListControls("id");
  const [q, setQ] = useState("");
  const params = { ...controls.params, q: q || undefined };
  const { data, loading, error, reload } = useApiData(
    () => apiGet<ListResponse<Category>>("/catalog/categories", params),
    [JSON.stringify(params)]
  );
  if (error && !loading) return <ErrorState message={error.message} onRetry={reload} />;
  return (
    <div>
      <h1>Categories</h1>
      <div className="filters">
        <input aria-label="Search categories" placeholder="Search categories" value={q} onChange={(e) => { setQ(e.target.value); controls.setPage(1); }} />
      </div>
      <DataTable<Category>
        loading={loading} rows={data?.results ?? []} sort={controls.sort} direction={controls.direction} onSortChange={controls.onSortChange}
        emptyMessage="No categories found. The categories table is empty in this database, or no rows match the filters."
        columns={[
          { key: "id", label: "ID", sortable: true },
          { key: "cat_name", label: "Name", sortable: true, render: (r) => <Link to={`/admin/catalog/categories/${r.id}`}>{categoryName(r)}</Link> },
          { key: "beer_count", label: "Beers", render: (r) => fmtVal(r.beer_count) },
          { key: "style_count", label: "Styles", render: (r) => fmtVal(r.style_count) },
          { key: "last_mod", label: "Last Modified", sortable: true, render: (r) => fmtDate(r.last_mod) },
        ]}
      />
      {data && <Pagination page={data.pagination.page} totalPages={data.pagination.total_pages} totalResults={data.pagination.total_results} pageSize={controls.pageSize} onPageChange={controls.setPage} onPageSizeChange={controls.onPageSizeChange} />}
    </div>
  );
};

export default CategoriesPage;
