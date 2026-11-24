import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet, apiGetBlobUrl, apiPost, ApiError } from "../api/client";
import { useApiData } from "../api/useApiData";
import { DiscoveryManifestDetail } from "../api/types";
import { ErrorState, Loading } from "../components/States";
import DiscoveryManifestComposition from "../components/DiscoveryManifestComposition";
import { fmtDate, fmtVal } from "../components/helpers";
import HelpTip from "../components/HelpTip";
import StatusChip from "../components/StatusChip";

// One discovery import manifest (Phase 5). The full SHA-256 is the
// approval target: Frank verifies it out of band (the Export button
// downloads the exact canonical bytes that were hashed, so
// `sha256sum` offline must reproduce it) and approves the exact hash
// through the API. The approve control renders ONLY when the API
// says this account can approve (can_approve, computed server-side
// from the approver allowlist) AND the manifest is still a draft;
// the API enforces the gate regardless of what the client shows.
// Void is available while the manifest is draft or approved; an
// imported manifest is final, and its reversal is a separate
// approved data operation (see the discovery hub runbook).
const DiscoveryManifestDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error, reload } = useApiData(
    () => apiGet<DiscoveryManifestDetail>(`/discovery/manifests/${id}`),
    [id]
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return <ErrorState message="Manifest not found." onRetry={reload} />;

  const manifest = data;

  const copyHash = async () => {
    try {
      await navigator.clipboard.writeText(manifest.sha256);
      setCopied(true);
    } catch (e) {
      setCopied(false);
    }
  };

  const runAction = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setActionError(
        e instanceof ApiError || e instanceof Error
          ? e.message
          : "The action failed."
      );
    } finally {
      setBusy(null);
    }
  };

  const approve = () =>
    runAction("approve", () =>
      apiPost(`/discovery/manifests/${manifest.id}/approve`, {
        sha256: manifest.sha256,
      })
    );

  const voidManifest = () =>
    runAction("void", () =>
      apiPost(`/discovery/manifests/${manifest.id}/void`, {})
    );

  const exportManifest = () =>
    runAction("export", async () => {
      const url = await apiGetBlobUrl(
        `/discovery/manifests/${manifest.id}/export`
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${manifest.id}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });

  const canVoid = manifest.status === "draft" || manifest.status === "approved";
  const showApprove = manifest.can_approve && manifest.status === "draft";

  return (
    <div>
      <div className="page-title-row">
        <h1>{manifest.id}</h1>
        <StatusChip status={manifest.status} />
      </div>
      <p>
        <Link to="/admin/discovery/manifests">Back to manifests</Link>
        {manifest.batch_slug ? (
          <>
            {" | "}
            <Link
              to={`/admin/discovery/batches/${manifest.batch_id}/candidates`}
            >
              Batch {manifest.batch_slug}
            </Link>
          </>
        ) : null}
      </p>

      <section className="queue-card">
        <div className="detail-grid">
          <div>
            <span className="field-label">Status</span>
            <StatusChip status={manifest.status} />
          </div>
          <div>
            <span className="field-label">Records</span>
            {manifest.record_count}
          </div>
          <div>
            <span className="field-label">Built</span>
            {fmtDate(manifest.created_at)}
            {manifest.built_by ? ` by ${manifest.built_by.user_name}` : ""}
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
            {manifest.imported_at ? fmtDate(manifest.imported_at) : "Not imported"}
          </div>
        </div>
        <div>
          <span className="field-label">
            SHA-256 (full)
            <HelpTip topic="manifest hash">
              The SHA-256 of this manifest's exact canonical bytes.
              Approval binds to this hash: verify it out of band
              (Export downloads the exact bytes, so sha256sum must
              reproduce it) before approving. Any change to the
              manifest or the catalog makes the approval stale.
            </HelpTip>
          </span>
          <div className="hash-block">
            <code>{manifest.sha256}</code>{" "}
            <button type="button" className="btn" onClick={copyHash}>
              Copy hash
            </button>{" "}
            {copied ? <span>Copied</span> : null}
          </div>
          {manifest.approved_sha256 ? (
            <p>
              Approved SHA-256: <code>{manifest.approved_sha256}</code>
            </p>
          ) : null}
        </div>
        <div>
          <span className="field-label">Catalog fingerprint at build</span>
          <ul>
            <li>
              beers: {manifest.catalog_fingerprint.beers.count} rows, md5{" "}
              <code>{manifest.catalog_fingerprint.beers.md5}</code>
            </li>
            <li>
              breweries: {manifest.catalog_fingerprint.breweries.count} rows,
              md5 <code>{manifest.catalog_fingerprint.breweries.md5}</code>
            </li>
            <li>
              beverage_images: {manifest.catalog_fingerprint.beverage_images.count}{" "}
              rows, md5{" "}
              <code>{manifest.catalog_fingerprint.beverage_images.md5}</code>
            </li>
          </ul>
        </div>
        {actionError ? (
          <div className="queue-preview-failed" role="alert">
            {actionError}
          </div>
        ) : null}
        <p>
          <button
            type="button"
            onClick={exportManifest}
            disabled={busy !== null}
          >
            Export manifest JSON
          </button>{" "}
          {showApprove ? (
            <button
              type="button"
              onClick={approve}
              disabled={busy !== null}
            >
              {busy === "approve"
                ? "Approving..."
                : "Approve this manifest hash"}
            </button>
          ) : null}{" "}
          {canVoid ? (
            <button
              type="button"
              onClick={voidManifest}
              disabled={busy !== null}
            >
              {busy === "void" ? "Voiding..." : "Void manifest"}
            </button>
          ) : null}
        </p>
        {manifest.status === "draft" && !manifest.can_approve ? (
          <p>
            This manifest is a draft. Only the manifest approver account
            can approve its hash; approval here is separate from
            candidate selection and image approval.
          </p>
        ) : null}
        {manifest.status === "approved" ? (
          <p>
            Approved. The operator executor can import this manifest
            while the catalog fingerprint and candidate decisions are
            unchanged; any change makes it stale and the import aborts.
            <HelpTip topic="import">
              Importing runs outside this UI, through the operator
              executor, only against a manifest whose exact hash was
              approved. The executor re-validates every record at
              import time and aborts if the catalog has drifted.
              Nothing in this UI imports by itself.
            </HelpTip>
          </p>
        ) : null}
      </section>

      <DiscoveryManifestComposition manifest={manifest} />

      <section className="queue-card">
        <h2>Records ({manifest.records.length})</h2>
        {manifest.records.length === 0 ? (
          <p>No records recorded.</p>
        ) : (
          <ul>
            {manifest.records.map((record) => (
              <li key={record.candidate_id}>
                <Link to={`/admin/discovery/candidates/${record.candidate_id}`}>
                  {record.candidate_key}
                </Link>{" "}
                {fmtVal(record.beer_name)}
                {record.brewery_name ? ` (${record.brewery_name})` : ""}
                {record.brewery?.mode === "new"
                  ? " - new brewery"
                  : record.brewery?.mode === "existing"
                    ? ` - brewery #${record.brewery.brewery_id}`
                    : ""}
                {record.style?.mode === "existing"
                  ? ` - style #${record.style.style_id}`
                  : ""}
                {record.image
                  ? ` - image approved (decision ${record.image.decision_id}, sha256 ${record.image.sha256.slice(0, 12)}…)`
                  : " - no image"}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="queue-card">
        <h2>History</h2>
        {manifest.events.length === 0 ? (
          <p>No events recorded.</p>
        ) : (
          <ul>
            {manifest.events.map((event) => (
              <li key={event.id}>
                {event.action}
                {event.from_status || event.to_status
                  ? ` (${fmtVal(event.from_status)} to ${fmtVal(event.to_status)})`
                  : ""}{" "}
                {fmtDate(event.created_at)}
                {event.actor ? ` by ${event.actor.user_name}` : ""}
                {event.note ? ` - ${event.note}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

export default DiscoveryManifestDetailPage;
