import { ApiError, apiGet, apiGetBlobUrl, apiPost, QueryParams } from "./client";
import {
  Beer,
  BeerDetail,
  DiscoveryBatch,
  DiscoveryCandidate,
  DiscoveryCandidateDetail,
  DiscoveryDecision,
  DiscoveryImageDecision,
  DiscoveryImageFetch,
  DiscoveryManifest,
  DiscoveryManifestDetail,
  DiscoveryManifestRecord,
  ListResponse,
} from "./types";

// Typed review client for the catalog discovery workflow
// (docs/DISCOVERY_REVIEW_API_CONTRACT.md). Operations map to one of
// two contract sources, and the distinction matters:
//
// - Section A endpoints EXIST in the admin API on master, verified
//   against the server route modules named in the contract doc.
// - The review-intent endpoints (section B1) were supplied as a
//   contract by Frank and implemented in Codex's backend; they are
//   live in production (a saved intent exists there). As with every
//   operation here, a failure surfaces the server's own error,
//   which this client preserves (see below).
//
// Server errors are NEVER collapsed into a generic failure: apiGet /
// apiPost throw ApiError carrying the server's status and message,
// and this client lets them propagate untouched, so the UI can show
// the server's exact words (and can tell a 409 revision conflict
// apart from any other failure).
//
// UI code calls only this interface, never raw fetch.

export const REVIEW_API_CONTRACT_DOC = "docs/DISCOVERY_REVIEW_API_CONTRACT.md";

// Thrown by operations whose backend capability is genuinely absent.
// No current client operation throws it: field editing is expressed
// through the review-intent contract (B1), and the one capability
// that remains unsupported (an audited image_url refetch and
// invalidation flow) has no UI operation yet. The type is retained
// so a future operation can mark itself unavailable in exactly the
// same way, and the UI can render that state.
export class NotYetAvailableError extends Error {
  capability: string;

  constructor(capability: string) {
    super(
      `${capability} is not supported: the limitation is ` +
        `documented in ${REVIEW_API_CONTRACT_DOC}. ` +
        `No data was changed.`
    );
    this.name = "NotYetAvailableError";
    this.capability = capability;
  }
}

// --- Match suggestions (parallel workstream WS1 contract) --------------
// GET /discovery/candidates/:id/match-suggestions is implemented in
// a separate backend PR that is NOT merged yet. The UI codes
// against this fixed shape and degrades gracefully: a 404 means the
// endpoint is not deployed, and the UI hides the suggestions panel
// and offers manual catalog search only. Suggestions are ranked
// candidates for the image-only target; they NEVER auto-select a
// target - the reviewer still picks and explicitly confirms.

export interface MatchSuggestion {
  beer_id: number;
  name: string;
  brewery_name: string | null;
  abv: number | null;
  barcode: string | null;
  score: number;
  evidence: string[];
}

export interface MatchSuggestions {
  candidate_id: number;
  suggestions: MatchSuggestion[];
  // False when the scan was bounded and may have missed catalog
  // beers: the UI must say suggestions may not cover the whole
  // catalog instead of implying exhaustiveness.
  exhaustive: boolean;
  scanned: number;
}

// Human-readable labels for the evidence codes the matcher emits.
export const EVIDENCE_LABELS: Record<string, string> = {
  barcode_exact: "Barcode matches exactly",
  name_exact: "Name matches exactly",
  name_normalized: "Name matches after normalization",
  brewery_match: "Brewery matches",
  name_similar: "Name is similar",
  token_overlap: "Name shares words",
};

export const evidenceLabel = (code: string): string =>
  EVIDENCE_LABELS[code] ?? code;

// True when the match-suggestions endpoint is not deployed (404):
// the one failure mode the UI treats as "feature absent" rather
// than an error worth alarming the reviewer with.
export const isMatchSuggestionsUnavailable = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

// The image-fetch rate limiter (parallel workstream WS3) may refuse
// a fetch with HTTP 429 and a retry_after_seconds hint in the error
// body. apiPost preserves the parsed body on ApiError.details; the
// hint may sit at the top level or inside the error object. Returns
// null when no usable hint is present, in which case the UI shows
// the server's message as-is.
export const extractRetryAfterSeconds = (error: unknown): number | null => {
  if (!(error instanceof ApiError)) return null;
  const details: any = error.details;
  const raw =
    details?.error?.retry_after_seconds ?? details?.retry_after_seconds;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? raw
    : null;
};

