import React from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { BeerDetail } from "../api/types";
import { ErrorState, Loading } from "../components/States";
import PrivateBeerImage from "../components/PrivateBeerImage";
import { fmtBool, fmtDate, fmtVal, initialsFor } from "../components/helpers";

const BeerDetailPage: React.FC = () => {
  const { id } = useParams();
  const { data, loading, error, reload } = useApiData(
    () => apiGet<BeerDetail>(`/catalog/beers/${id}`),
    [id]
  );
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return <ErrorState message="Beer not found" onRetry={reload} />;
  const prov = data.image_provenance;
  return (
    <div>
      <h1>{data.name}</h1>
      <div className="detail-grid">
        <div><span className="field-label">ID</span>{data.id}</div>
        <div><span className="field-label">ABV</span>{fmtVal(data.abv)}</div>
        <div><span className="field-label">IBU</span>{fmtVal(data.ibu)}</div>
        <div><span className="field-label">SRM</span>{fmtVal(data.srm)}</div>
        <div><span className="field-label">UPC</span>{fmtVal(data.upc)}</div>
        <div><span className="field-label">Discontinued</span>{fmtBool(data.discontinued)}</div>
        <div><span className="field-label">Last Modified</span>{fmtDate(data.last_mod)}</div>
        <div><span className="field-label">Description</span>{fmtVal(data.descript)}</div>
        <div><span className="field-label">Brewery</span>{data.brewery ? <Link to={`/admin/catalog/breweries/${data.brewery.id}`}>{data.brewery.name}</Link> : "None"}</div>
        <div><span className="field-label">Style</span>{data.style ? <Link to={`/admin/catalog/styles/${data.style.id}`}>{data.style.name}</Link> : "None"}</div>
        <div><span className="field-label">Category</span>{data.category ? <Link to={`/admin/catalog/categories/${data.category.id}`}>{data.category.name}</Link> : "None"}</div>
        <div><span className="field-label">Users who tried it</span>{data.user_beers_count}</div>
        <div><span className="field-label">Liked count</span>{data.liked_count}</div>
      </div>

      <h2>Image</h2>
      {data.image_kind !== "initials" ? (
        <div className="image-section">
          {data.image_url ? (
            <img className="beer-image" src={data.image_url} alt={data.name} />
          ) : (
            <PrivateBeerImage beverageId={data.id} name={data.name} />
          )}
          <div className="detail-grid">
            <div><span className="field-label">Image kind</span>{data.image_kind}</div>
            <div><span className="field-label">Tier</span>{fmtVal(prov?.tier)}</div>
            <div><span className="field-label">Source type</span>{fmtVal(prov?.source_type)}</div>
            <div><span className="field-label">License type</span>{fmtVal(prov?.license_type)}</div>
            <div><span className="field-label">Attribution</span>{fmtVal(prov?.attribution)}</div>
            <div><span className="field-label">License URL</span>{prov?.license_url ? <a href={prov.license_url}>{prov.license_url}</a> : "None"}</div>
            <div><span className="field-label">Status</span>{fmtVal(prov?.status)}</div>
          </div>
        </div>
      ) : (
        <div className="image-section">
          <div className="initials-block">{initialsFor(data.name)}</div>
          <p>No approved image exists for this beer.</p>
        </div>
      )}

      <h2>Collections</h2>
      {data.collections && data.collections.length > 0 ? (
        <ul>
          {data.collections.map((c) => (
            <li key={c.id}><Link to={`/admin/catalog/collections/${c.id}`}>{c.name}</Link></li>
          ))}
        </ul>
      ) : (
        <p>This beer is not in any collection.</p>
      )}
    </div>
  );
};

export default BeerDetailPage;
