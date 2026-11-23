import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet, apiPost, ApiError } from "../api/client";
import { useApiData } from "../api/useApiData";
import {
  ImageQueueItem,
  ImageReviewDecision,
  ListResponse,
  PresignedImageResponse,
} from "../api/types";
import { ErrorState, Loading } from "../components/States";
import { fmtDate, fmtVal } from "../components/helpers";

// Image approval queue. The preview IS the quality gate: an Approve
// button stays disabled until the candidate's image has actually
// loaded in this reviewer's browser, so nobody can approve an image
// they have not seen (the stored checks already refuse, server-side,
// any candidate whose source URL did not verify as a direct image).
// Private candidates are previewed through the API's presigned
// preview-url endpoint; the storage key never reaches the client.

type PreviewState = "waiting" | "loaded" | "failed";

const checkBadge = (item: ImageQueueItem): { text: string; bad: boolean } => {
  switch (item.source_check_status) {
    case "image":
      return {
        text: `Source verified: direct image${item.source_content_type ? ` (${item.source_content_type})` : ""}`,
        bad: false,
      };
    case "not_image":
      return {
        text: "Source check: NOT a direct image (a web page or other content answered)",
        bad: true,
      };
    case "unreachable":
      return { text: "Source check: URL was unreachable when checked", bad: true };
    default:
      return { text: "Source not checked (private image; preview is the check)", bad: false };
  }
};

const QueueCard: React.FC<{
  item: ImageQueueItem;
  onDecided: (item: ImageQueueItem) => void;
}> = ({ item, onDecided }) => {
  const [previewUrl, setPreviewUrl] = useState<string | null>(item.image_url);
  const [previewState, setPreviewState] = useState<PreviewState>("waiting");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (item.image_url) return; // hosted: the <img> events drive the state
    if (!item.has_private_image) {
      setPreviewState("failed");
      return;
    }
    let cancelled = false;
    apiGet<PresignedImageResponse>(`/images/${item.id}/preview-url`)
      .then((res) => {
        if (!cancelled) setPreviewUrl(res.url);
      })
      .catch(() => {
        if (!cancelled) setPreviewState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, item.image_url, item.has_private_image]);

  const decide = async (action: "approve" | "reject") => {
    setBusy(true);
    setActionError(null);
    try {
      await apiPost(`/images/${item.id}/${action}`, note.trim() ? { note: note.trim() } : {});
      onDecided(item);
    } catch (e) {
      // A 409 means another admin already decided this row; it no
      // longer belongs in the queue either way.
      if (e instanceof ApiError && e.status === 409) {
        onDecided(item);
        return;
      }
      setBusy(false);
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const badge = checkBadge(item);
  const beerName = item.beverage?.name || `Beverage ${item.beverage_id}`;

  return (
    <div className="queue-card">
      <div className="queue-card-main">
        <div className="queue-preview">
          {previewUrl ? (
            <img
              className="beer-image"
              src={previewUrl}
              alt={`Candidate for ${beerName}`}
              onLoad={() => setPreviewState("loaded")}
              onError={() => setPreviewState("failed")}
            />
          ) : previewState === "failed" ? null : (
            <div className="state-box">Loading preview...</div>
          )}
          {previewState === "failed" && (
            <div className="queue-preview-failed" role="alert">
              Image failed to load. You cannot approve an image you cannot see;
              reject it, or have the candidate reloaded with a working source.
            </div>
          )}
        </div>
        <div className="queue-meta">
          <div>
            <Link to={`/admin/catalog/beers/${item.beverage_id}`}>{beerName}</Link>
            {item.brewery ? <span> — {item.brewery.name}</span> : null}
          </div>
          <span className={`chip check-badge${badge.bad ? " check-badge-bad" : ""}`}>
            {badge.text}
          </span>
          <div>Source type: {fmtVal(item.source_type)}</div>
          <div>
            Source page:{" "}
            {item.source_url ? (
              <a href={item.source_url} target="_blank" rel="noreferrer">
                {item.source_url}
              </a>
            ) : (
              "None"
            )}
          </div>
          <div>License: {fmtVal(item.license_type)}</div>
          <div>Attribution: {fmtVal(item.attribution)}</div>
          {item.license_url ? (
            <div>
              License URL:{" "}
              <a href={item.license_url} target="_blank" rel="noreferrer">
                {item.license_url}
              </a>
            </div>
          ) : null}
          <div>Loaded as candidate #{item.id} on {fmtDate(item.created_at)}</div>
          <div className="queue-actions">
            <input
              aria-label={`Decision note for image ${item.id}`}
              placeholder="Decision note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button
              type="button"
              disabled={busy || previewState !== "loaded"}
              onClick={() => decide("approve")}
            >
              Approve
            </button>
            <button type="button" disabled={busy} onClick={() => decide("reject")}>
              Reject
            </button>
          </div>
          {previewState !== "loaded" && previewState !== "failed" && (
            <div className="note">Approve unlocks once the image above has loaded.</div>
          )}
          {actionError && (
            <div className="queue-preview-failed" role="alert">
              {actionError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const ImageQueuePage: React.FC = () => {
  const queue = useApiData(
    () => apiGet<ListResponse<ImageQueueItem>>("/images/queue", { page_size: 100 }),
    []
  );
  const decisions = useApiData(
    () => apiGet<ListResponse<ImageReviewDecision>>("/images/decisions", { page_size: 25 }),
    []
  );
  const [items, setItems] = useState<ImageQueueItem[]>([]);

  useEffect(() => {
    if (queue.data) setItems(queue.data.results);
  }, [queue.data]);

  const handleDecided = (item: ImageQueueItem) => {
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    decisions.reload();
  };

  if (queue.error && !queue.loading) {
    return <ErrorState message={queue.error.message} onRetry={queue.reload} />;
  }

  return (
    <div>
      <h1>Image Queue</h1>
      <p className="note">
        Pending image candidates. Approving makes the image appear in the catalog for
        that beverage; every decision is recorded with who made it and when. Check
        that the preview shows the correct product at usable quality before
        approving: the Approve button unlocks only after the image has loaded here.
      </p>
      {queue.loading && !queue.data ? (
        <Loading />
      ) : items.length === 0 ? (
        <div className="state-box">
          No pending image candidates. New candidates arrive through the candidate
          loader and appear here for review.
        </div>
      ) : (
        <div className="queue-list">
          {items.map((item) => (
            <QueueCard key={item.id} item={item} onDecided={handleDecided} />
          ))}
        </div>
      )}

      <h2>Recent decisions</h2>
      {decisions.loading && !decisions.data ? (
        <Loading />
      ) : decisions.error ? (
        <ErrorState message={decisions.error.message} onRetry={decisions.reload} />
      ) : !decisions.data || decisions.data.results.length === 0 ? (
        <div className="state-box">No decisions recorded yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Decision</th>
                <th>Image</th>
                <th>Beverage</th>
                <th>Decided by</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {decisions.data.results.map((d) => (
                <tr key={d.id}>
                  <td>{fmtDate(d.created_at)}</td>
                  <td>{d.action === "approve" ? "Approved" : "Rejected"}</td>
                  <td>#{d.beverage_image_id}</td>
                  <td>
                    <Link to={`/admin/catalog/beers/${d.beverage_id}`}>{d.beverage_id}</Link>
                  </td>
                  <td>{d.admin_user_name || (d.admin_user_id ? `User ${d.admin_user_id}` : "Unknown")}</td>
                  <td>{fmtVal(d.note)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default ImageQueuePage;