export type CandidateDecisionAction = "select" | "hold" | "reject" | "unhold";

export interface CandidateDecisionInput {
  decision: CandidateDecisionAction;
  // Required by the API for hold and reject (the hold-reason
  // vocabulary); 'other' additionally requires a note.
  reason?: string;
  note?: string;
}

export type ImageDecisionAction = "approved" | "rejected";

export interface ImageDecisionInput {
  fetch_id: number;
  decision: ImageDecisionAction;
  note?: string;
  // When supplied, the API refuses unless it equals the fetch's
  // recorded SHA-256: the decision binds to the exact previewed bytes.
  image_sha256?: string;
}

// --- Review intent (contract section B1) --------------------------------
// A review intent records WHAT should be imported for a candidate:
// a new beer built from reviewer-confirmed field values, or an image
// for one existing catalog beer the reviewer explicitly chose. It is
// an audited snapshot on the server (the original source payload is
// retained), and it is DISTINCT from the select / hold / reject
// decision endpoints: saving an intent does not select the
// candidate, and selecting a candidate does not create an intent.

// The beer payload of a new_beer intent. ALL seven fields are always
// supplied; optional fields that are missing are null, never omitted.
export interface ReviewIntentBeer {
  name: string;
  brewery_name: string;
  style: string | null;
  abv: number | null;
  ibu: number | null;
  barcode: string | null;
  description: string | null;
}

export type ReviewIntent =
  | { mode: "image_only"; target_beer_id: number }
  | { mode: "new_beer"; beer: ReviewIntentBeer };

// Structural equality for intents: the approve-for-import flow uses
// it to skip the intent save when the reviewer's current choice is
// already the saved intent, so a retry never writes a duplicate
// revision. Field order in the payload objects is fixed by
// buildNewBeerIntent, but the comparison does not rely on it.
export const intentsEqual = (
  a: ReviewIntent | null | undefined,
  b: ReviewIntent | null | undefined
): boolean => {
  if (!a || !b) return a === b;
  if (a.mode !== b.mode) return false;
  if (a.mode === "image_only" && b.mode === "image_only") {
    return a.target_beer_id === b.target_beer_id;
  }
  if (a.mode === "new_beer" && b.mode === "new_beer") {
    const x = a.beer;
    const y = b.beer;
    return (
      x.name === y.name &&
      x.brewery_name === y.brewery_name &&
      x.style === y.style &&
      x.abv === y.abv &&
      x.ibu === y.ibu &&
      x.barcode === y.barcode &&
      x.description === y.description
    );
  }
  return false;
};

// One saved intent as returned by GET/POST review-intent. `id` is
// the revision token: replacing the intent requires sending it back
// as expected_revision, and a stale one is refused with 409.
export interface ReviewIntentRecord {
  id: number;
  candidate_id: number;
  intent: ReviewIntent;
  created_at: string;
}

// True when an error is the review-intent revision conflict (HTTP
// 409): the saved intent changed since the caller loaded it, so the
// UI must reload rather than overwrite.
export const isReviewIntentConflict = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 409;

// The staged candidate fields shown in the review form. Every field
// except image_url feeds the new_beer intent payload; image_url is
// displayed read-only because changing it is not supported by the
// backend (it needs a separate audited refetch and invalidation
// design, and an approved hash never carries over to a new URL), so
// it is excluded from the payload and from the diff.
export type CandidateEditableField =
  | "name"
  | "brewery_name"
  | "abv"
  | "style"
  | "ibu"
  | "barcode"
  | "description"
  | "image_url";

// One field whose form value differs from the staged original, as
// display strings, in REVIEW_FIELDS order. Used for the changed-
// fields summary only; the intent payload is built separately.
export interface CandidateFieldEdit {
  field: CandidateEditableField;
  original: string;
  proposed: string;
}

