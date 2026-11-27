import React, { useMemo, useState } from "react";
import {
  CandidateEditableField,
  DiscoveryReviewClient,
  ReviewIntent,
  ReviewIntentRecord,
  buildNewBeerIntent,
  diffCandidateFields,
  httpDiscoveryReviewClient,
  isReviewIntentConflict,
  originalFieldValue,
  validateFieldValue,
  REVIEW_FIELDS,
} from "../../api/discoveryReview";
import { Beer, DiscoveryCandidateDetail } from "../../api/types";
import { fmtDate } from "../helpers";
import HelpTip from "../HelpTip";

// The intent half of the guided review's choices, as a controlled
// component: the page owns the choice state (mode, proposed field
// values, image-only target + confirmation) so the
// approve-for-import flow can read the reviewer's current choice
// and save it as its first step. The editor itself also offers
// "Save review intent only" for reviewers who want the audited
// intent recorded without approving yet - saving an intent never
// selects the candidate.
//
// Field rules are the same as the candidate page's field review
// (shared helpers in api/discoveryReview): staged values are the
// starting point, ABV outside 0-100 is a hard error, an ABV with
// more than 2 decimal places is a warning that is never
// auto-corrected, and image_url is read-only because changing it
// needs an audited refetch design (an approved hash never carries
// over to a new URL). Image-only is never inferred from the staging
// collision detector: the target comes from the match suggestions
// or a manual catalog search, and picking one is not confirming -
// the explicit confirmation step below is always required.

export type GuidedIntentMode = "new_beer" | "image_only";

export interface GuidedTarget {
  id: number;
  name: string;
  breweryName: string | null;
}

