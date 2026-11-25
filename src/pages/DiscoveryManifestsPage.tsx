import React from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { DiscoveryManifest, ListResponse } from "../api/types";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { fmtDate, fmtVal } from "../components/helpers";
import StatusChip from "../components/StatusChip";

// Discovery import manifests (Phase 5): immutable, hash-bound import
// packages built from a batch's selected candidates. Approval is
// Frank's separate gate (decision 006): a manifest is importable
// only after the allowlisted account approves its exact id + SHA-256
// through the API. This page is read-only; building happens per batch
// on the Batches page, approval and void on the detail page.
const DiscoveryManifestsPage: React.FC = () => {
  const { data, loading, error, reload } = useApiData(
    () => apiGet<ListResponse<DiscoveryManifest>>("/discovery/manifests"),
    []
  );
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;

  const manifests = data?.results ?? [];

  return (
    <div>
      <h1>Discovery Import Manifests</h1>
      <p>
        A manifest freezes one batch's selected candidates, their
        approved image decisions, and the live catalog fingerprint into
        canonical bytes with a SHA-256 hash. Only an approved manifest
        whose hash still matches can be imported, by the operator
        executor, and any catalog change after approval makes it
        stale. This is the later, exact-hash approval step: the
        per-candidate work happens earlier in the Review Queue and
        Discovery Batches, and approving a manifest is not the same
        as importing it.
      </p>
      {manifests.length === 0 ? (
        <EmptyState message="No discovery import manifests found. Build one from a batch once its candidates are selected." />
      ) : (
        <div className="queue-list">
          {manifests.map((manifest) => (
            <section className="queue-card" key={manifest.id}>
              <h2>
                <Link to={`/admin/discovery/manifests/${manifest.id}`}>
                  {manifest.id}
                </Link>
              </h2>
              <div className="detail-grid">
                <div>
                  <span className="field-label">Batch</span>
                  {manifest.batch_slug ? (
                    <Link
                      to={`/admin/discovery/batches/${manifest.batch_id}/candidates`}
                    >
                      {manifest.batch_slug}
                    </Link>
                  ) : (
                    fmtVal(manifest.batch_id)
                  )}
                </div>
                <div>
                  <span className="field-label">Records</span>
                  {manifest.record_count}
                </div>
                <div>
                  <span className="field-label">Status</span>
                  <StatusChip status={manifest.status} />
                </div>
                <div>
                  <span className="field-label">SHA-256</span>
                  <code>{manifest.sha256_short}…</code>
                </div>
                <div>
                  <span className="field-label">Built</span>
                  {fmtDate(manifest.created_at)}
                  {manifest.built_by
                    ? ` by ${manifest.built_by.user_name}`
                    : ""}
                </div>
                <div>
                  <span className="field-label">Approval</span>
                  {manifest.approved_at
                    ? `Approved ${fmtDate(manifest.approved_at)}${
                        manifest.approved_by
                          ? ` by ${manifest.approved_by.user_name}`
                          : ""
                      }`
                    : "Not approved"}
                </div>
                <div>
                  <span className="field-label">Imported</span>
                  {manifest.imported_at
                    ? fmtDate(manifest.imported_at)
                    : "Not imported"}
                </div>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
};

export default DiscoveryManifestsPage;