export interface DiscoveryReviewClient {
  // --- Existing endpoints (contract doc section A) ---
  getCandidate(id: number): Promise<DiscoveryCandidateDetail>;
  getCandidateDecisions(
    id: number
  ): Promise<ListResponse<DiscoveryDecision>>;
  decideCandidate(
    id: number,
    input: CandidateDecisionInput
  ): Promise<DiscoveryCandidate>;
  listImageFetches(
    candidateId: number
  ): Promise<ListResponse<DiscoveryImageFetch>>;
  requestImageFetch(candidateId: number): Promise<DiscoveryImageFetch>;
  // Object URL for the stored preview bytes of one fetch. The bytes
  // come from the API's preview endpoint, never from the origin URL.
  getImagePreviewUrl(fetchId: number): Promise<string>;
  listImageDecisions(
    candidateId: number
  ): Promise<ListResponse<DiscoveryImageDecision>>;
  decideImage(
    candidateId: number,
    input: ImageDecisionInput
  ): Promise<DiscoveryImageDecision>;
  // The existing catalog beer a candidate matched, via the catalog
  // endpoint the admin UI already uses (GET /catalog/beers/:id).
  getCatalogBeer(beerId: number): Promise<BeerDetail>;
  // Catalog beer search for the image-only target picker, via the
  // existing list endpoint (GET /catalog/beers?q=..., a
  // case-insensitive name contains match, verified in
  // server/src/routes/catalog.ts).
  searchCatalogBeers(query: string): Promise<ListResponse<Beer>>;
  listBatches(): Promise<{ results: DiscoveryBatch[] }>;
  listBatchCandidates(
    batchId: number,
    params?: QueryParams
  ): Promise<ListResponse<DiscoveryCandidate>>;
  getManifest(id: string): Promise<DiscoveryManifestDetail>;
  approveManifest(id: string, sha256: string): Promise<DiscoveryManifest>;

  // --- Review intent (contract doc section B1) ---
  // Frank-supplied contract, implemented in Codex's backend and
  // live in production. GET returns the saved intent record
  // or null. POST saves (or replaces) the intent: expectedRevision
  // is the last returned intent id, or null when no intent exists;
  // a stale revision is refused 409 and the server's error (status +
  // message) reaches the caller untouched.
  getReviewIntent(
    candidateId: number
  ): Promise<ReviewIntentRecord | null>;
  saveReviewIntent(
    candidateId: number,
    expectedRevision: number | null,
    intent: ReviewIntent
  ): Promise<ReviewIntentRecord>;

  // --- Match suggestions (parallel WS1 contract, see above) ---
  getMatchSuggestions(candidateId: number): Promise<MatchSuggestions>;
}

export const httpDiscoveryReviewClient: DiscoveryReviewClient = {
  getCandidate: (id) => apiGet(`/discovery/candidates/${id}`),
  getCandidateDecisions: (id) =>
    apiGet(`/discovery/candidates/${id}/decisions`, { page_size: 100 }),
  decideCandidate: (id, input) => {
    const body: Record<string, string> = { decision: input.decision };
    if (input.reason) body.reason = input.reason;
    if (input.note) body.note = input.note;
    return apiPost(`/discovery/candidates/${id}/decide`, body);
  },
  listImageFetches: (candidateId) =>
    apiGet(`/discovery/candidates/${candidateId}/image-fetches`, {
      page_size: 100,
    }),
  requestImageFetch: (candidateId) =>
    apiPost(`/discovery/candidates/${candidateId}/image-fetches`, {}),
  getImagePreviewUrl: (fetchId) =>
    apiGetBlobUrl(`/discovery/image-fetches/${fetchId}/preview`),
  listImageDecisions: (candidateId) =>
    apiGet(`/discovery/candidates/${candidateId}/image-decisions`, {
      page_size: 100,
    }),
  decideImage: (candidateId, input) => {
    const body: Record<string, unknown> = {
      fetch_id: input.fetch_id,
      decision: input.decision,
    };
    if (input.image_sha256) body.image_sha256 = input.image_sha256;
    if (input.note) body.note = input.note;
    return apiPost(`/discovery/candidates/${candidateId}/image-decisions`, body);
  },
  getCatalogBeer: (beerId) => apiGet(`/catalog/beers/${beerId}`),
  searchCatalogBeers: (query) =>
    apiGet(`/catalog/beers`, { q: query, page_size: 20 }),
  listBatches: () => apiGet(`/discovery/batches`),
  listBatchCandidates: (batchId, params) =>
    apiGet(`/discovery/batches/${batchId}/candidates`, params),
  getManifest: (id) => apiGet(`/discovery/manifests/${id}`),
  approveManifest: (id, sha256) =>
    apiPost(`/discovery/manifests/${id}/approve`, { sha256 }),

  getReviewIntent: (candidateId) =>
    apiGet(`/discovery/candidates/${candidateId}/review-intent`),
  saveReviewIntent: (candidateId, expectedRevision, intent) =>
    apiPost(`/discovery/candidates/${candidateId}/review-intent`, {
      expected_revision: expectedRevision,
      intent,
    }),

  getMatchSuggestions: (candidateId) =>
    apiGet(`/discovery/candidates/${candidateId}/match-suggestions`),
};

