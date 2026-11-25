import React, { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import {
  DiscoveryReviewClient,
  extractRetryAfterSeconds,
  httpDiscoveryReviewClient,
} from "../../api/discoveryReview";
import {
  DiscoveryCandidateDetail,
  DiscoveryImageDecision,
  DiscoveryImageFetch,
} from "../../api/types";
import { fmtDate, fmtVal } from "../helpers";
import { isImageStoreUnsetError } from "../../pages/DiscoveryImageReviewPanel";
import { latestSuccessfulFetch } from "./approveFlow";

// Image section of the guided review, built on the typed review
// client so the approve-for-import flow and this panel share one
// picture of the fetch/decision state. Behavior mirrors the
// candidate page's panel: the preview renders ONLY the stored bytes
// from the API preview endpoint (the origin URL is provenance
// text), a successful stored preview is reused and never
// auto-refetched, and approve/reject unlock only after the preview
// image has loaded and bind to the displayed fetch's SHA-256.
//
// Rate limits (WS3 contract): a 429 refusal may carry
// retry_after_seconds; when it does, the panel shows timed guidance
// ("try again in about N minutes") instead of the raw error.

export interface GuidedImageState {
  fetches: DiscoveryImageFetch[];
  imageDecisions: DiscoveryImageDecision[];
  latestFetch: DiscoveryImageFetch | null;
  // The recorded decision for the latest successful fetch, if any.
  latestDecision: DiscoveryImageDecision | { decision: string } | null;
  hasStoredPreview: boolean;
}

const shortSha = (sha: string | null): string =>
  sha ? `${sha.slice(0, 12)}…` : "none";

export const retryGuidance = (seconds: number): string => {
  if (seconds < 90) {
    return `Image fetch limit reached - try again in about ${Math.ceil(seconds)} seconds.`;
  }
  return `Image fetch limit reached - try again in about ${Math.ceil(seconds / 60)} minutes.`;
};

const GuidedImagePanel: React.FC<{
  candidate: DiscoveryCandidateDetail;
  client?: DiscoveryReviewClient;
  initialFetches?: DiscoveryImageFetch[];
  initialDecisions?: DiscoveryImageDecision[];
  onStateChange?: (state: GuidedImageState) => void;
}> = ({
  candidate,
  client = httpDiscoveryReviewClient,
  initialFetches,
  initialDecisions,
  onStateChange,
}) => {
  const candidateId = candidate.id;
  const [fetches, setFetches] = useState<DiscoveryImageFetch[]>(
    initialFetches ?? []
  );
  const [decisions, setDecisions] = useState<DiscoveryImageDecision[]>(
    initialDecisions ?? []
  );
  const [loaded, setLoaded] = useState(
    initialFetches !== undefined && initialDecisions !== undefined
  );
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rateLimitNote, setRateLimitNote] = useState<string | null>(null);
  const [storeUnsetError, setStoreUnsetError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const stateRef = useRef(onStateChange);
  stateRef.current = onStateChange;

  const latestFetch = useMemo(
    () => latestSuccessfulFetch(fetches),
    [fetches]
  );
  const latestDecision = useMemo(() => {
    if (!latestFetch) return null;
    if (latestFetch.decision) return latestFetch.decision;
    return decisions.find((d) => d.fetch_id === latestFetch.id) ?? null;
  }, [latestFetch, decisions]);

  const reload = async () => {
    const [fetchResp, decisionResp] = await Promise.all([
      client.listImageFetches(candidateId),
      client.listImageDecisions(candidateId),
    ]);
    setFetches(fetchResp?.results ?? []);
    setDecisions(decisionResp?.results ?? []);
    setLoaded(true);
  };

  useEffect(() => {
    if (loaded) return;
    let cancelled = false;
    Promise.all([
      client.listImageFetches(candidateId),
      client.listImageDecisions(candidateId),
    ])
      .then(([fetchResp, decisionResp]) => {
        if (cancelled) return;
        setFetches(fetchResp?.results ?? []);
        setDecisions(decisionResp?.results ?? []);
        setLoaded(true);
      })
      .catch((e) => {
        if (!cancelled) {
          setActionError(
            e instanceof Error
              ? e.message
              : "Image history could not be loaded."
          );
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateId, client]);

  useEffect(() => {
    if (stateRef.current) {
      stateRef.current({
        fetches,
        imageDecisions: decisions,
        latestFetch,
        latestDecision,
        hasStoredPreview: latestFetch !== null,
      });
    }
  }, [fetches, decisions, latestFetch, latestDecision]);

  // Preview bytes for the latest successful fetch, reused as-is:
  // this effect runs when the fetch id changes, never on a timer.
  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    setPreviewUrl(null);
    setPreviewLoaded(false);
    setPreviewError(null);
    if (latestFetch) {
      client
        .getImagePreviewUrl(latestFetch.id)
        .then((url) => {
          if (revoked) {
            if (typeof URL.revokeObjectURL === "function")
              URL.revokeObjectURL(url);
            return;
          }
          objectUrl = url;
          setPreviewUrl(url);
        })
        .catch((e) => {
          if (revoked) return;
          const message =
            e instanceof ApiError
              ? e.message
              : "The preview could not be loaded.";
          if (isImageStoreUnsetError(message)) {
            setStoreUnsetError(message);
          } else {
            setPreviewError(message);
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
  }, [latestFetch?.id, client]);

  const handleError = (e: unknown, fallback: string) => {
    const retry = extractRetryAfterSeconds(e);
    if (e instanceof ApiError && e.status === 429) {
      setRateLimitNote(
        retry !== null ? retryGuidance(retry) : e.message
      );
      return;
    }
    const message = e instanceof ApiError ? e.message : fallback;
    if (isImageStoreUnsetError(message)) {
      setStoreUnsetError(message);
    } else {
      setActionError(message);
    }
  };

  const doFetch = async () => {
    setBusy(true);
    setActionError(null);
    setRateLimitNote(null);
    try {
      await client.requestImageFetch(candidateId);
      setStoreUnsetError(null);
      await reload();
    } catch (e) {
      handleError(e, "The image fetch could not be completed.");
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: "approved" | "rejected") => {
    if (!latestFetch) return;
    setBusy(true);
    setActionError(null);
    try {
      await client.decideImage(candidateId, {
        fetch_id: latestFetch.id,
        decision,
        image_sha256: latestFetch.sha256 ?? undefined,
        note: note.trim() ? note.trim() : undefined,
      });
      setNote("");
      await reload();
    } catch (e) {
      handleError(e, "The image decision could not be recorded.");
    } finally {
      setBusy(false);
    }
  };

  const decideDisabledReason = !latestFetch
    ? "Fetch the image first; a decision binds to a specific stored fetch."
    : latestDecision
      ? `Fetch ${latestFetch.id} already has a decision (${latestDecision.decision}); a fetch can be decided only once.`
      : !previewLoaded
        ? "Approve and reject unlock once the stored preview has loaded."
        : null;

  return (
    <div className="image-review-panel guided-image-panel">
      <div className="detail-grid">
        <div>
          <span className="field-label">Staged Image URL (provenance)</span>
          {candidate.image_url ? (
            <span className="provenance-text">{candidate.image_url}</span>
          ) : (
            "None"
          )}
        </div>
        <div>
          <span className="field-label">Staged Status</span>
          {fmtVal(candidate.image_status)}
        </div>
        <div>
          <span className="field-label">Current Image Decision</span>
          {candidate.image_decision
            ? `${candidate.image_decision} (fetch ${fmtVal(candidate.image_decision_fetch_id)})`
            : "None recorded"}
        </div>
      </div>

      <div className="decision-actions">
        <button
          type="button"
          className="btn"
          disabled={busy || !candidate.image_url}
          onClick={doFetch}
        >
          Fetch image for review
        </button>
        <span>
          The API fetches the image server-side and stores the exact
          bytes. A stored preview is reused; fetching again is a new
          rate-limited attempt, so fetch only when no usable preview
          exists.
        </span>
      </div>
      {!candidate.image_url && (
        <p>
          This candidate has no staged image URL, so there is nothing
          to fetch. It can still be reviewed and approved as a new
          beer without an image.
        </p>
      )}

      {rateLimitNote && (
        <div className="callout callout-warning" role="alert">
          {rateLimitNote} The limit counts every fetch attempt in a
          rolling hour, including failed ones. Stored previews above
          are unaffected and can still be decided on.
        </div>
      )}
      {storeUnsetError && (
        <div className="callout store-unavailable" role="alert">
          <h3>Image preview unavailable: the server image store is not configured</h3>
          <p>
            The server refused the fetch: <code>{storeUnsetError}</code>
          </p>
          <p>
            An administrator must configure the server-side image
            store; there is nothing a reviewer can fix here, and you
            should not fetch or upload the origin URL yourself. The
            staged provenance and any saved review intent are
            unchanged, and this candidate can still be approved
            without an image decision.
          </p>
        </div>
      )}
      {actionError && (
        <div className="queue-preview-failed" role="alert">
          {actionError}
        </div>
      )}

      {latestFetch ? (
        <div className="image-review-preview">
          <h3>Preview (stored bytes, fetch {latestFetch.id})</h3>
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
              onError={() =>
                setPreviewError("The preview image failed to load.")
              }
            />
          )}
          <div className="detail-grid">
            <div>
              <span className="field-label">SHA-256</span>
              <span title={latestFetch.sha256 || undefined}>
                {shortSha(latestFetch.sha256)}
              </span>
            </div>
            <div>
              <span className="field-label">Verified Type</span>
              {fmtVal(latestFetch.content_type)}
            </div>
            <div>
              <span className="field-label">Dimensions</span>
              {latestFetch.width !== null && latestFetch.height !== null
                ? `${latestFetch.width} x ${latestFetch.height}`
                : "Not recorded"}
            </div>
            <div>
              <span className="field-label">Fetched</span>
              {fmtDate(latestFetch.fetched_at)}
            </div>
          </div>
          <div>
            <label htmlFor="guided-image-decision-note">
              Decision note (optional)
            </label>
            <textarea
              id="guided-image-decision-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
            />
          </div>
          <div className="decision-actions">
            <button
              type="button"
              className="btn"
              disabled={busy || decideDisabledReason !== null}
              onClick={() => decide("approved")}
            >
              Approve image
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy || decideDisabledReason !== null}
              onClick={() => decide("rejected")}
            >
              Reject image
            </button>
          </div>
          {decideDisabledReason && <p>{decideDisabledReason}</p>}
          <p className="gate-note">
            An image decision judges these stored bytes only and is
            one of the steps "Approve for import" performs. It never
            publishes or imports anything by itself.
          </p>
        </div>
      ) : (
        loaded &&
        candidate.image_url && (
          <p>
            No stored preview yet. Fetch the image to inspect the
            exact bytes before approving; approving without a preview
            is not possible here.
          </p>
        )
      )}

      {fetches.length > 0 && (
        <details className="technical-details">
          <summary>Fetch and decision history</summary>
          <ul>
            {fetches.map((f) => (
              <li key={f.id}>
                Fetch {f.id} | Outcome: {f.outcome}
                {f.outcome_detail ? ` (${f.outcome_detail})` : ""} |
                SHA-256: {shortSha(f.sha256)} |{" "}
                {fmtDate(f.fetched_at)}
                {f.decision ? ` | Decided: ${f.decision.decision}` : ""}
              </li>
            ))}
            {decisions.map((d) => (
              <li key={`d-${d.id}`}>
                Decision {d.decision} | Fetch {d.fetch_id} |{" "}
                {fmtDate(d.decided_at)}
                {d.note ? ` | Note: ${d.note}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
};

export default GuidedImagePanel;
