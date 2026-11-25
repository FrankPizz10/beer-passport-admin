import { QueryParams } from "../../api/client";
import { DiscoveryCandidate } from "../../api/types";

// Queue filter definitions for the fast review queue. Every filter
// maps to parameters the EXISTING batch candidates endpoint already
// supports (single-value enum filters: review_status, hold_reason,
// image_status - see server/src/routes/discovery.ts); filters that
// span several values of one enum are expressed as a sub-choice so
// each list request stays a single honest server-side query. The
// client never fetches a whole batch to filter locally.

export type QueueFilterId =
  | "actionable"
  | "attention"
  | "no_image"
  | "with_image"
  | "reviewed";

export interface QueueFilterSub {
  value: string;
  label: string;
}

export interface QueueFilterDef {
  id: QueueFilterId;
  label: string;
  description: string;
  subs?: QueueFilterSub[];
  params: (sub: string | undefined) => QueryParams;
}

const ATTENTION_REASONS: QueueFilterSub[] = [
  { value: "missing_brewery", label: "Missing brewery" },
  { value: "metadata_incomplete", label: "Metadata incomplete" },
  { value: "duplicate_unresolved", label: "Duplicate pair unresolved" },
];

export const QUEUE_FILTERS: QueueFilterDef[] = [
  {
    id: "actionable",
    label: "All actionable",
    description: "Pending candidates waiting for a first decision.",
    params: () => ({ review_status: "pending" }),
  },
  {
    id: "attention",
    label: "Needs attention",
    description:
      "Candidates the staging pipeline flagged: pick the flag to work through.",
    subs: ATTENTION_REASONS,
    params: (sub) => ({ hold_reason: sub ?? ATTENTION_REASONS[0].value }),
  },
  {
    id: "no_image",
    label: "No image",
    description:
      "Candidates with no staged image; they stay reviewable as new beers without an image decision.",
    subs: [
      { value: "none", label: "No image staged" },
      { value: "not_staged", label: "Image status not recorded" },
    ],
    params: (sub) => ({ image_status: sub ?? "none" }),
  },
  {
    id: "with_image",
    label: "With image",
    description: "Candidates whose staged image passed a staging check.",
    subs: [
      { value: "verified", label: "Image verified" },
      { value: "gate_passed_unverified", label: "Gate passed, unverified" },
    ],
    params: (sub) => ({ image_status: sub ?? "verified" }),
  },
  {
    id: "reviewed",
    label: "Already reviewed",
    description: "Candidates that already carry a decision.",
    subs: [
      { value: "selected", label: "Selected" },
      { value: "held", label: "Held" },
      { value: "rejected", label: "Rejected" },
      { value: "imported", label: "Imported" },
    ],
    params: (sub) => ({ review_status: sub ?? "selected" }),
  },
];

export const queueFilterDef = (id: string | null): QueueFilterDef =>
  QUEUE_FILTERS.find((f) => f.id === id) ?? QUEUE_FILTERS[0];

// Short text for a row's image state, from the normalized staging
// status. Text, never color alone. The list serializer
// (server/src/routes/discovery.ts, serializeCandidateListRow)
// always emits the image_status_normalized key, but the column is
// nullable: null is the server's own "not staged" value (the list
// filter maps null to the not_staged filter value, and the batch
// counts group null under 'not_staged'). Any OTHER value the
// client does not recognize - an absent field from an older API,
// or a status added server-side later - is reported as unknown,
// never silently presented as "No image" or "not staged".
export const imageIndicator = (candidate: DiscoveryCandidate): string => {
  switch (candidate.image_status_normalized) {
    case "verified":
      return "Image: verified";
    case "gate_passed_unverified":
      return "Image: gate passed";
    case "failed":
      return "Image: staging check failed";
    case "none":
      return "No image";
    case null:
      return "Image: not staged";
    default:
      return "Image: unknown";
  }
};

// Session-storage keys for queue position preservation. The queue
// page mirrors its state (batch, filter, sub, page, page size) and
// the current page's candidate ids here as well as in the URL, so
// returning from a guided review lands exactly where the reviewer
// left off.
export const QUEUE_STATE_KEY = "bp-review-queue-state";
export const QUEUE_IDS_KEY = "bp-review-queue-ids";
export const QUEUE_WORKED_KEY = "bp-review-queue-worked";

export interface QueueState {
  batchId: number;
  filter: QueueFilterId;
  sub?: string;
  page: number;
  pageSize: number;
  q?: string;
}

export const readStoredQueueState = (): QueueState | null => {
  try {
    const raw = sessionStorage.getItem(QUEUE_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as QueueState;
    if (typeof parsed.batchId !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
};

export const storeQueueState = (state: QueueState): void => {
  try {
    sessionStorage.setItem(QUEUE_STATE_KEY, JSON.stringify(state));
  } catch {
    // Storage is a convenience; the URL remains the source of truth.
  }
};

export const storeQueueIds = (ids: number[]): void => {
  try {
    sessionStorage.setItem(QUEUE_IDS_KEY, JSON.stringify(ids));
  } catch {
    // See storeQueueState.
  }
};

export const readStoredQueueIds = (): number[] => {
  try {
    const raw = sessionStorage.getItem(QUEUE_IDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((n) => typeof n === "number")
      : [];
  } catch {
    return [];
  }
};