const GuidedIntentEditor: React.FC<{
  candidate: DiscoveryCandidateDetail;
  client?: DiscoveryReviewClient;
  savedRecord: ReviewIntentRecord | null;
  mode: GuidedIntentMode | null;
  onModeChange: (mode: GuidedIntentMode) => void;
  proposed: Partial<Record<CandidateEditableField, string>>;
  onProposedChange: (
    next: Partial<Record<CandidateEditableField, string>>
  ) => void;
  target: GuidedTarget | null;
  onTargetChange: (target: GuidedTarget | null) => void;
  targetConfirmed: boolean;
  onTargetConfirmedChange: (confirmed: boolean) => void;
  onIntentSaved?: (record: ReviewIntentRecord) => void;
}> = ({
  candidate,
  client = httpDiscoveryReviewClient,
  savedRecord,
  mode,
  onModeChange,
  proposed,
  onProposedChange,
  target,
  onTargetChange,
  targetConfirmed,
  onTargetConfirmedChange,
  onIntentSaved,
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Beer[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<ReviewIntentRecord | null>(null);
  const currentRecord = lastSaved ?? savedRecord;

  const isPending = candidate.review_status === "pending";
  const controlsDisabled = !isPending || busy || conflict;

  const edits = useMemo(
    () => diffCandidateFields(candidate, proposed),
    [candidate, proposed]
  );
  const fieldIssues = useMemo(() => {
    const issues = new Map<CandidateEditableField, ReturnType<typeof validateFieldValue>>();
    for (const def of REVIEW_FIELDS) {
      if (!def.editable) continue;
      const issue = validateFieldValue(
        def.field,
        proposed[def.field] ?? originalFieldValue(candidate, def.field)
      );
      if (issue) issues.set(def.field, issue);
    }
    return issues;
  }, [candidate, proposed]);
  const hardErrors = Array.from(fieldIssues.values()).filter(
    (i) => i && i.level === "error"
  );

  const runSearch = async () => {
    if (searchQuery.trim() === "") return;
    setSearching(true);
    setSearchError(null);
    try {
      const resp = await client.searchCatalogBeers(searchQuery.trim());
      setSearchResults(Array.isArray(resp?.results) ? resp.results : []);
    } catch (e) {
      setSearchError(
        e instanceof Error ? e.message : "The catalog search failed."
      );
      setSearchResults(null);
    } finally {
      setSearching(false);
    }
  };

  const pickTarget = (beer: Beer) => {
    onTargetChange({
      id: beer.id,
      name: beer.name,
      breweryName: beer.brewery ? beer.brewery.name : null,
    });
    // Picking a result is not the confirmation.
    onTargetConfirmedChange(false);
  };

  const desiredIntent = (): ReviewIntent | null => {
    if (mode === "new_beer") {
      if (hardErrors.length > 0) return null;
      return buildNewBeerIntent(proposed);
    }
    if (mode === "image_only") {
      if (!target || !targetConfirmed) return null;
      return { mode: "image_only", target_beer_id: target.id };
    }
    return null;
  };

  const saveOnly = async () => {
    const intent = desiredIntent();
    setSaveMessage(null);
    setSaveError(null);
    if (!intent) return;
    setBusy(true);
    try {
      const record = await client.saveReviewIntent(
        candidate.id,
        currentRecord ? currentRecord.id : null,
        intent
      );
      setLastSaved(record);
      setSaveMessage(
        `Review intent saved (revision ${record.id}). This does not ` +
          "select the candidate; Approve for import performs the " +
          "remaining steps."
      );
      if (onIntentSaved) onIntentSaved(record);
    } catch (e) {
      if (isReviewIntentConflict(e)) {
        setConflict(true);
      } else {
        setSaveError(
          e instanceof Error ? e.message : "The review intent could not be saved."
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field-review guided-intent-editor">
      {!isPending && (
        <p role="note">
          This candidate is {candidate.review_status}; a review intent
          can be saved only while a candidate is pending, so the
          intent controls are disabled.
          {candidate.review_status === "selected" && " To change this choice, hold the candidate below, then return it to pending."}
          {candidate.review_status === "held" && " Use Return to pending below to change this choice."}
        </p>
      )}
      <p>
        Staging collision detector: dedupe outcome{" "}
        {candidate.dedupe_outcome}
        {candidate.matched_beer_id !== null &&
        candidate.matched_beer_id !== undefined
          ? `, matched catalog beer #${candidate.matched_beer_id}`
          : ", no catalog match"}
        . Staging information only - it never chooses the mode or the
        target for you.
      </p>
      {currentRecord ? (
        <div className="saved-intent-summary" role="status">
          <h3>Saved review intent</h3>
          {currentRecord.intent.mode === "image_only" ? (
            <p>
              Image only for catalog beer #
              {currentRecord.intent.target_beer_id} (revision{" "}
              {currentRecord.id}, saved {fmtDate(currentRecord.created_at)}).
            </p>
          ) : (
            <p>
              New beer: {currentRecord.intent.beer.name} (
              {currentRecord.intent.beer.brewery_name}) (revision{" "}
              {currentRecord.id}, saved {fmtDate(currentRecord.created_at)}).
            </p>
          )}
        </div>
      ) : (
        <p>No review intent saved yet. Choose below; Approve for import saves it as its first step.</p>
      )}
      {conflict && (
        <div className="queue-preview-failed" role="alert">
          This intent changed since you loaded it (the server refused
          the save with a revision conflict, 409). Reload the page to
          see the latest saved intent before saving again; nothing
          was written.
        </div>
      )}

      <fieldset disabled={controlsDisabled} className="intent-form">
        <legend className="visually-hidden">Import choice</legend>
        <div className="mode-picker">
          <div className={mode === "new_beer" ? "mode-option checked" : "mode-option"}>
            <label>
              <input
                type="radio"
                name="guided-intent-mode"
                value="new_beer"
                data-choice="1"
                checked={mode === "new_beer"}
                onChange={() => onModeChange("new_beer")}
              />{" "}
              1. Add new
            </label>
            <span className="mode-desc">
              Import as a new catalog beer with the field values
              below. Existing-beer field updates are not supported:
              this creates a beer, it never edits one.
            </span>
          </div>
          <div className={mode === "image_only" ? "mode-option checked" : "mode-option"}>
            <label>
              <input
                type="radio"
                name="guided-intent-mode"
                value="image_only"
                data-choice="2"
                checked={mode === "image_only"}
                onChange={() => onModeChange("image_only")}
              />{" "}
              2. Add image to existing beer
            </label>
            <span className="mode-desc">
              Attach only this candidate's image to one existing
              catalog beer you choose and confirm. No beer is created
              or changed.
            </span>
          </div>
        </div>

        {mode === "new_beer" && (
          <>
            <div className="field-compare">
              <div className="field-compare-head" aria-hidden="true">
                <div>Field</div>
                <div>Staged (original)</div>
                <div>Proposed</div>
              </div>
              {REVIEW_FIELDS.map((def) => {
                const original = originalFieldValue(candidate, def.field);
                const issue = def.editable
                  ? fieldIssues.get(def.field) ?? null
                  : null;
                const inputId = `guided-field-edit-${def.field}`;
                const issueId = `guided-field-issue-${def.field}`;
                const changed =
                  def.editable && (proposed[def.field] ?? original) !== original;
                return (
                  <div
                    className={changed ? "field-row field-row-changed" : "field-row"}
                    key={def.field}
                  >
                    <div className="field-name">
                      {def.label}
                      {!def.editable && (
                        <span className="field-helper">Read-only</span>
                      )}
                    </div>
                    <div className="field-staged">
                      <span className="field-cell-label">Staged</span>
                      {original === "" ? "None" : original}
                    </div>
                    <div className="field-proposed">
                      <span className="field-cell-label">Proposed</span>
                      {def.editable ? (
                        <>
                          <label className="visually-hidden" htmlFor={inputId}>
                            Proposed {def.label}
                          </label>
                          {def.field === "description" ? (
                            <textarea
                              id={inputId}
                              value={proposed[def.field] ?? original}
                              rows={2}
                              aria-describedby={issue ? issueId : undefined}
                              aria-invalid={issue?.level === "error" || undefined}
                              onChange={(e) =>
                                onProposedChange({
                                  ...proposed,
                                  [def.field]: e.target.value,
                                })
                              }
                            />
                          ) : (
                            <input
                              id={inputId}
                              type="text"
                              value={proposed[def.field] ?? original}
                              aria-describedby={issue ? issueId : undefined}
                              aria-invalid={issue?.level === "error" || undefined}
                              onChange={(e) =>
                                onProposedChange({
                                  ...proposed,
                                  [def.field]: e.target.value,
                                })
                              }
                            />
                          )}
                        </>
                      ) : (
                        <span>
                          Not editable. Changing the image URL needs a
                          separate audited refetch and invalidation
                          design, and an approved image hash never
                          carries over to a new URL.
                        </span>
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
                    </div>
                  </div>
                );
              })}
            </div>
            {fieldIssues.size > 0 && (
              <div
                className={
                  hardErrors.length > 0
                    ? "validation-summary has-errors"
                    : "validation-summary"
                }
                aria-live="polite"
              >
                <strong>
                  {hardErrors.length > 0
                    ? `${hardErrors.length} field error${hardErrors.length === 1 ? "" : "s"} to fix before approving`
                    : "Field warnings to review"}
                  :
                </strong>
                <ul>
                  {REVIEW_FIELDS.filter((def) => fieldIssues.has(def.field)).map(
                    (def) => {
                      const issue = fieldIssues.get(def.field)!;
                      return (
                        <li key={def.field}>
                          {def.label}: {issue!.message}
                        </li>
                      );
                    }
                  )}
                </ul>
              </div>
            )}
            <div aria-live="polite">
              {edits.length === 0 ? (
                <p>
                  No changes staged. Approving records the staged
                  values as the intent (accept as staged), including
                  any warned value exactly as shown.
                </p>
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
          </>
        )}

        {mode === "image_only" && (
          <div>
            <h3>
              Target catalog beer
              <HelpTip topic="image-only target">
                The image-only target is the one existing catalog beer
                this candidate's image will be attached to. Pick from
                the suggestions above or search by name, check the
                beer ID and brewery (several beers can share a name),
                then explicitly confirm the exact target.
              </HelpTip>
            </h3>
            <div>
              <label htmlFor="guided-target-search">
                Search catalog beers by name
              </label>{" "}
              <input
                id="guided-target-search"
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />{" "}
              <button
                type="button"
                onClick={runSearch}
                disabled={searching || searchQuery.trim() === ""}
              >
                Search catalog
              </button>
            </div>
            {searchError && (
              <div className="queue-preview-failed" role="alert">
                {searchError}
              </div>
            )}
            {searchResults !== null &&
              (searchResults.length === 0 ? (
                <p>No catalog beers match that search.</p>
              ) : (
                <ul className="target-results">
                  {searchResults.map((beer) => {
                    const exactMatch =
                      beer.name.trim().toLowerCase() ===
                      searchQuery.trim().toLowerCase();
                    return (
                      <li key={beer.id} className="target-result">
                        <span className="target-result-main">
                          <strong>{beer.name}</strong>{" "}
                          <span className="beer-id">#{beer.id}</span>
                          {beer.brewery
                            ? ` · ${beer.brewery.name}`
                            : " · brewery not recorded"}{" "}
                          <span
                            className={
                              exactMatch
                                ? "match-badge match-badge--exact"
                                : "match-badge match-badge--variant"
                            }
                          >
                            {exactMatch ? "Exact name match" : "Name variant"}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => pickTarget(beer)}
                          disabled={target?.id === beer.id}
                        >
                          {target?.id === beer.id
                            ? "Chosen as target"
                            : "Choose as target"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ))}
            {target ? (
              <div className="target-confirmation">
                <p>
                  Image-only target: catalog beer{" "}
                  <strong>
                    #{target.id}
                    {target.name ? ` - ${target.name}` : ""}
                  </strong>
                  {target.breweryName ? ` (${target.breweryName})` : ""}.
                  The image decision for this candidate will belong to
                  this beer and no other.
                </p>
                {targetConfirmed ? (
                  <p role="status">
                    Target confirmed.{" "}
                    <button
                      type="button"
                      onClick={() => onTargetConfirmedChange(false)}
                    >
                      Change target
                    </button>
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() => onTargetConfirmedChange(true)}
                  >
                    Confirm target beer #{target.id}
                  </button>
                )}
              </div>
            ) : (
              <p>No target beer chosen yet.</p>
            )}
          </div>
        )}

        {mode !== null && (
          <div className="decision-actions">
            <button
              type="button"
              className="btn"
              onClick={saveOnly}
              disabled={controlsDisabled || desiredIntent() === null}
            >
              Save review intent only
            </button>
            <span>
              Optional: records the intent now without approving.
              Approve for import below saves it anyway if it changed.
            </span>
          </div>
        )}
      </fieldset>
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
    </div>
  );
};

export default GuidedIntentEditor;
