import { apiGet, apiGetBlobUrl, apiPost, QueryParams } from "./client";
import {
  BeerDetail,
  DiscoveryBatch,
  DiscoveryCandidate,
  DiscoveryCandidateDetail,
  DiscoveryDecision,
  DiscoveryImageDecision,
  DiscoveryImageFetch,
  DiscoveryManifest,
  DiscoveryManifestDetail,
  ListResponse,
} from "./types";

// Typed review client for the catalog discovery workflow
// (docs/DISCOVERY_REVIEW_API_CONTRACT.md). Every operation maps to an
// endpoint that EXISTS in the admin API today, verified against the
// server route modules named in the contract doc, EXCEPT the two
// operations marked PROPOSED: they are typed here so the UI can be
// built and tested against the interface, and their HTTP
// implementation throws NotYetAvailableError until Codex ships the
// backend. UI code calls only this interface, never raw fetch.

export const REVIEW_API_CONTRACT_DOC = "docs/DISCOVERY_REVIEW_API_CONTRACT.md";

// Thrown by operations whose backend does not exist yet. The UI
// catches this exact type to render the pending-API state; any other
// error is a real failure and is surfaced as one.
export class NotYetAvailableError extends Error {
  capability: string;

  constructor(capability: string) {
    super(
      `${capability} is not available yet: the backend endpoint is ` +
        `proposed in ${REVIEW_API_CONTRACT_DOC} and has not been ` +
        `implemented. No data was changed.`
    );
    this.name = "NotYetAvailableError";
    this.capability = capability;
  }
}

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

// The staged candidate fields a reviewer may propose edits to. The
// set mirrors the fields the candidate detail endpoint exposes for
// review; anything else on the candidate is provenance or state and
// is not editable.
export type CandidateEditableField =
  | "name"
  | "brewery_name"
  | "abv"
  | "style"
  | "barcode"
  | "image_url";

// One proposed field change: the staged (original) value and the
// reviewer's proposed value, both as display strings. The proposed
// PATCH contract (see the contract doc) carries exactly this pair per
// field so the server can audit original vs proposed.
export interface CandidateFieldEdit {
  field: CandidateEditableField;
  original: string;
  proposed: string;
}

export interface BatchComposition {
  batchId: number;
  // The batch's full staged record count (from GET /discovery/batches),
  // never a page size or a sample.
  totalRecords: number | null;
  selectedCount: number;
  // Selected candidates with no catalog match: these become new
  // beers when imported through a manifest.
  newBeerCount: number;
  // Selected candidates that matched an existing catalog beer. Today
  // they cannot be imported at all (the manifest builder refuses
  // them with already_in_catalog); they are listed so the reviewer
  // can see them, never counted as part of a manifest.
  imageOnly: DiscoveryCandidate[];
  imageOnlyCount: number;
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
  listBatches(): Promise<{ results: DiscoveryBatch[] }>;
  listBatchCandidates(
    batchId: number,
    params?: QueryParams
  ): Promise<ListResponse<DiscoveryCandidate>>;
  getManifest(id: string): Promise<DiscoveryManifestDetail>;
  approveManifest(id: string, sha256: string): Promise<DiscoveryManifest>;

  // --- Proposed endpoints (contract doc section B; NOT implemented) ---
  // Reviewer-scoped update of staged candidate fields before a
  // selection decision. Throws NotYetAvailableError until Codex ships
  // PATCH /discovery/candidates/:id/fields.
  saveFieldEdits(
    candidateId: number,
    edits: CandidateFieldEdit[]
  ): Promise<DiscoveryCandidateDetail>;
  // A manifest containing image_only entries for the batch's selected
  // candidates that matched an existing catalog beer. Throws
  // NotYetAvailableError until the manifest format and builder
  // support the image_only entry kind.
  requestImageOnlyManifest(batchId: number): Promise<DiscoveryManifestDetail>;
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
  listBatches: () => apiGet(`/discovery/batches`),
  listBatchCandidates: (batchId, params) =>
    apiGet(`/discovery/batches/${batchId}/candidates`, params),
  getManifest: (id) => apiGet(`/discovery/manifests/${id}`),
  approveManifest: (id, sha256) =>
    apiPost(`/discovery/manifests/${id}/approve`, { sha256 }),

  saveFieldEdits: () => {
    throw new NotYetAvailableError("Candidate field edits");
  },
  requestImageOnlyManifest: () => {
    throw new NotYetAvailableError("Image-only manifest entries");
  },
};

// --- Field review model -------------------------------------------------
// Pure helpers shared by the field-review UI and its tests. Values
// are handled as display strings end to end so a staged value is
// never silently reformatted: String(3.2123353678124) keeps every
// staged digit, and a proposed value is exactly what the reviewer
// typed.

export interface ReviewFieldDef {
  field: CandidateEditableField;
  label: string;
  kind: "text" | "abv";
}

export const REVIEW_FIELDS: ReviewFieldDef[] = [
  { field: "name", label: "Name", kind: "text" },
  { field: "brewery_name", label: "Brewery", kind: "text" },
  { field: "abv", label: "ABV", kind: "abv" },
  { field: "style", label: "Style", kind: "text" },
  { field: "barcode", label: "Barcode", kind: "text" },
  { field: "image_url", label: "Image URL", kind: "text" },
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
  // with more than 2 decimal places).
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
    if (parsed < 0 || parsed > 20) {
      return {
        field,
        level: "error",
        message: "ABV must be between 0 and 20.",
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
  return null;
};

// The issue a STAGED value already carries before any edit (today
// only the ABV precision case): shown in read mode so the reviewer
// sees the flag without entering edit mode.
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

// Only fields whose proposed value differs from the staged original,
// in REVIEW_FIELDS order.
export const diffCandidateFields = (
  candidate: DiscoveryCandidateDetail,
  proposed: Partial<Record<CandidateEditableField, string>>
): CandidateFieldEdit[] => {
  const edits: CandidateFieldEdit[] = [];
  for (const def of REVIEW_FIELDS) {
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

// --- Batch composition --------------------------------------------------
// Counts a batch's selected candidates into new beers vs image-only
// by paging the EXISTING candidates list endpoint with its
// review_status filter (the batches endpoint exposes no matched-beer
// split). Pages are followed until the server-reported total is
// covered, so the counts describe the complete batch, never a page.

export const getBatchComposition = async (
  client: DiscoveryReviewClient,
  batchId: number
): Promise<BatchComposition> => {
  const batches = await client.listBatches();
  const batch = Array.isArray(batches?.results)
    ? batches.results.find((b) => b.id === batchId)
    : undefined;

  const selected: DiscoveryCandidate[] = [];
  let page = 1;
  for (;;) {
    const resp = await client.listBatchCandidates(batchId, {
      review_status: "selected",
      page,
      page_size: 100,
    });
    const rows = Array.isArray(resp?.results) ? resp.results : [];
    selected.push(...rows);
    const total = resp?.pagination?.total_results ?? selected.length;
    if (rows.length === 0 || selected.length >= total) break;
    page += 1;
  }

  const imageOnly = selected.filter((c) => c.matched_beer_id !== null);
  return {
    batchId,
    totalRecords: batch ? batch.record_count : null,
    selectedCount: selected.length,
    newBeerCount: selected.length - imageOnly.length,
    imageOnly,
    imageOnlyCount: imageOnly.length,
  };
};
