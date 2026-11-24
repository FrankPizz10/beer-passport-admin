import React, { useEffect, useMemo, useState } from "react";
import {
  CandidateEditableField,
  DiscoveryReviewClient,
  FieldIssue,
  ReviewIntent,
  ReviewIntentRecord,
  buildNewBeerIntent,
  diffCandidateFields,
  httpDiscoveryReviewClient,
  isReviewIntentConflict,
  originalFieldValue,
  proposedFromIntentBeer,
  validateFieldValue,
  REVIEW_FIELDS,
} from "../api/discoveryReview";
import { Beer, DiscoveryCandidateDetail } from "../api/types";
import { useApiData } from "../api/useApiData";
import { fmtDate } from "./helpers";
import HelpTip from "./HelpTip";
import { Loading } from "./States";

// Review intent for one staged candidate (contract section B1):
// the reviewer records WHAT should be imported for the candidate -
// a new beer built from confirmed field values, or an image for one
// existing catalog beer they explicitly chose - as an audited
// server-side snapshot. Saving an intent is DISTINCT from the
// select / hold / reject decision on the candidate page: neither
// action implies the other.
//
// The form starts from the STAGED values (accept as-is) with
// per-field editing; saving posts a new_beer intent carrying all
// seven beer fields. Image-only is NEVER inferred from the staging
// collision detector: matched_beer_id and the dedupe outcome are
// shown as staging information only, and the image-only mode always
// requires the reviewer to search for, pick, and explicitly confirm
// the target catalog beer (including when the detector reported
// no_match, e.g. the staged Bud Light in production).
//
// image_url is not editable: changing it needs a separate audited
// refetch and invalidation design, and an approved image hash never
// carries over to a new URL. It is shown read-only and is not part
// of the intent payload.
//
// Revision handling: the saved intent's id is the revision token.
// Saving sends it back as expected_revision (null when no intent
// exists); a 409 means someone else saved first, and this section
// switches to a reload-required state instead of overwriting.
// Server errors are shown with the server's own message.

type IntentMode = "new_beer" | "image_only";

interface TargetBeer {
  id: number;
  name: string;
  breweryName: string | null;
}

// Defensive shape check on the GET response: anything that is not a
// well-formed intent record is treated as "no intent saved".
const asIntentRecord = (data: unknown): ReviewIntentRecord | null => {
  if (!data || typeof data !== "object") return null;
  const record = data as ReviewIntentRecord;
  if (typeof record.id !== "number" || !record.intent) return null;
  if (
    record.intent.mode !== "new_beer" &&
    record.intent.mode !== "image_only"
  ) {
    return null;
  }
  return record;
};

const stagedValues = (
  candidate: DiscoveryCandidateDetail
): Partial<Record<CandidateEditableField, string>> => {
  const values: Partial<Record<CandidateEditableField, string>> = {};
  for (const def of REVIEW_FIELDS) {
    if (def.editable) values[def.field] = originalFieldValue(candidate, def.field);
  }
  return values;
};

