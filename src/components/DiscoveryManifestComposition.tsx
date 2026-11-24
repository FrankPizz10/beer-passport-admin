import React from "react";
import { Link } from "react-router-dom";
import { getManifestComposition } from "../api/discoveryReview";
import { DiscoveryManifestDetail } from "../api/types";
import { EmptyState } from "./States";

// "What will be imported" for one manifest, derived from the
// manifest's OWN records (the detail response the page already
// fetched), never from candidate matching:
//
// - New beers: records with kind "new_beer", and every version 1
//   record (no kind at all). Approving the exact manifest ID and
//   SHA-256 above approves exactly these records.
// - Image-only: version 2 records with kind "image_only". Each
//   carries a target_beer_id (an EXISTING catalog beer) and an
//   image; importing one writes only a beverage_images row for that
//   beer and creates or changes no beer.
//
// The version 2 manifest backend is implemented in Codex's local
// backend and is NOT reviewed or deployed yet, so the pending
// notice below stays until it is: production manifests today
// contain new-beer entries only.

const DiscoveryManifestComposition: React.FC<{
  manifest: DiscoveryManifestDetail;
}> = ({ manifest }) => {
  const composition = getManifestComposition(manifest);

  return (
    <section className="queue-card" aria-labelledby="manifest-composition-heading">
      <h2 id="manifest-composition-heading">What will be imported</h2>
      <p>
        Approving the exact manifest ID and SHA-256 shown above
        (manifest {manifest.id}, sha256 {manifest.sha256}) approves
        exactly the {composition.totalRecords} record
        {composition.totalRecords === 1 ? "" : "s"} below.
      </p>
      {composition.totalRecords === 0 ? (
        <EmptyState message="This manifest contains no records, so importing it would change nothing." />
      ) : (
        <>
          <ul>
            <li>
              New beers: {composition.newBeerCount} record
              {composition.newBeerCount === 1 ? "" : "s"} (entries of
              kind "new_beer", or version 1 entries with no kind).
            </li>
            <li>
              Image-only records: {composition.imageOnlyCount} (entries
              of kind "image_only": an image for an existing catalog
              beer, creating and changing no beer).
            </li>
          </ul>
          {composition.imageOnlyCount === 0 ? (
            <EmptyState message="No image-only records in this manifest: every entry is a new beer." />
          ) : (
            <ul>
              {composition.imageOnly.map((record) => (
                <li key={record.candidate_id}>
                  <Link to={`/admin/discovery/candidates/${record.candidate_id}`}>
                    {record.candidate_key}
                  </Link>{" "}
                  - image for existing catalog beer #
                  {record.target_beer_id}{" "}
                  {record.image
                    ? `(image decision ${record.image.decision_id}, sha256 ${record.image.sha256.slice(0, 12)}…)`
                    : ""}{" "}
                  <span className="badge">Pending backend support</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <p>
        Image-only import is pending backend review and deployment
        (contract section B2): version 2 manifest entries of kind
        "image_only" come from Codex's backend, which is implemented
        locally but not yet deployed, so until it ships this
        manifest's import covers its new-beer entries only.
      </p>
    </section>
  );
};

export default DiscoveryManifestComposition;
