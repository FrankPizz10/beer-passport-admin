import React, { useState } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { ListResponse, Style } from "../api/types";
import { DataTable } from "../components/DataTable";
import Pagination from "../components/Pagination";
import { ErrorState } from "../components/States";
import { fmtDate, fmtVal } from "../components/helpers";
import { useListControls } from "../components/useListControls";

export const styleName = (s: Style) => s.style_name || s.name || "";

const StylesPage: React.FC = () => {
  const controls = useListControls("id");
  const [q, setQ] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const params = { ...controls.params, q: q || undefined, category_id: categoryId || undefined };
  const { data, loading, error, reload } = useApiData(
    () => apiGet<ListResponse<Style>>("/catalog/styles", params),
    [JSON.stringify(params)]
  );
  if (error && !loading) return <ErrorState message={error.message} onRetry={reload} />;
  return (
    <div>
      <h1>Styles</h1>
      <div className="filters">
        <input aria-label="Search styles" placeholder="Search styles" value={q} onChange={(e) => { setQ(e.target.value); controls.setPage(1); }} />
        <input aria-label="Category ID" placeholder="Category ID" value={categoryId} onChange={(e) => { setCategoryId(e.target.value); controls.setPage(1); }} />
      </div>
      <DataTable<Style>
        loading={loading} rows={data?.results ?? []} sort={controls.sort} direction={controls.direction} onSortChange={controls.onSortChange}
        emptyMessage="No styles found. The styles table is empty in this database, or no rows match the filters."
        columns={[
          { key: "id", label: "ID", sortable: true },
          { key: "style_name", label: "Name", sortable: true, render: (r) => <Link to={`/admin/catalog/styles/${r.id}`}>{styleName(r)}</Link> },
          { key: "category", label: "Category", render: (r) => r.category ? <Link to={`/admin/catalog/categories/${r.category.id}`}>{r.category.name}</Link> : "None" },
          { key: "beer_count", label: "Beers", render: (r) => fmtVal(r.beer_count) },
          { key: "last_mod", label: "Last Modified", sortable: true, render: (r) => fmtDate(r.last_mod) },
        ]}
      />
      {data && <Pagination page={data.pagination.page} totalPages={data.pagination.total_pages} totalResults={data.pagination.total_results} pageSize={controls.pageSize} onPageChange={controls.setPage} onPageSizeChange={controls.onPageSizeChange} />}
    </div>
  );
};

export default StylesPage;
