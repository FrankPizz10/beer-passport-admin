import React from "react";
import { Link } from "react-router-dom";
import {
  DiscoveryReviewClient,
  httpDiscoveryReviewClient,
} from "../api/discoveryReview";
import { useApiData } from "../api/useApiData";
import { DiscoveryCandidateDetail } from "../api/types";
import { ErrorState, Loading } from "./States";
import { fmtVal } from "./helpers";

// Existing catalog beer panel: shown when a staged candidate matched
// a beer that is ALREADY in the catalog (matched_beer_id set). Its
// job is to make the target beer unmistakable before the reviewer
// decides on the candidate's image: the image decision below would
// attach an image to THAT beer, and to nothing else. It creates and
// changes no beer. The beer name is resolved through the existing
// catalog endpoint (GET /catalog/beers/:id); the candidate API
// exposes only the id.
//
// Gate copy lives here persistently: an image decision is not an
// import, and for image-only records the import path itself is
// pending the Codex contract (docs/DISCOVERY_REVIEW_API_CONTRACT.md
// section B2), so nothing in this panel may read as publication.

const DiscoveryExistingBeerPanel: React.FC<{
  candidate: DiscoveryCandidateDetail;
  client?: DiscoveryReviewClient;
}> = ({ candidate, client = httpDiscoveryReviewClient }) => {
  const beerId = candidate.matched_beer_id;
  const { data: beer, loading, error, reload } = useApiData(
    () =>
      beerId !== null && beerId !== undefined
        ? client.getCatalogBeer(beerId)
        : Promise.resolve(null),
    [beerId]
  );

  if (beerId === null || beerId === undefined) return null;

  return (
    <section className="existing-beer-panel" aria-labelledby="existing-beer-heading">
      <h3 id="existing-beer-heading">Existing catalog beer</h3>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState
          message={`The matched catalog beer could not be loaded: ${error.message}`}
          onRetry={reload}
        />
      ) : (
        <p>
          This candidate matched existing catalog beer{" "}
          <strong>
            #{beerId}
            {beer ? ` - ${beer.name}` : ""}
          </strong>
          {beer?.brewery ? ` (${beer.brewery.name})` : ""}.{" "}
          <Link to={`/admin/catalog/beers/${beerId}`}>
            Open catalog beer #{beerId}
          </Link>
        </p>
      )}
      <div className="detail-grid">
        <div>
          <span className="field-label">Image provenance (source)</span>
          {fmtVal(candidate.image_source)}
        </div>
        <div>
          <span className="field-label">Staged source</span>
          {candidate.source}
        </div>
        <div>
          <span className="field-label">Origin URL (text only)</span>
          {candidate.image_url ? (
            <span className="provenance-text">{candidate.image_url}</span>
          ) : (
            "None"
          )}
        </div>
        <div>
          <span className="field-label">License</span>
          {fmtVal(candidate.image_license)}
        </div>
      </div>
      <p className="gate-note">
        Approving the image below records an image decision for
        catalog beer #{beerId} only. It does not create or change a
        beer, and it does not publish anything: import is a separate,
        hash-gated step, and the image-only import path is pending
        backend support (contract section B2).
      </p>
    </section>
  );
};

export default DiscoveryExistingBeerPanel;
