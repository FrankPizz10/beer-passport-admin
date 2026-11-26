import React, { useState } from "react";
import { apiGet, apiPost } from "../api/client";
import { useApiData } from "../api/useApiData";
import { ErrorState, Loading } from "../components/States";
import { fmtDate } from "../components/helpers";

type AdminAccount = { uid: string; email: string; user_name: string; granted_at: string };
type Accounts = { results: AdminAccount[]; owner: { uid: string; email: string | null; user_name: string | null }; writes_enabled: boolean };
type AccessEvent = { id: string; actor_uid: string; actor_name: string | null; target_uid: string; target_email: string | null; action: string; occurred_at: string };
type Events = { results: AccessEvent[] };

const AdminAccountsPage: React.FC = () => {
  const { data, loading, error, reload } = useApiData(() => apiGet<Accounts>("/admin/accounts"), []);
  const events = useApiData(() => apiGet<Events>("/admin/access-events", { page_size: 25 }), []);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  const change = async (action: "grant" | "revoke", value: string, label: string) => {
    if (!window.confirm(`${action === "grant" ? "Grant admin access to" : "Revoke admin access from"} ${label}?`)) return;
    setBusy(true); setMessage("");
    try {
      if (action === "grant") await apiPost("/admin/accounts", { email: value });
      else await apiPost(`/admin/accounts/${encodeURIComponent(value)}/revoke`);
      setEmail(""); setMessage(action === "grant" ? "Admin access granted." : "Admin access revoked.");
      reload(); events.reload();
    } catch (e) { setMessage(e instanceof Error ? e.message : "Access change failed."); }
    finally { setBusy(false); }
  };
  return <div>
    <h1>Admin Accounts</h1>
    <p>Only the owner can manage access. The person needs a Firebase account with a verified email and an existing app profile.</p>
    {!data?.writes_enabled && <p role="alert">Access changes are not configured. Contact the operator.</p>}
    <form onSubmit={(e) => { e.preventDefault(); if (email.trim()) void change("grant", email.trim(), email.trim()); }}>
      <label htmlFor="grant-email">Account email</label>{" "}
      <input id="grant-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />{" "}
      <button className="btn btn-primary" type="submit" disabled={busy || !data?.writes_enabled}>Grant admin access</button>
    </form>
    {message && <p role="status">{message}</p>}
    <h2>Current admins</h2>
    <p>Owner: {data?.owner?.email || data?.owner?.user_name || "Configured owner"} (cannot be revoked here).</p>
    {data?.results.length ? <ul>{data.results.map((account) => <li key={account.uid}>
      {account.email} ({account.user_name}) · Granted {fmtDate(account.granted_at)}{" "}
      <button className="btn" type="button" disabled={busy || !data.writes_enabled} onClick={() => void change("revoke", account.uid, account.email)}>Revoke</button>
    </li>)}</ul> : <p>No additional admins.</p>}
    <h2>Recent access changes</h2>
    {events.loading && <Loading />}
    {events.error && <ErrorState message={events.error.message} onRetry={events.reload} />}
    {events.data && (events.data.results.length ? <ul>{events.data.results.map((event) => <li key={event.id}>
      {fmtDate(event.occurred_at)} · {event.action} · account {event.target_email || event.target_uid} · by {event.actor_name || event.actor_uid}
    </li>)}</ul> : <p>No access changes recorded.</p>)}
  </div>;
};
export default AdminAccountsPage;
