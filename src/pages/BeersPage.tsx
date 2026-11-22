import React, { useState } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { Beer, ListResponse } from "../api/types";
import { DataTable } from "../components/DataTable";
import Pagination from "../components/Pagination";
import { ErrorState } from "../components/States";
import { fmtBool, fmtDate } from "../components/helpers";
import { useListControls } from "../components/useListControls";

const BeersPage: React.FC = () => {
  const controls = useListControls("id");
  const [q, setQ] = useState("");
  const [breweryId, setBreweryId] = useState("");
  const [styleId, setStyleId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [discontinued, setDiscontinued] = useState("");

  const params = {
    ...controls.params,
    q: q || undefined,
    brewery_id: breweryId || undefined,
    style_id: styleId || undefined,
    category_id: categoryId || undefined,
    discontinued: discontinued === "" ? undefined : discontinued,
  };
  const { data, loading, error, reload } = useApiData(
    () => apiGet<ListResponse<Beer>>("/catalog/beers", params),
    [JSON.stringify(params)]
  );

  if (error && !loading)
    return <ErrorState message={error.message} onRetry={reload} />;

  return (
    <div>
      <h1>Beers</h1>
      <div className="filters">
        <input
          aria-label="Search beers"
          placeholder="Search beers"
          value={q}
          onChange={(e) => { setQ(e.target.value); controls.setPage(1); }}
        />
        <input aria-label="Brewery ID" placeholder="Brewery ID" value={breweryId}
          onChange={(e) => { setBreweryId(e.target.value); controls.setPage(1); }} />
        <input aria-label="Style ID" placeholder="Style ID" value={styleId}
          onChange={(e) => { setStyleId(e.target.value); controls.setPage(1); }} />
        <input aria-label="Category ID" placeholder="Category ID" value={categoryId}
          onChange={(e) => { setCategoryId(e.target.value); controls.setPage(1); }} />
        <select aria-label="Discontinued" value={discontinued}
          onChange={(e) => { setDiscontinued(e.target.value); controls.setPage(1); }}>
          <option value="">Any status</option>
          <option value="true">Discontinued</option>
          <option value="false">Active</option>
        </select>
      </div>
      <DataTable<Beer>
        loading={loading}
        rows={data?.results ?? []}
        sort={controls.sort}
        direction={controls.direction}
        onSortChange={controls.onSortChange}
        emptyMessage="No beers found. The beers table is empty in this database, or no rows match the filters."
        columns={[
          { key: "id", label: "ID", sortable: true },
          { key: "name", label: "Name", sortable: true, render: (r) => <Link to={`/admin/catalog/beers/${r.id}`}>{r.name}</Link> },
          { key: "brewery", label: "Brewery", render: (r) => r.brewery ? <Link to={`/admin/catalog/breweries/${r.brewery.id}`}>{r.brewery.name}</Link> : "None" },
          { key: "style", label: "Style", render: (r) => r.style ? <Link to={`/admin/catalog/styles/${r.style.id}`}>{r.style.name}</Link> : "None" },
          { key: "category", label: "Category", render: (r) => r.category ? <Link to={`/admin/catalog/categories/${r.category.id}`}>{r.category.name}</Link> : "None" },
          { key: "abv", label: "ABV", sortable: true, render: (r) => r.abv ?? "None" },
          { key: "discontinued", label: "Discontinued", render: (r) => fmtBool(r.discontinued) },
          { key: "last_mod", label: "Last Modified", sortable: true, render: (r) => fmtDate(r.last_mod) },
          { key: "image_kind", label: "Image", render: (r) => r.image_kind },
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

export default BeersPage;
