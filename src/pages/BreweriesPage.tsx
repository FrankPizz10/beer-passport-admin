import React, { useState } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { Brewery, ListResponse } from "../api/types";
import { DataTable } from "../components/DataTable";
import Pagination from "../components/Pagination";
import { ErrorState } from "../components/States";
import { fmtDate, fmtVal } from "../components/helpers";
import { useListControls } from "../components/useListControls";

const BreweriesPage: React.FC = () => {
  const controls = useListControls("id");
  const [q, setQ] = useState("");
  const [country, setCountry] = useState("");
  const [state, setState] = useState("");
  const params = { ...controls.params, q: q || undefined, country: country || undefined, state: state || undefined };
  const { data, loading, error, reload } = useApiData(
    () => apiGet<ListResponse<Brewery>>("/catalog/breweries", params),
    [JSON.stringify(params)]
  );
  if (error && !loading) return <ErrorState message={error.message} onRetry={reload} />;
  return (
    <div>
      <h1>Breweries</h1>
      <div className="filters">
        <input aria-label="Search breweries" placeholder="Search breweries" value={q} onChange={(e) => { setQ(e.target.value); controls.setPage(1); }} />
        <input aria-label="Country" placeholder="Country" value={country} onChange={(e) => { setCountry(e.target.value); controls.setPage(1); }} />
        <input aria-label="State" placeholder="State" value={state} onChange={(e) => { setState(e.target.value); controls.setPage(1); }} />
      </div>
      <DataTable<Brewery>
        loading={loading} rows={data?.results ?? []} sort={controls.sort} direction={controls.direction} onSortChange={controls.onSortChange}
        emptyMessage="No breweries found. The breweries table is empty in this database, or no rows match the filters."
        columns={[
          { key: "id", label: "ID", sortable: true },
          { key: "name", label: "Name", sortable: true, render: (r) => <Link to={`/admin/catalog/breweries/${r.id}`}>{r.name}</Link> },
          { key: "city", label: "City", render: (r) => fmtVal(r.city) },
          { key: "state", label: "State", render: (r) => fmtVal(r.state) },
          { key: "country", label: "Country", render: (r) => fmtVal(r.country) },
          { key: "beer_count", label: "Beers", sortable: true },
          { key: "last_mod", label: "Last Modified", sortable: true, render: (r) => fmtDate(r.last_mod) },
        ]}
      />
      {data && <Pagination page={data.pagination.page} totalPages={data.pagination.total_pages} totalResults={data.pagination.total_results} pageSize={controls.pageSize} onPageChange={controls.setPage} onPageSizeChange={controls.onPageSizeChange} />}
    </div>
  );
};

export default BreweriesPage;
