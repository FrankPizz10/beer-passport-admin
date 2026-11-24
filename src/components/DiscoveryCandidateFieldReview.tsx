import React, { useMemo, useState } from "react";
import {
  CandidateEditableField,
  DiscoveryReviewClient,
  FieldIssue,
  NotYetAvailableError,
  REVIEW_FIELDS,
  diffCandidateFields,
  httpDiscoveryReviewClient,
  originalFieldValue,
  stagedFieldIssue,
  validateCandidateEdits,
  validateFieldValue,
} from "../api/discoveryReview";
import { DiscoveryCandidateDetail } from "../api/types";

// Field review for one staged candidate: the staged (original) value
// of every reviewable field next to the reviewer's proposed value,
// with a changed-fields diff and inline validation. Saving goes
// through DiscoveryReviewClient.saveFieldEdits, which is a PROPOSED
// endpoint (docs/DISCOVERY_REVIEW_API_CONTRACT.md section B1): until
// Codex ships it, the client throws NotYetAvailableError and this
// section shows the pending-API state. Review decisions (select /
// hold / reject) live on the candidate page and do not depend on
// this capability.
//
// ABV precision is a warning, never a rewrite: a staged ABV like
// 3.2123353678124 is flagged as needing human review in read mode
// and in edit mode, and the value the reviewer sees and submits is
// always exactly the value shown. Nothing here rounds or truncates.

const DiscoveryCandidateFieldReview: React.FC<{
  candidate: DiscoveryCandidateDetail;
  client?: DiscoveryReviewClient;
}> = ({ candidate, client = httpDiscoveryReviewClient }) => {
  const [editing, setEditing] = useState(false);
  const [proposed, setProposed] = useState<
    Partial<Record<CandidateEditableField, string>>
  >({});
  const [attempted, setAttempted] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const edits = useMemo(
    () => diffCandidateFields(candidate, proposed),
    [candidate, proposed]
  );
  const editIssues = useMemo(() => validateCandidateEdits(edits), [edits]);
  const hardErrors = editIssues.filter((i) => i.level === "error");

  const issueFor = (field: CandidateEditableField): FieldIssue | null => {
    // In edit mode, validate what is currently in the input (falling
    // back to the staged original); in read mode, surface only the
    // staged-value warning.
    if (!editing) return stagedFieldIssue(candidate, field);
    const current =
      proposed[field] ?? originalFieldValue(candidate, field);
    return validateFieldValue(field, current);
  };

  const startEditing = () => {
    const initial: Partial<Record<CandidateEditableField, string>> = {};
    for (const def of REVIEW_FIELDS) {
      initial[def.field] = originalFieldValue(candidate, def.field);
    }
    setProposed(initial);
    setAttempted(false);
    setSaveMessage(null);
    setSaveError(null);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setProposed({});
    setAttempted(false);
    setSaveMessage(null);
    setSaveError(null);
  };

  const save = async () => {
    setAttempted(true);
    setSaveMessage(null);
    setSaveError(null);
    if (edits.length === 0 || hardErrors.length > 0) return;
    setBusy(true);
    try {
      await client.saveFieldEdits(candidate.id, edits);
      setSaveMessage("Field edits saved.");
      setEditing(false);
      setProposed({});
    } catch (e) {
      if (e instanceof NotYetAvailableError) {
        setSaveMessage(
          "Saving field edits is pending the review API: the endpoint " +
            "is proposed in docs/DISCOVERY_REVIEW_API_CONTRACT.md " +
            "(section B1) and is not implemented yet. Your staged " +
            "changes above are unchanged and no data was written. " +
            "Selection, hold, and reject decisions remain fully usable."
        );
      } else {
        setSaveError(
          e instanceof Error ? e.message : "The field edits could not be saved."
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="field-review-heading">
      <h2 id="field-review-heading">Field Review</h2>
      <p role="note">
        Field edits are pending the review API (contract section B1).
        You can stage and review changes here; saving is unavailable
        until the endpoint ships. Decisions below are unaffected.
      </p>
      <table className="field-review-table">
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Original (staged)</th>
            <th scope="col">Proposed</th>
          </tr>
        </thead>
        <tbody>
          {REVIEW_FIELDS.map((def) => {
            const original = originalFieldValue(candidate, def.field);
            const issue = issueFor(def.field);
            const inputId = `field-edit-${def.field}`;
            const issueId = `field-issue-${def.field}`;
            return (
              <tr key={def.field}>
                <th scope="row">{def.label}</th>
                <td>{original === "" ? "None" : original}</td>
                <td>
                  {editing ? (
                    <>
                      <label className="visually-hidden" htmlFor={inputId}>
                        Proposed {def.label}
                      </label>
                      <input
                        id={inputId}
                        type="text"
                        value={proposed[def.field] ?? original}
                        aria-describedby={issue ? issueId : undefined}
                        aria-invalid={issue?.level === "error" || undefined}
                        onChange={(e) =>
                          setProposed((prev) => ({
                            ...prev,
                            [def.field]: e.target.value,
                          }))
                        }
                      />
                    </>
                  ) : (
                    original === "" ? "None" : original
                  )}
                  {issue && (
                    <p
                      id={issueId}
                      className={
                        issue.level === "error"
                          ? "field-issue-error"
                          : "field-issue-warning"
                      }
                      aria-live="polite"
                    >
                      {issue.level === "error" ? "Error: " : "Warning: "}
                      {issue.message}
                    </p>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {editing ? (
        <>
          <div aria-live="polite">
            {edits.length === 0 ? (
              <p>No changes staged.</p>
            ) : (
              <>
                <h3>Changed fields ({edits.length})</h3>
                <ul>
                  {edits.map((edit) => (
                    <li key={edit.field}>
                      {REVIEW_FIELDS.find((f) => f.field === edit.field)?.label}
                      : {edit.original === "" ? "None" : edit.original}
                      {" -> "}
                      {edit.proposed === "" ? "None" : edit.proposed}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          {attempted && hardErrors.length > 0 && (
            <div role="alert">
              Fix the field errors above before saving.
            </div>
          )}
          <div className="decision-actions">
            <button
              type="button"
              onClick={save}
              disabled={busy || edits.length === 0}
            >
              Save field edits
            </button>
            <button type="button" onClick={cancelEditing} disabled={busy}>
              Cancel editing
            </button>
          </div>
        </>
      ) : (
        <div className="decision-actions">
          <button type="button" onClick={startEditing}>
            Edit fields
          </button>
        </div>
      )}
      {saveMessage && (
        <p className="field-review-save-state" role="status">
          {saveMessage}
        </p>
      )}
      {saveError && (
        <div className="queue-preview-failed" role="alert">
          {saveError}
        </div>
      )}
    </section>
  );
};

export default DiscoveryCandidateFieldReview;
