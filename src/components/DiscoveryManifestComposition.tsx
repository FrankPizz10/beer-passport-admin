import React from "react";
import { Link } from "react-router-dom";
import {
  DiscoveryReviewClient,
  getBatchComposition,
  httpDiscoveryReviewClient,
} from "../api/discoveryReview";
import { useApiData } from "../api/useApiData";
import { DiscoveryManifestDetail } from "../api/types";
import { EmptyState, ErrorState, Loading } from "./States";

// "What will be imported" for one manifest's batch. Two disjoint
// sets, never merged:
//
// - New beers: the records inside THIS manifest. Every manifest
//   entry today is a new beer (the canonical content has no other
//   entry kind), so the manifest's record count is the new-beer
//   count, and approving the hash above approves exactly these.
// - Image-only candidates: selected candidates in the batch that
//   matched an existing catalog beer. They are NOT in this manifest
//   and cannot be imported at all yet (the builder refuses them
//   with already_in_catalog; image-only entries are proposed in
//   docs/DISCOVERY_REVIEW_API_CONTRACT.md section B2). They are
//   counted by paging the batch candidates endpoint with its
//   review_status=selected filter until the server-reported total
//   is covered, so the numbers describe the complete batch (the
//   production batch has 6,817 records), never a sample or a page.

const DiscoveryManifestComposition: React.FC<{
  manifest: DiscoveryManifestDetail;
  client?: DiscoveryReviewClient;
}> = ({ manifest, client = httpDiscoveryReviewClient }) => {
  const { data, loading, error, reload } = useApiData(
    () => getBatchComposition(client, manifest.batch_id),
    [manifest.batch_id]
  );

  return (
    <section className="queue-card" aria-labelledby="manifest-composition-heading">
      <h2 id="manifest-composition-heading">What will be imported</h2>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState
          message={`The batch composition could not be loaded: ${error.message}`}
          onRetry={reload}
        />
      ) : !data || data.selectedCount === 0 ? (
        <EmptyState message="No candidates in this batch are selected yet, so nothing beyond this manifest's records is queued for import." />
      ) : (
        <>
          <ul>
            <li>
              New beers in this manifest: {manifest.record_count} record
              {manifest.record_count === 1 ? "" : "s"}. Approving the
              SHA-256 above approves exactly these records.
            </li>
            <li>
              Selected in batch: {data.selectedCount} of{" "}
              {data.totalRecords !== null
                ? `${data.totalRecords} staged records`
                : "the batch's staged records"}
              {" "}({data.newBeerCount} new-beer candidates,{" "}
              {data.imageOnlyCount} image-only).
            </li>
            <li>
              Image-only candidates (existing catalog beer, image
              only): {data.imageOnlyCount}. These are not part of this
              manifest.
            </li>
          </ul>
          {data.imageOnlyCount === 0 ? (
            <EmptyState message="No image-only records in this batch: no selected candidate matched an existing catalog beer." />
          ) : (
            <ul>
              {data.imageOnly.map((candidate) => (
                <li key={candidate.id}>
                  <Link to={`/admin/discovery/candidates/${candidate.id}`}>
                    {candidate.name}
                  </Link>{" "}
                  - existing catalog beer #{candidate.matched_beer_id}{" "}
                  <span className="badge">Pending backend support</span>
                </li>
              ))}
            </ul>
          )}
          <p>
            Image-only import is pending backend support (contract
            section B2): the manifest builder currently refuses
            selected candidates that already match a catalog beer
            (already_in_catalog), so an image-only record must be held
            or left unselected before this batch's manifest can build.
          </p>
        </>
      )}
    </section>
  );
};

export default DiscoveryManifestComposition;