const DiscoveryCandidateFieldReview: React.FC<{
  candidate: DiscoveryCandidateDetail;
  client?: DiscoveryReviewClient;
  onIntentSaved?: () => void;
}> = ({ candidate, client = httpDiscoveryReviewClient, onIntentSaved }) => {
  const [loadTick, setLoadTick] = useState(0);
  const {
    data: intentData,
    loading: intentLoading,
    error: intentError,
    reload: reloadIntent,
  } = useApiData(
    () => client.getReviewIntent(candidate.id),
    [candidate.id, loadTick]
  );
  const loadedRecord = useMemo(() => asIntentRecord(intentData), [intentData]);
  // The latest record this session knows about: the loaded one, or
  // the response of a save performed here.
  const [savedRecord, setSavedRecord] = useState<ReviewIntentRecord | null>(
    null
  );
  const [recordKnown, setRecordKnown] = useState(false);
  const currentRecord = recordKnown ? savedRecord : loadedRecord;

  const isPending = candidate.review_status === "pending";

  const [mode, setMode] = useState<IntentMode>("new_beer");
  const [proposed, setProposed] = useState<
    Partial<Record<CandidateEditableField, string>>
  >({});
  const [targetBeer, setTargetBeer] = useState<TargetBeer | null>(null);
  const [targetConfirmed, setTargetConfirmed] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Beer[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [seededKey, setSeededKey] = useState<string | null>(null);
  // The form is interactive only after seeding: until the saved
  // intent is known, the reviewer could type into a form that the
  // seed would then overwrite (and a save could go out against an
  // unknown revision). The section renders a loading state instead.
  const [seeded, setSeeded] = useState(false);

  // Seed the form whenever a (re)load settles: from the saved
  // intent when one exists (it is the current proposed state), else
  // from the staged values.
  useEffect(() => {
    if (intentLoading) return;
    const key = `${candidate.id}|${loadTick}|${loadedRecord?.id ?? "none"}`;
    if (seededKey === key) return;
    setSeededKey(key);
    setSeeded(true);
    setSavedRecord(loadedRecord);
    setRecordKnown(true);
    setConflict(false);
    setAttempted(false);
    if (loadedRecord?.intent.mode === "image_only") {
      setMode("image_only");
      setProposed(stagedValues(candidate));
      setTargetBeer({
        id: loadedRecord.intent.target_beer_id,
        name: "",
        breweryName: null,
      });
      setTargetConfirmed(true);
    } else if (loadedRecord?.intent.mode === "new_beer") {
      setMode("new_beer");
      setProposed(proposedFromIntentBeer(loadedRecord.intent.beer));
      setTargetBeer(null);
      setTargetConfirmed(false);
    } else {
      setMode("new_beer");
      setProposed(stagedValues(candidate));
      setTargetBeer(null);
      setTargetConfirmed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentLoading, loadedRecord, loadTick, candidate.id]);

  // Resolve the name of a target beer seeded from a saved intent
  // (the form only stored its id).
  useEffect(() => {
    if (targetBeer && targetBeer.name === "") {
      let cancelled = false;
      client
        .getCatalogBeer(targetBeer.id)
        .then((beer) => {
          if (!cancelled) {
            setTargetBeer({
              id: beer.id,
              name: beer.name,
              breweryName: beer.brewery ? beer.brewery.name : null,
            });
          }
        })
        .catch(() => {
          // The id alone still identifies the target; the summary
          // and confirmation render it without the name.
        });
      return () => {
        cancelled = true;
      };
    }
  }, [targetBeer, client]);

  const edits = useMemo(
    () => diffCandidateFields(candidate, proposed),
    [candidate, proposed]
  );

  const fieldIssues = useMemo(() => {
    const issues = new Map<CandidateEditableField, FieldIssue>();
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
    (i) => i.level === "error"
  );

  const reloadAll = () => {
    setSavedRecord(null);
    setRecordKnown(false);
    setSeededKey(null);
    setSeeded(false);
    setSaveMessage(null);
    setSaveError(null);
    setLoadTick((t) => t + 1);
    reloadIntent();
  };

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
    setTargetBeer({
      id: beer.id,
      name: beer.name,
      breweryName: beer.brewery ? beer.brewery.name : null,
    });
    // Picking a search result is not the confirmation: the reviewer
    // must still explicitly confirm this beer as the target.
    setTargetConfirmed(false);
  };

  const save = async () => {
    setAttempted(true);
    setSaveMessage(null);
    setSaveError(null);
    if (conflict) return;
    let intent: ReviewIntent;
    if (mode === "new_beer") {
      if (hardErrors.length > 0) return;
      intent = buildNewBeerIntent(proposed);
    } else {
      if (!targetBeer || !targetConfirmed) return;
      intent = { mode: "image_only", target_beer_id: targetBeer.id };
    }
    setBusy(true);
    try {
      const record = await client.saveReviewIntent(
        candidate.id,
        currentRecord ? currentRecord.id : null,
        intent
      );
      setSavedRecord(record);
      setRecordKnown(true);
      setSaveMessage(
        `Review intent saved (revision ${record.id}). Saving an ` +
          "intent does not select this candidate; selection is the " +
          "separate decision below."
      );
      if (onIntentSaved) onIntentSaved();
    } catch (e) {
      if (isReviewIntentConflict(e)) {
        setConflict(true);
      } else {
        // The server's own message, preserved by the client.
        setSaveError(
          e instanceof Error
            ? e.message
            : "The review intent could not be saved."
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const controlsDisabled = !isPending || busy || conflict;

  return (
    <div className="field-review">
      <p role="note">
        A review intent records what should be imported for this
        candidate, as an audited snapshot saved on the server (the
        server keeps the original staged payload). It is separate
        from the Select / Hold / Reject decision in step 4: saving
        an intent does not select the candidate, and selecting does
        not create an intent. If the server refuses a save, its own
        error message is shown here.
      </p>
      {!isPending && (
        <p role="note">
          Review intent can be saved only while the candidate is
          pending. This candidate is {candidate.review_status}, so
          the intent controls are disabled.
        </p>
      )}
      <p>
        Staging collision detector: dedupe outcome{" "}
        {candidate.dedupe_outcome}
        {candidate.matched_beer_id !== null &&
        candidate.matched_beer_id !== undefined
          ? `, matched catalog beer #${candidate.matched_beer_id}`
          : ", no catalog match"}
        . This is staging information only; it does not choose the
        review mode or the image-only target.
      </p>

      {intentLoading ? (
        <Loading />
      ) : intentError ? (
        <div className="queue-preview-failed" role="alert">
          The saved review intent could not be loaded: {intentError.message}{" "}
          <button type="button" onClick={reloadAll}>
            Retry
          </button>
        </div>
      ) : currentRecord ? (
        <div className="saved-intent-summary" role="status">
          <h3>Saved review intent</h3>
          {currentRecord.intent.mode === "image_only" ? (
            <p>
              Image only for catalog beer #
              {currentRecord.intent.target_beer_id} (revision{" "}
              {currentRecord.id}, saved {fmtDate(currentRecord.created_at)}).
              Saving again replaces it.
            </p>
          ) : (
            <p>
              New beer: {currentRecord.intent.beer.name} (
              {currentRecord.intent.beer.brewery_name}) (revision{" "}
              {currentRecord.id}, saved {fmtDate(currentRecord.created_at)}).
              Saving again replaces it.
            </p>
          )}
        </div>
      ) : (
        <p>No review intent saved yet.</p>
      )}

      {!seeded || intentLoading ? (
        <Loading />
      ) : (
        <>
      {conflict && (
        <div className="queue-preview-failed" role="alert">
          <p>
            This intent changed since you loaded it (the server
            refused the save with a revision conflict, 409). Reload
            to see the latest saved intent before saving again; your
            form entries were not written.
          </p>
          <button type="button" onClick={reloadAll}>
            Reload review intent
          </button>
        </div>
      )}

      <fieldset disabled={controlsDisabled} className="intent-form">
        <legend>Intent mode</legend>
        <div className="mode-picker">
          <div
            className={
              mode === "new_beer" ? "mode-option checked" : "mode-option"
            }
          >
            <label>
              <input
                type="radio"
                name="review-intent-mode"
                value="new_beer"
                checked={mode === "new_beer"}
                onChange={() => setMode("new_beer")}
              />{" "}
              New beer
            </label>
            <span className="mode-desc">
              Import this candidate as a new catalog beer, using the
              field values below.
            </span>
          </div>
          <div
            className={
              mode === "image_only" ? "mode-option checked" : "mode-option"
            }
          >
            <label>
              <input
                type="radio"
                name="review-intent-mode"
                value="image_only"
                checked={mode === "image_only"}
                onChange={() => setMode("image_only")}
              />{" "}
              Image only for an existing beer
            </label>
            <span className="mode-desc">
              Attach only this candidate's image to one existing
              catalog beer you choose and confirm. No beer is created
              or changed.
            </span>
          </div>
        </div>

        {mode === "new_beer" ? (
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
                const inputId = `field-edit-${def.field}`;
                const issueId = `field-issue-${def.field}`;
                const changed =
                  def.editable &&
                  (proposed[def.field] ?? original) !== original;
                return (
                  <div
                    className={
                      changed ? "field-row field-row-changed" : "field-row"
                    }
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
                          <label
                            className="visually-hidden"
                            htmlFor={inputId}
                          >
                            Proposed {def.label}
                          </label>
                          {def.field === "description" ? (
                            <textarea
                              id={inputId}
                              value={proposed[def.field] ?? original}
                              rows={2}
                              aria-describedby={issue ? issueId : undefined}
                              aria-invalid={
                                issue?.level === "error" || undefined
                              }
                              onChange={(e) =>
                                setProposed((prev) => ({
                                  ...prev,
                                  [def.field]: e.target.value,
                                }))
                              }
                            />
                          ) : (
                            <input
                              id={inputId}
                              type="text"
                              value={proposed[def.field] ?? original}
                              aria-describedby={issue ? issueId : undefined}
                              aria-invalid={
                                issue?.level === "error" || undefined
                              }
                              onChange={(e) =>
                                setProposed((prev) => ({
                                  ...prev,
                                  [def.field]: e.target.value,
                                }))
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
                    ? `${hardErrors.length} field error${
                        hardErrors.length === 1 ? "" : "s"
                      } to fix before saving`
                    : "Field warnings to review"}
                  :
                </strong>
                <ul>
                  {REVIEW_FIELDS.filter((def) => fieldIssues.has(def.field)).map(
                    (def) => {
                      const issue = fieldIssues.get(def.field)!;
                      return (
                        <li key={def.field}>
                          {def.label}: {issue.message}
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
                  No changes staged. Saving now records the staged
                  values as the intent (accept as staged), including
                  any warned value exactly as shown.
                </p>
              ) : (
                <>
                  <h3>Changed fields ({edits.length})</h3>
                  <ul>
                    {edits.map((edit) => (
                      <li key={edit.field}>
                        {
                          REVIEW_FIELDS.find((f) => f.field === edit.field)
                            ?.label
                        }
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
          </>
        ) : (
          <div>
            <h3>
              Target catalog beer
              <HelpTip topic="image-only target">
                The image-only target is the one existing catalog beer
                this candidate's image will be attached to. Search by
                name, check the beer ID and brewery (several beers can
                share a name), then explicitly confirm the exact
                target before saving.
              </HelpTip>
            </h3>
            <p>
              Search the catalog and pick the beer this candidate's
              image belongs to. The staging collision detector does
              not choose this target, and a target can be found even
              when the detector reported no match. Results marked
              "Name variant" share part of the name but are different
              beers; check the ID and brewery before choosing.
            </p>
            <div>
              <label htmlFor="intent-target-search">
                Search catalog beers by name
              </label>{" "}
              <input
                id="intent-target-search"
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
                          disabled={targetBeer?.id === beer.id}
                        >
                          {targetBeer?.id === beer.id
                            ? "Chosen as target"
                            : "Choose as target"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ))}
            {targetBeer ? (
              <div className="target-confirmation">
                <p>
                  Image-only target: catalog beer{" "}
                  <strong>
                    #{targetBeer.id}
                    {targetBeer.name ? ` - ${targetBeer.name}` : ""}
                  </strong>
                  {targetBeer.breweryName
                    ? ` (${targetBeer.breweryName})`
                    : ""}
                  . The image decision for this candidate will belong
                  to this beer and no other.
                </p>
                {targetConfirmed ? (
                  <p role="status">
                    Target confirmed.{" "}
                    <button
                      type="button"
                      onClick={() => setTargetConfirmed(false)}
                    >
                      Change target
                    </button>
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() => setTargetConfirmed(true)}
                  >
                    Confirm target beer #{targetBeer.id}
                  </button>
                )}
              </div>
            ) : (
              <p>No target beer chosen yet.</p>
            )}
            {attempted && (!targetBeer || !targetConfirmed) && (
              <div role="alert">
                Choose a target catalog beer and confirm it before
                saving an image-only intent.
              </div>
            )}
          </div>
        )}

        <div className="decision-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={
              controlsDisabled ||
              (mode === "image_only" && (!targetBeer || !targetConfirmed))
            }
          >
            {mode === "new_beer"
              ? "Save review intent (new beer)"
              : "Save review intent (image only)"}
          </button>
        </div>
      </fieldset>
        </>
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
    </div>
  );
};

export default DiscoveryCandidateFieldReview;
