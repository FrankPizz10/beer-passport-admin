import React, { useEffect, useState } from "react";
import {
  DiscoveryReviewClient,
  MatchSuggestion,
  MatchSuggestions,
  evidenceLabel,
  httpDiscoveryReviewClient,
  isMatchSuggestionsUnavailable,
  suggestionsSearchComplete,
} from "../../api/discoveryReview";
import HelpTip from "../HelpTip";

// Ranked catalog match suggestions for one candidate (WS1 contract:
// GET /discovery/candidates/:id/match-suggestions). Suggestions are
// evidence for the reviewer, never a decision: nothing here selects
// a target. "Use as image-only target" hands the beer to the intent
// editor, where the reviewer must still explicitly confirm it.
// When the endpoint is not deployed yet (404) the panel collapses
// to a short note and the manual catalog search in the intent
// editor is the only path - the panel never blocks the review.
//
// HONESTY RULE: the suggestions search is bounded. It retrieves a
// candidate pool by literal tokens before scoring, so it can miss
// a real match - including a catalog name that shares no searchable
// token with the staged name (a typo can do that). Finding no
// suggestion is therefore never presented as proof the beer is new,
// and manual search is described as another bounded lookup, not a
// confirmation. The "may miss matches" note shows unless the
// response affirmatively reports a complete catalog search under
// the corrected completeness semantics (see discoveryReview.ts);
// the legacy exhaustive flag alone never suppresses it.

export interface SuggestionTarget {
  id: number;
  name: string;
  breweryName: string | null;
}

const formatScore = (score: number): string =>
  score <= 1 ? `${Math.round(score * 100)}%` : String(score);

const MatchSuggestionsPanel: React.FC<{
  candidateId: number;
  client?: DiscoveryReviewClient;
  // A suggestions response obtained earlier (e.g. prefetched); when
  // present the panel renders it without a new request.
  initialData?: MatchSuggestions | null;
  onUseTarget: (target: SuggestionTarget) => void;
}> = ({ candidateId, client = httpDiscoveryReviewClient, initialData, onUseTarget }) => {
  const [data, setData] = useState<MatchSuggestions | null>(
    initialData ?? null
  );
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initialData);

  useEffect(() => {
    if (initialData) {
      setData(initialData);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    client
      .getMatchSuggestions(candidateId)
      .then((resp) => {
        if (!cancelled) {
          setData(resp);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setLoading(false);
        if (isMatchSuggestionsUnavailable(e)) {
          setUnavailable(true);
        } else {
          setError(
            e instanceof Error
              ? e.message
              : "Match suggestions could not be loaded."
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [candidateId, client, initialData]);

  if (unavailable) {
    return (
      <div className="suggestions-panel" data-testid="suggestions-unavailable">
        <h3>
          Likely catalog matches
          <HelpTip topic="match suggestions">
            When available, this panel ranks catalog beers that might
            be the same product as the staged candidate, with the
            evidence for each rank. Suggestions never choose a target
            for you.
          </HelpTip>
        </h3>
        <p>
          Match suggestions are not available for this candidate yet.
          Use the manual catalog search under "Add image to existing
          beer" below to look for a target. Manual search is a
          bounded lookup too: finding nothing there is not proof
          that this beer is new.
        </p>
      </div>
    );
  }

  return (
    <div className="suggestions-panel">
      <h3>
        Likely catalog matches
        <HelpTip topic="match suggestions">
          Ranked catalog beers that might be the same product as this
          staged candidate, with the evidence behind each rank. A
          suggestion is never selected automatically: check the beer
          ID and brewery, then confirm the target yourself.
        </HelpTip>
      </h3>
      {loading && <p>Loading suggestions...</p>}
      {error && (
        <div className="queue-preview-failed" role="alert">
          Match suggestions failed to load: {error}. Manual catalog
          search below still works.
        </div>
      )}
      {data && data.suggestions.length === 0 && (
        <p>
          No suggestions were returned for this candidate. That is
          not proof the beer is new: the suggestions search is
          bounded and can miss a real match. Search the catalog
          manually below as another check, and choose Add new only
          when you decide, on the evidence you have, that this is a
          new beer.
        </p>
      )}
      {data && !suggestionsSearchComplete(data) && (
        <p className="callout callout-warning" role="note">
          Suggestions may miss matches: they are ranked from a
          bounded search (scanned {data.scanned} beers), and a
          catalog beer whose name shares no searchable word with the
          staged name - a typo can cause that - may never be
          retrieved.
          {data.completeness &&
          data.completeness.stages_truncated.length > 0
            ? ` Search stages cut off early: ${data.completeness.stages_truncated.join(", ")}.`
            : ""}
          {!data.exhaustive
            ? " The scan also stopped at its size limit."
            : ""}{" "}
          A beer that is not listed here can still be the right
          target - search manually before concluding there is no
          match, and treat a manual search with no results as
          another bounded lookup, not a confirmation.
        </p>
      )}
      {data && data.suggestions.length > 0 && (
        <ul className="target-results">
          {data.suggestions.map((s: MatchSuggestion) => (
            <li key={s.beer_id} className="target-result">
              <span className="target-result-main">
                <strong>{s.name}</strong>{" "}
                <span className="beer-id">#{s.beer_id}</span>
                {s.brewery_name
                  ? ` · ${s.brewery_name}`
                  : " · brewery not recorded"}{" "}
                <span className="badge">Match {formatScore(s.score)}</span>{" "}
                {s.evidence.map((code) => (
                  <span key={code} className="badge evidence-chip">
                    {evidenceLabel(code)}
                  </span>
                ))}
                {s.barcode ? ` · Barcode ${s.barcode}` : ""}
                {s.abv !== null && s.abv !== undefined
                  ? ` · ABV ${s.abv}`
                  : ""}
              </span>
              <button
                type="button"
                onClick={() =>
                  onUseTarget({
                    id: s.beer_id,
                    name: s.name,
                    breweryName: s.brewery_name,
                  })
                }
              >
                Use as image-only target
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="gate-note">
        None of these is right? Use "None of these" by choosing the
        Add new choice below, or search the catalog manually in the
        image-only section. Suggestions never select a target on
        their own, and an empty result here never proves there is
        no match.
      </p>
    </div>
  );
};

export default MatchSuggestionsPanel;
