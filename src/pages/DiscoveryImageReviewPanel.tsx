import React, { useEffect, useState } from "react";
import { apiGet, apiGetBlobUrl, apiPost, ApiError } from "../api/client";
import { useApiData } from "../api/useApiData";
import {
  DiscoveryCandidateDetail,
  DiscoveryImageDecision,
  DiscoveryImageFetch,
  ListResponse,
} from "../api/types";
import { fmtDate, fmtVal } from "../components/helpers";

// Image Review panel (hub decision 006 revision 2): hash-bound image
// decisions for a staged candidate. The reviewer NEVER sees the image
// at its origin URL here: the panel asks the API to fetch the staged
// image server-side (under the documented SSRF restrictions), then
// renders the preview ONLY from the API's preview endpoint, which
// serves the exact stored bytes. The staged URL appears as provenance
// TEXT only; it is never used as an <img> source anywhere in this
// panel. Approve/Reject stay disabled until the preview image has
// actually loaded in the browser (the same load gate as the image
// approval queue), and they bind to the displayed fetch: the API
// re-hashes the stored bytes and refuses any decision whose bytes no
// longer match the fetch's recorded SHA-256.

const shortSha = (sha: string | null): string =>
  sha ? `${sha.slice(0, 12)}…` : "none";

const DiscoveryImageReviewPanel: React.FC<{
  candidate: DiscoveryCandidateDetail;
  onDecisionRecorded?: () => void;
}> = ({ candidate, onDecisionRecorded }) => {
  const candidateId = candidate.id;
  const [tick, setTick] = useState(0);
  const { data: fetchData } = useApiData(
    () =>
      apiGet<ListResponse<DiscoveryImageFetch>>(
        `/discovery/candidates/${candidateId}/image-fetches`,
        { page_size: 100 }
      ),
    [candidateId, tick]
  );
  const { data: decisionData } = useApiData(
    () =>
      apiGet<ListResponse<DiscoveryImageDecision>>(
        `/discovery/candidates/${candidateId}/image-decisions`,
        { page_size: 100 }
      ),
    [candidateId, tick]
  );
  const fetches: DiscoveryImageFetch[] = fetchData?.results ?? [];
  const imageDecisions: DiscoveryImageDecision[] = decisionData?.results ?? [];

  const [selectedFetchId, setSelectedFetchId] = useState<number | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const successfulFetches = fetches.filter((f) => f.outcome === "success");
  const latestSuccessful = successfulFetches.length > 0 ? successfulFetches[0] : null;
  // Default selection: the explicitly chosen fetch, else the latest
  // successful fetch, else the latest fetch overall (so a failed-only
  // history still surfaces its failure state).
  const selectedFetch =
    fetches.find((f) => f.id === selectedFetchId) ??
    latestSuccessful ??
    (fetches.length > 0 ? fetches[0] : null);

  // Load the preview (stored bytes via the preview endpoint) whenever
  // the selection changes. The object URL is revoked on change.
  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    setPreviewUrl(null);
    setPreviewLoaded(false);
    setPreviewError(null);
    if (selectedFetch && selectedFetch.outcome === "success") {
      apiGetBlobUrl(`/discovery/image-fetches/${selectedFetch.id}/preview`)
        .then((url) => {
          if (revoked) {
            if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
            return;
          }
          objectUrl = url;
          setPreviewUrl(url);
        })
        .catch((e) => {
          if (!revoked) {
            setPreviewError(
              e instanceof ApiError ? e.message : "The preview could not be loaded."
            );
          }
        });
    }
    return () => {
      revoked = true;
      if (objectUrl && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(objectUrl);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFetch?.id, selectedFetch?.outcome]);

  const doFetch = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const created = await apiPost<DiscoveryImageFetch>(
        `/discovery/candidates/${candidateId}/image-fetches`,
        {}
      );
      setSelectedFetchId(created.id);
      setTick((t) => t + 1);
    } catch (e) {
      setActionError(
        e instanceof ApiError ? e.message : "The image fetch could not be completed."
      );
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: string) => {
    if (!selectedFetch) return;
    setBusy(true);
    setActionError(null);
    try {
      const body: Record<string, unknown> = {
        fetch_id: selectedFetch.id,
        decision,
      };
      if (selectedFetch.sha256) body.image_sha256 = selectedFetch.sha256;
      if (note.trim()) body.note = note.trim();
      await apiPost(`/discovery/candidates/${candidateId}/image-decisions`, body);
      setNote("");
      setTick((t) => t + 1);
      if (onDecisionRecorded) onDecisionRecorded();
    } catch (e) {
      setActionError(
        e instanceof ApiError ? e.message : "The image decision could not be recorded."
      );
    } finally {
      setBusy(false);
    }
  };

  const alreadyDecided = selectedFetch?.decision != null;
  const isLatest = selectedFetch != null && latestSuccessful != null
    && selectedFetch.id === latestSuccessful.id;
  const decideDisabledReason = !selectedFetch
    ? "Fetch the image first; a decision binds to a specific fetch."
    : selectedFetch.outcome !== "success"
      ? `This fetch failed (${selectedFetch.outcome}) and produced no bytes to decide on. Fetch again.`
      : alreadyDecided
        ? `This fetch was already decided (${selectedFetch.decision?.decision}); a fetch can be decided only once. Fetch again for a new decision.`
        : !isLatest
          ? "A newer successful fetch exists. Decide on the latest fetch so the decision binds to the freshest bytes."
          : !previewLoaded
            ? "Approve and reject unlock once the preview image has loaded."
            : null;

  return (
    <div className="image-review-panel">
      <h2>Image Review</h2>
      <div className="detail-grid">
        <div>
          <span className="field-label">Staged Image URL (provenance)</span>
          {candidate.image_url ? (
            <span className="provenance-text">{candidate.image_url}</span>
          ) : (
            "None"
          )}
        </div>
        <div><span className="field-label">Staged Status</span>{fmtVal(candidate.image_status)}</div>
        <div><span className="field-label">Image Source</span>{fmtVal(candidate.image_source)}</div>
        <div><span className="field-label">License</span>{fmtVal(candidate.image_license)}</div>
        <div>
          <span className="field-label">Current Image Decision</span>
          {candidate.image_decision
            ? `${candidate.image_decision} (fetch ${fmtVal(candidate.image_decision_fetch_id)}, ${fmtDate(candidate.image_decision_at)})`
            : "None recorded"}
        </div>
      </div>

      <div className="decision-actions">
        <button type="button" disabled={busy || !candidate.image_url} onClick={doFetch}>
          Fetch image for review
        </button>
        <span>
          The API fetches the image server-side and stores the exact bytes;
          fetches are rate-limited per reviewer (30 per hour).
        </span>
      </div>
      {!candidate.image_url && (
        <p>This candidate has no staged image URL, so there is nothing to fetch.</p>
      )}

      {fetches.length > 0 && (
        <>
          <h3>Fetch History</h3>
          <ul>
            {fetches.map((f) => (
              <li key={f.id}>
                Fetch {f.id} | Outcome: {f.outcome}
                {f.outcome_detail ? ` (${f.outcome_detail})` : ""} | SHA-256:{" "}
                {shortSha(f.sha256)} | Type: {fmtVal(f.content_type)} |{" "}
                {f.width !== null && f.height !== null
                  ? `${f.width} x ${f.height} | `
                  : ""}
                By {f.fetched_by ? f.fetched_by.user_name : "unknown"} |{" "}
                {fmtDate(f.fetched_at)}
                {f.decision
                  ? ` | Decided: ${f.decision.decision}`
                  : ""}
                {f.outcome === "success" && (
                  <>
                    {" "}
                    <button
                      type="button"
                      onClick={() => setSelectedFetchId(f.id)}
                      disabled={selectedFetch?.id === f.id}
                    >
                      {selectedFetch?.id === f.id ? "Previewing" : "Preview"}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {selectedFetch && selectedFetch.outcome !== "success" && (
        <div className="queue-preview-failed" role="alert">
          Fetch {selectedFetch.id} failed: {selectedFetch.outcome}
          {selectedFetch.outcome_detail ? ` - ${selectedFetch.outcome_detail}` : ""}
        </div>
      )}

      {selectedFetch && selectedFetch.outcome === "success" && (
        <div className="image-review-preview">
          <h3>Preview (stored bytes)</h3>
          {previewError && (
            <div className="queue-preview-failed" role="alert">
              {previewError}
            </div>
          )}
          {previewUrl && (
            <img
              className="queue-preview"
              src={previewUrl}
              alt={`Fetched preview for ${candidate.name}`}
              onLoad={() => setPreviewLoaded(true)}
              onError={() => setPreviewError("The preview image failed to load.")}
            />
          )}
          <div className="detail-grid">
            <div>
              <span className="field-label">SHA-256</span>
              <span title={selectedFetch.sha256 || undefined}>
                {shortSha(selectedFetch.sha256)}
              </span>
            </div>
            <div><span className="field-label">Verified Type</span>{fmtVal(selectedFetch.content_type)}</div>
            <div>
              <span className="field-label">Dimensions</span>
              {selectedFetch.width !== null && selectedFetch.height !== null
                ? `${selectedFetch.width} x ${selectedFetch.height}`
                : "Not recorded"}
            </div>
            <div><span className="field-label">Fetched</span>{fmtDate(selectedFetch.fetched_at)}</div>
          </div>

          <div>
            <label htmlFor="image-decision-note">Decision note (optional)</label>
            <textarea
              id="image-decision-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
            />
          </div>
          <div className="decision-actions">
            <button
              type="button"
              disabled={busy || decideDisabledReason !== null}
              onClick={() => decide("approved")}
            >
              Approve image
            </button>
            <button
              type="button"
              disabled={busy || decideDisabledReason !== null}
              onClick={() => decide("rejected")}
            >
              Reject image
            </button>
          </div>
          {decideDisabledReason && <p>{decideDisabledReason}</p>}
        </div>
      )}

      {actionError && (
        <div className="queue-preview-failed" role="alert">
          {actionError}
        </div>
      )}

      <h3>Image Decision History</h3>
      {imageDecisions.length > 0 ? (
        <ul>
          {imageDecisions.map((d) => (
            <li key={d.id}>
              {d.decision} | Fetch {d.fetch_id} | SHA-256: {shortSha(d.image_sha256)} |{" "}
              By {d.decided_by ? d.decided_by.user_name : "unknown"} |{" "}
              {fmtDate(d.decided_at)}
              {d.note ? ` | Note: ${d.note}` : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p>No image decisions recorded yet</p>
      )}
    </div>
  );
};

export default DiscoveryImageReviewPanel;
