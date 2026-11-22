import React from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { BreweryDetail } from "../api/types";
import { DataTable } from "../components/DataTable";
import Pagination from "../components/Pagination";
import { ErrorState, Loading } from "../components/States";
import { fmtDate, fmtVal } from "../components/helpers";
import { useListControls } from "../components/useListControls";

const BreweryDetailPage: React.FC = () => {
  const { id } = useParams();
  const controls = useListControls("id");
  const { data, loading, error, reload } = useApiData(
    () => apiGet<BreweryDetail>(`/catalog/breweries/${id}`, controls.params),
    [id, JSON.stringify(controls.params)]
  );
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return <ErrorState message="Brewery not found" onRetry={reload} />;
  return (
    <div>
      <h1>{data.name}</h1>
      <div className="detail-grid">
        <div><span className="field-label">ID</span>{data.id}</div>
        <div><span className="field-label">Address 1</span>{fmtVal(data.address1)}</div>
        <div><span className="field-label">Address 2</span>{fmtVal(data.address2)}</div>
        <div><span className="field-label">City</span>{fmtVal(data.city)}</div>
        <div><span className="field-label">State</span>{fmtVal(data.state)}</div>
        <div><span className="field-label">Code</span>{fmtVal(data.code)}</div>
        <div><span className="field-label">Country</span>{fmtVal(data.country)}</div>
        <div><span className="field-label">Phone</span>{fmtVal(data.phone)}</div>
        <div><span className="field-label">Website</span>{data.website ? <a href={data.website}>{data.website}</a> : "None"}</div>
        <div><span className="field-label">Description</span>{fmtVal(data.descript)}</div>
        <div><span className="field-label">Added by user ID</span>{fmtVal(data.add_user)}</div>
        <div><span className="field-label">Beer count</span>{data.beer_count}</div>
        <div><span className="field-label">Last Modified</span>{fmtDate(data.last_mod)}</div>
      </div>
      {data.geocode && (
        <>
          <h2>Geocode</h2>
          <div className="detail-grid">
            <div><span className="field-label">Latitude</span>{data.geocode.latitude}</div>
            <div><span className="field-label">Longitude</span>{data.geocode.longitude}</div>
            <div><span className="field-label">Accuracy</span>{data.geocode.accuracy}</div>
          </div>
        </>
      )}
      <h2>Beers</h2>
      <DataTable
        rows={data.beers?.results ?? []}
        emptyMessage="This brewery has no beers in this database."
        columns={[
          { key: "id", label: "ID" },
          { key: "name", label: "Name", render: (r: any) => <Link to={`/admin/catalog/beers/${r.id}`}>{r.name}</Link> },
          { key: "abv", label: "ABV", render: (r: any) => r.abv ?? "None" },
        ]}
      />
      {data.beers && <Pagination page={data.beers.pagination.page} totalPages={data.beers.pagination.total_pages} totalResults={data.beers.pagination.total_results} pageSize={controls.pageSize} onPageChange={controls.setPage} onPageSizeChange={controls.onPageSizeChange} />}
    </div>
  );
};

export default BreweryDetailPage;
