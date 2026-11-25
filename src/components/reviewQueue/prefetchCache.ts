import {
  DiscoveryReviewClient,
  MatchSuggestions,
} from "../../api/discoveryReview";
import {
  DiscoveryCandidateDetail,
  DiscoveryImageDecision,
  DiscoveryImageFetch,
} from "../../api/types";
import { ReviewIntentRecord } from "../../api/discoveryReview";

// Read-only prefetch for the guided review: while the reviewer works
// on one candidate, the NEXT candidate's reads (detail, saved
// intent, image fetches, image decisions, match suggestions) are
// fetched into this small in-memory cache so moving forward feels
// instant. Prefetch performs GETs only - it never saves an intent,
// fetches an image server-side, or records any decision.

export interface CandidateBundle {
  candidate: DiscoveryCandidateDetail;
  intent: ReviewIntentRecord | null;
  fetches: DiscoveryImageFetch[];
  imageDecisions: DiscoveryImageDecision[];
  // Null when the suggestions endpoint is unavailable (404) or the
  // prefetch of it failed; the panel then falls back to a live call.
  suggestions: MatchSuggestions | null;
}

const cache = new Map<number, Promise<CandidateBundle>>();

const loadBundle = async (
  client: DiscoveryReviewClient,
  candidateId: number
): Promise<CandidateBundle> => {
  const [candidate, intent, fetchResp, decisionResp, suggestions] =
    await Promise.all([
      client.getCandidate(candidateId),
      client.getReviewIntent(candidateId),
      client.listImageFetches(candidateId),
      client.listImageDecisions(candidateId),
      client.getMatchSuggestions(candidateId).catch(() => null),
    ]);
  return {
    candidate,
    intent,
    fetches: fetchResp?.results ?? [],
    imageDecisions: decisionResp?.results ?? [],
    suggestions,
  };
};

export const prefetchCandidate = (
  client: DiscoveryReviewClient,
  candidateId: number
): void => {
  if (cache.has(candidateId)) return;
  const promise = loadBundle(client, candidateId);
  // A failed prefetch must not surface as an unhandled rejection;
  // the guided view falls back to loading directly.
  promise.catch(() => undefined);
  cache.set(candidateId, promise);
};

// Returns and consumes the prefetched bundle promise for a
// candidate, if one was started.
export const takePrefetched = (
  candidateId: number
): Promise<CandidateBundle> | undefined => {
  const promise = cache.get(candidateId);
  if (promise) cache.delete(candidateId);
  return promise;
};

export const clearPrefetchCache = (): void => cache.clear();
