import React, { useState } from "react";
import { Link } from "react-router-dom";
import { apiGet, apiPost } from "../api/client";
import { useApiData } from "../api/useApiData";
import { ErrorState, Loading } from "./States";

type Entity = "beers" | "breweries" | "categories" | "styles";
type Field = { type: "text" | "number" | "integer" | "boolean"; nullable?: boolean; max?: number; min?: number; routine?: boolean };
type Options = { fields: Record<string, Field>; current: Record<string, unknown>; version: string; writes_enabled: boolean; archive_enabled: boolean };
const LABELS: Record<string, string> = { cat_id: "Category ID", style_id: "Style ID", brewery_id: "Brewery ID", cat_name: "Category name", style_name: "Style name", upc: "Barcode", abv: "ABV", ibu: "IBU", srm: "SRM", descript: "Description", address1: "Address line 1", address2: "Address line 2", code: "Postal code" };
const label = (key: string) => LABELS[key] || key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

const CatalogEditor: React.FC<{ entity: Entity; id: string; onChanged: () => void }> = ({ entity, id, onChanged }) => {
  const { data, loading, error, reload } = useApiData(() => apiGet<Options>(`/catalog/change-options/${entity}/${id}`), [entity, id]);
  const [edits, setEdits] = useState<Record<string, string | boolean>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data || !data.fields || !data.current) return <p>Catalog editing is not available yet.</p>;
  const changes: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(edits)) {
    const f = data.fields[key];
    if (!f) continue;
    let value: unknown = raw;
    if (typeof raw === "string" && raw.trim() === "" && f.nullable) value = null;
    else if ((f.type === "number" || f.type === "integer") && typeof raw === "string") value = raw.trim() === "" ? null : Number(raw);
    if (value !== data.current[key]) changes[key] = value;
  }
  const needsReview = Object.keys(changes).some((key) => !data.fields[key].routine);
  const submit = async (action: "edit" | "archive") => {
    if (!reason.trim()) { setMessage("Enter a reason for this change."); return; }
    if (action === "edit" && !Object.keys(changes).length) { setMessage("Change at least one field."); return; }
    if (action === "archive" && !window.confirm("Request archiving this catalog entry? User history and images stay attached. The owner must approve.")) return;
    setBusy(true); setMessage("");
    try {
      const result = await apiPost<{ status: string; id: number }>(`/catalog/change-options/${entity}/${id}/requests`, { action, version: data.version, changes, reason: reason.trim() });
      setEdits({}); setReason("");
      setMessage(result.status === "applied" ? "Change saved and recorded in the audit." : `Request #${result.id} is waiting for owner approval.`);
      reload(); if (result.status === "applied") onChanged();
    } catch (e) { setMessage(e instanceof Error ? e.message : "Could not save the change."); }
    finally { setBusy(false); }
  };
  return <section className="review-section">
    <h2>Change this catalog entry</h2>
    <p>Descriptions and contact details save immediately. Names, classification, product details and archiving require owner review. All changes are recorded and can be reverted when the entry has not changed again.</p>
    <p><Link to="/admin/catalog/changes">View change requests and history</Link></p>
    {!data.writes_enabled && <p role="alert">Catalog changes are not configured.</p>}
    {data.writes_enabled && !data.archive_enabled && <p>Archiving is unavailable until the app supports archived entries.</p>}
    {Boolean(data.current.archived_at) && <p role="status">This entry is archived. An owner can restore it from change history.</p>}
    <details><summary>Edit fields</summary>
      <p>For related brewery, category and style IDs, use the ID shown on the corresponding catalog page. Leave an optional ID blank to clear it.</p>
      <div className="detail-grid">{Object.entries(data.fields).map(([key, field]) => {
        const original = data.current[key];
        const value = edits[key] ?? (field.type === "boolean" ? Boolean(original) : String(original ?? ""));
        return <div key={key}><label htmlFor={`catalog-edit-${key}`}>{label(key)}{!field.routine && " (owner review)"}</label>{" "}
          {field.type === "boolean" ? <input id={`catalog-edit-${key}`} type="checkbox" checked={Boolean(value)} onChange={(e) => setEdits({ ...edits, [key]: e.target.checked })} /> :
          <input id={`catalog-edit-${key}`} type={field.type === "text" ? "text" : "number"} step={field.type === "number" ? "any" : undefined} min={field.type !== "text" ? field.min : undefined} max={field.type !== "text" ? field.max : undefined} maxLength={field.type === "text" ? field.max : undefined} value={String(value)} onChange={(e) => setEdits({ ...edits, [key]: e.target.value })} />}
        </div>;
      })}</div>
    </details>
    <p><label htmlFor="catalog-change-reason">Reason</label>{" "}<input id="catalog-change-reason" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} /></p>
    <div className="decision-actions">
      <button className="btn btn-primary" type="button" disabled={busy || !data.writes_enabled || Boolean(data.current.archived_at)} onClick={() => void submit("edit")}>{needsReview ? "Request owner review" : "Save changes"}</button>{" "}
      <button className="btn btn-danger" type="button" disabled={busy || !data.writes_enabled || !data.archive_enabled || Boolean(data.current.archived_at)} onClick={() => void submit("archive")}>Request archive</button>
    </div>
    {message && <p role="status">{message}</p>}
  </section>;
};
export default CatalogEditor;