// --- Field review model -------------------------------------------------
// Pure helpers shared by the review-intent UI and its tests. Values
// are handled as display strings end to end so a staged value is
// never silently reformatted: String(3.2123353678124) keeps every
// staged digit, and a proposed value is exactly what the reviewer
// typed. Conversion to the typed intent payload happens in exactly
// one place (buildNewBeerIntent).

export interface ReviewFieldDef {
  field: CandidateEditableField;
  label: string;
  kind: "text" | "abv" | "ibu";
  // image_url is shown for provenance but is not editable and never
  // enters the intent payload.
  editable: boolean;
}

export const REVIEW_FIELDS: ReviewFieldDef[] = [
  { field: "name", label: "Name", kind: "text", editable: true },
  { field: "brewery_name", label: "Brewery", kind: "text", editable: true },
  { field: "abv", label: "ABV", kind: "abv", editable: true },
  { field: "style", label: "Style", kind: "text", editable: true },
  { field: "ibu", label: "IBU", kind: "ibu", editable: true },
  { field: "barcode", label: "Barcode", kind: "text", editable: true },
  { field: "description", label: "Description", kind: "text", editable: true },
  { field: "image_url", label: "Image URL", kind: "text", editable: false },
];

export const originalFieldValue = (
  candidate: DiscoveryCandidateDetail,
  field: CandidateEditableField
): string => {
  const value = candidate[field];
  return value === null || value === undefined ? "" : String(value);
};

export interface FieldIssue {
  field: CandidateEditableField;
  // error: blocks saving. warning: never blocks and never rewrites
  // the value; it flags the field for the human (e.g. a staged ABV
  // with more than 2 decimal places). A warned value may still be
  // saved unchanged: that is the explicit accept-as-staged choice.
  level: "error" | "warning";
  message: string;
}

const decimalPlaces = (raw: string): number => {
  const dot = raw.indexOf(".");
  return dot === -1 ? 0 : raw.length - dot - 1;
};

export const validateFieldValue = (
  field: CandidateEditableField,
  proposed: string
): FieldIssue | null => {
  const value = proposed.trim();
  if (field === "name" && value === "") {
    return { field, level: "error", message: "Name is required." };
  }
  if (field === "brewery_name" && value === "") {
    return { field, level: "error", message: "Brewery is required." };
  }
  if (field === "abv" && value !== "") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return { field, level: "error", message: "ABV must be a number." };
    }
    // The backend accepts ABV from 0 to 100; there is no lower
    // product-specific ceiling in the UI.
    if (parsed < 0 || parsed > 100) {
      return {
        field,
        level: "error",
        message: "ABV must be between 0 and 100.",
      };
    }
    if (decimalPlaces(value) > 2) {
      return {
        field,
        level: "warning",
        message:
          `ABV "${value}" has more than 2 decimal places and needs ` +
          "human review. Correct it or accept it as staged; it is " +
          "never auto-corrected.",
      };
    }
  }
  if (field === "ibu" && value !== "") {
    if (!Number.isFinite(Number(value))) {
      return { field, level: "error", message: "IBU must be a number." };
    }
  }
  return null;
};

