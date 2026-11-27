import React, { useState } from "react";
import { Link } from "react-router-dom";
import { apiGet, apiPost } from "../api/client";
import { useApiData } from "../api/useApiData";
import { ListResponse } from "../api/types";
import Pagination from "../components/Pagination";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { fmtDate } from "../components/helpers";

type Change = { id: number; entity_type: string; entity_id: number; action: string; status: string; before_data: Record<string, unknown>; proposed_data: Record<string, unknown>; reason: string; requested_by_name: string | null; requested_by_uid: string; created_at: string };
type Changes = ListResponse<Change> & { can_approve: boolean; writes_enabled: boolean };
const val = (v: unknown) => v === null || v === undefined || v === "" ? "None" : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);

const CatalogChangesPage: React.FC = () => {
  const [status, setStatus] = useState("pending");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [busy, setBusy] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const { data, loading, error, reload } = useApiData(() => apiGet<Changes>("/catalog/changes", { status, page, page_size: pageSize }), [status, page, pageSize]);
  const decide = async (change: Change, action: "approve" | "reject" | "revert") => {
    if (!window.confirm(`${action === "approve" ? "Apply" : action === "reject" ? "Reject" : "Revert"} request #${change.id}?`)) return;
    setBusy(change.id); setMessage("");
    try { await apiPost(`/catalog/changes/${change.id}/${action}`); setMessage(`Request #${change.id} ${action === "approve" ? "applied" : action === "reject" ? "rejected" : "reverted"}.`); reload(); }
    catch (e) { setMessage(e instanceof Error ? e.message : "The change could not be completed."); }
    finally { setBusy(null); }
  };
  return <div>
    <h1>Catalog changes</h1>
    <p>Review the original and proposed values before approving. Archiving keeps user history and images. A revert stops if the entry has changed since the original request.</p>
    <label htmlFor="catalog-change-status">Status</label>{" "}
    <select id="catalog-change-status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
      <option value="pending">Pending review</option><option value="applied">Applied</option><option value="reverted">Reverted</option><option value="rejected">Rejected</option><option value="">All</option>
    </select>
    {message && <p role="status">{message}</p>}
    {loading && <Loading />}{error && <ErrorState message={error.message} onRetry={reload} />}
    {!loading && !error && data && <>
      {!data.results.length ? <EmptyState message="No catalog changes in this view." /> : data.results.map((change) => <section className="review-section" key={change.id}>
        <h2>#{change.id} · {change.action} · {change.status}</h2>
        <p><Link to={`/admin/catalog/${change.entity_type}/${change.entity_id}`}>{change.entity_type.replace(/_/g, " ")} #{change.entity_id}</Link> · requested by {change.requested_by_name || change.requested_by_uid} · {fmtDate(change.created_at)}</p>
        <p>Reason: {change.reason}</p>
        {change.action === "archive" ? <p>Remove this entry from the active catalog while retaining its relationships.</p> : <dl>{Object.entries(change.proposed_data).map(([key, value]) => <div key={key}><dt>{key.replace(/_/g, " ")}</dt><dd>{val(change.before_data[key])} → {val(value)}</dd></div>)}</dl>}
        {data.can_approve && data.writes_enabled && <div className="decision-actions">
          {change.status === "pending" && <><button className="btn btn-primary" type="button" disabled={busy !== null} onClick={() => void decide(change, "approve")}>Approve</button>{" "}<button className="btn" type="button" disabled={busy !== null} onClick={() => void decide(change, "reject")}>Reject</button></>}
          {change.status === "applied" && <button className="btn" type="button" disabled={busy !== null} onClick={() => void decide(change, "revert")}>Revert</button>}
        </div>}
      </section>)}
      <Pagination page={page} totalPages={data.pagination.total_pages} totalResults={data.pagination.total_results} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(n) => { setPageSize(n); setPage(1); }} />
    </>}
  </div>;
};
export default CatalogChangesPage;
