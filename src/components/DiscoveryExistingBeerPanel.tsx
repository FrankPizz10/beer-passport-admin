import React from "react";
import { Link } from "react-router-dom";
import {
  DiscoveryReviewClient,
  ReviewIntentRecord,
  httpDiscoveryReviewClient,
} from "../api/discoveryReview";
import { useApiData } from "../api/useApiData";
import { DiscoveryCandidateDetail } from "../api/types";
import { ErrorState, Loading } from "./States";
import { fmtVal } from "./helpers";

// Existing catalog beer panel: shown when the reviewer has SAVED an
// image-only review intent for this candidate (contract section
// B1). The target beer comes from that intent - the beer the
// reviewer explicitly searched for, picked, and confirmed - never
// from the staging collision detector: matched_beer_id is staging
// information only and does not create or imply an image-only
// intent. The panel's job is to make the target beer unmistakable
// before the reviewer decides on the candidate's image: the image
// decision below would attach an image to THAT beer, and to nothing
// else. It creates and changes no beer. The beer's name is resolved
// through the existing catalog endpoint (GET /catalog/beers/:id).
//
// Gate copy lives here persistently: an image decision is not an
// import. For image-only records the import path runs through
// version 2 manifest entries (contract section B2): the image
// reaches the catalog only when a manifest containing the entry is
// approved by its exact hash and imported by the operator, so
// nothing in this panel may read as publication.

const asIntentRecord = (data: unknown): ReviewIntentRecord | null => {
  if (!data || typeof data !== "object") return null;
  const record = data as ReviewIntentRecord;
  if (typeof record.id !== "number" || !record.intent) return null;
  if (
    record.intent.mode !== "new_beer" &&
    record.intent.mode !== "image_only"
  ) {
    return null;
  }
  return record;
};

const DiscoveryExistingBeerPanel: React.FC<{
  candidate: DiscoveryCandidateDetail;
  client?: DiscoveryReviewClient;
  // Bumped by the candidate page after an intent save elsewhere on
  // the page, so this panel re-reads the saved intent.
  intentRefreshKey?: number;
}> = ({ candidate, client = httpDiscoveryReviewClient, intentRefreshKey = 0 }) => {
  const {
    data: intentData,
    loading: intentLoading,
    error: intentError,
    reload: reloadIntent,
  } = useApiData(
    () => client.getReviewIntent(candidate.id),
    [candidate.id, intentRefreshKey]
  );
  const record = asIntentRecord(intentData);
  const targetBeerId =
    record?.intent.mode === "image_only" ? record.intent.target_beer_id : null;

  const { data: beer, loading, error, reload } = useApiData(
    () =>
      targetBeerId !== null
        ? client.getCatalogBeer(targetBeerId)
        : Promise.resolve(null),
    [targetBeerId]
  );

  // While the intent loads, and whenever there is no saved
  // image-only intent, there is no panel. (A detector match alone
  // never produces this panel.)
  if (intentLoading) return null;
  if (!intentError && targetBeerId === null) return null;

  return (
    <section className="existing-beer-panel" aria-labelledby="existing-beer-heading">
      <h3 id="existing-beer-heading">Existing catalog beer</h3>
      {intentError ? (
        <ErrorState
          message={`The saved review intent could not be loaded: ${intentError.message}`}
          onRetry={reloadIntent}
        />
      ) : (
        <>
          {loading ? (
            <Loading />
          ) : error ? (
            <ErrorState
              message={`The target catalog beer could not be loaded: ${error.message}`}
              onRetry={reload}
            />
          ) : (
            <p>
              The saved review intent targets existing catalog beer{" "}
              <strong>
                #{targetBeerId}
                {beer ? ` - ${beer.name}` : ""}
              </strong>
              {beer?.brewery ? ` (${beer.brewery.name})` : ""}.{" "}
              <Link to={`/admin/catalog/beers/${targetBeerId}`}>
                Open catalog beer #{targetBeerId}
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
            catalog beer #{targetBeerId} only. It does not create or
            change a beer, and it does not publish anything: the
            image reaches the catalog only when a manifest containing
            this image-only entry (version 2 manifest entries,
            contract section B2) is approved by its exact ID and
            SHA-256 and then imported by the operator.
          </p>
        </>
      )}
    </section>
  );
};

export default DiscoveryExistingBeerPanel;