// The issue a STAGED value already carries before any edit (today
// only the ABV precision case): shown on the form so the reviewer
// sees the flag without changing anything.
export const stagedFieldIssue = (
  candidate: DiscoveryCandidateDetail,
  field: CandidateEditableField
): FieldIssue | null => {
  if (field !== "abv") return null;
  const original = originalFieldValue(candidate, field);
  if (original === "") return null;
  const issue = validateFieldValue(field, original);
  return issue && issue.level === "warning" ? issue : null;
};

// Only editable fields whose form value differs from the staged
// original, in REVIEW_FIELDS order. image_url can never appear here.
export const diffCandidateFields = (
  candidate: DiscoveryCandidateDetail,
  proposed: Partial<Record<CandidateEditableField, string>>
): CandidateFieldEdit[] => {
  const edits: CandidateFieldEdit[] = [];
  for (const def of REVIEW_FIELDS) {
    if (!def.editable) continue;
    const next = proposed[def.field];
    if (next === undefined) continue;
    const original = originalFieldValue(candidate, def.field);
    if (next !== original) {
      edits.push({ field: def.field, original, proposed: next });
    }
  }
  return edits;
};

export const validateCandidateEdits = (
  edits: CandidateFieldEdit[]
): FieldIssue[] =>
  edits
    .map((edit) => validateFieldValue(edit.field, edit.proposed))
    .filter((issue): issue is FieldIssue => issue !== null);

// Builds the new_beer intent payload from the form's display
// strings. The contract shape is exact: all seven beer fields are
// always present, optional fields that are empty become null (never
// omitted), numeric fields become numbers, and image_url is NOT
// part of the payload. Callers validate first; name and brewery are
// sent trimmed.
export const buildNewBeerIntent = (
  proposed: Partial<Record<CandidateEditableField, string>>
): ReviewIntent => {
  const text = (field: CandidateEditableField): string =>
    (proposed[field] ?? "").trim();
  const optionalText = (field: CandidateEditableField): string | null => {
    const value = text(field);
    return value === "" ? null : value;
  };
  const optionalNumber = (field: CandidateEditableField): number | null => {
    const value = text(field);
    return value === "" ? null : Number(value);
  };
  return {
    mode: "new_beer",
    beer: {
      name: text("name"),
      brewery_name: text("brewery_name"),
      style: optionalText("style"),
      abv: optionalNumber("abv"),
      ibu: optionalNumber("ibu"),
      barcode: optionalText("barcode"),
      description: optionalText("description"),
    },
  };
};

// The form's starting values when a saved new_beer intent exists:
// the intent's beer snapshot (it is the current proposed state),
// rendered back as display strings. Fields the snapshot carries as
// null start empty.
export const proposedFromIntentBeer = (
  beer: ReviewIntentBeer
): Partial<Record<CandidateEditableField, string>> => ({
  name: beer.name,
  brewery_name: beer.brewery_name,
  style: beer.style ?? "",
  abv: beer.abv === null ? "" : String(beer.abv),
  ibu: beer.ibu === null ? "" : String(beer.ibu),
  barcode: beer.barcode ?? "",
  description: beer.description ?? "",
});

// --- Manifest composition ----------------------------------------------
// Composition is derived from the MANIFEST's own records, never from
// candidate matching: a version 2 record with kind "image_only" is
// an image-only import (it carries target_beer_id and an image); a
// record with kind "new_beer", and every version 1 record (no kind),
// is a new-beer import. Pure and synchronous: the records arrive
// with the manifest detail the page already fetched.

export interface ManifestComposition {
  totalRecords: number;
  newBeerCount: number;
  imageOnly: DiscoveryManifestRecord[];
  imageOnlyCount: number;
}

export const getManifestComposition = (
  manifest: DiscoveryManifestDetail
): ManifestComposition => {
  const records = Array.isArray(manifest.records) ? manifest.records : [];
  const imageOnly = records.filter((r) => r.kind === "image_only");
  return {
    totalRecords: records.length,
    newBeerCount: records.length - imageOnly.length,
    imageOnly,
    imageOnlyCount: imageOnly.length,
  };
};
