export interface PaginationInfo {
  page: number;
  page_size: number;
  total_results: number;
  total_pages: number;
}

export interface ListResponse<T> {
  results: T[];
  pagination: PaginationInfo;
}

export interface Ref {
  id: number;
  name: string;
}

export interface OverviewCounts {
  [table: string]: number;
}

// Response of GET /admin-api/v1/admin/overview: the server sends the
// counts map under `counts` AND spreads the same keys at the top level
// ({ counts, ...counts }). Consumers must read `counts`; iterating the
// whole body yields the nested counts object as a value.
export interface OverviewResponse {
  counts: OverviewCounts;
  [table: string]: number | OverviewCounts;
}

export interface TargetInfo {
  host: string | null;
  port: number | null;
  database: string | null;
  firebase_configured: boolean;
}

export interface Beer {
  id: number;
  name: string;
  abv: number | null;
  ibu: number | null;
  srm: number | null;
  upc: string | null;
  descript?: string | null;
  discontinued: boolean;
  last_mod: string;
  brewery_id?: number | null;
  style_id?: number | null;
  cat_id?: number | null;
  brewery: Ref | null;
  style: Ref | null;
  category: Ref | null;
  image_url: string | null;
  image_kind: "product" | "category" | "initials";
  image_provenance: ImageProvenance | null;
}

export interface ImageProvenance {
  tier?: string | null;
  source_type?: string | null;
  source_url?: string | null;
  storage_key?: string | null;
  license_type?: string | null;
  attribution?: string | null;
  license_url?: string | null;
  status?: string | null;
}

export interface BeerDetail extends Beer {
  collections: Ref[];
  user_beers_count: number;
  liked_count: number;
  counts?: { user_beers: number; liked_user_beers: number };
}

// Response of GET /admin-api/v1/images/:beverageId: a short-lived
// presigned GET URL for an approved private image, plus its expiry.
export interface PresignedImageResponse {
  url: string;
  expires_at: string;
}

// One row of GET /admin-api/v1/images/queue: a pending image candidate
// awaiting an approval decision. image_url is set only when the direct
// image locator is a public http(s) URL; has_private_image marks a
// private object that must be previewed through the preview-url
// endpoint. The raw storage key is never sent to the client.
export interface ImageQueueItem {
  id: number;
  beverage_id: number;
  beverage: Ref | null;
  brewery: Ref | null;
  source_type: string | null;
  source_url: string | null;
  license_type: string | null;
  attribution: string | null;
  license_url: string | null;
  status: string;
  source_check_status: "image" | "not_image" | "unreachable" | "unchecked" | string;
  source_content_type: string | null;
  source_checked_at: string | null;
  image_url: string | null;
  has_private_image: boolean;
  created_at?: string;
  updated_at?: string;
}

// One row of GET /admin-api/v1/images/decisions: an entry of the
// append-only approval audit trail.
export interface ImageReviewDecision {
  id: number;
  beverage_image_id: number;
  beverage_id: number;
  action: "approve" | "reject" | string;
  from_status: string;
  to_status: string;
  admin_user_id: number | null;
  admin_user_name: string | null;
  note: string | null;
  created_at: string;
}

export interface Brewery {
  id: number;
  name: string;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  code?: string | null;
  country?: string | null;
  phone?: string | null;
  website?: string | null;
  descript?: string | null;
  add_user?: number | null;
  last_mod?: string;
  beer_count: number;
}

export interface Geocode {
  id: number;
  brewery_id: number;
  latitude: number | string;
  longitude: number | string;
  accuracy: string;
}

// Response of GET /admin-api/v1/catalog/breweries/:id is FLAT: the
// brewery fields, a plain array of serialized beer rows under `beers`,
// and the pagination object at the top level (duplicated as
// `beers_pagination`). It is NOT a ListResponse envelope.
export interface BreweryDetail extends Brewery {
  geocode: Geocode | null;
  beers: Beer[];
  pagination: PaginationInfo;
  beers_pagination: PaginationInfo;
}

export interface Category {
  id: number;
  cat_name?: string;
  name?: string;
  last_mod?: string;
  beer_count?: number;
  style_count?: number;
}

// Response of GET /admin-api/v1/catalog/categories/:id: the category
// fields (with `name` mirroring cat_name), a plain array of styles,
// and beer_count. The endpoint returns NO beers and NO pagination;
// category beers come from GET /catalog/beers?category_id=:id.
export interface CategoryDetail extends Category {
  styles: { id: number; style_name: string; name: string; cat_id: number; last_mod: string }[];
  beer_count: number;
}

export interface Style {
  id: number;
  style_name?: string;
  name?: string;
  last_mod?: string;
  category?: Ref | null;
  beer_count?: number;
}

// Response of GET /admin-api/v1/catalog/styles/:id: the style fields
// (with `name` mirroring style_name), a category ref, and beer_count.
// Like category detail it returns NO beers and NO pagination; style
// beers come from GET /catalog/beers?style_id=:id.
export interface StyleDetail extends Style {
  category: Ref | null;
  beer_count: number;
}

export interface Collection {
  id: number;
  name: string;
  difficulty?: number | null;
  description?: string | null;
  created_at?: string;
  updated_at?: string;
  beer_count?: number;
  member_count?: number;
  badge_holder_count?: number;
}

export interface CollectionBeerRow {
  id: number;
  collection_id?: number;
  beer_id?: number;
  beer?: Ref | null;
  collection?: Ref | null;
  created_at?: string;
  updated_at?: string;
}

// One member row of a collection detail response: a collection_beers
// row id plus refs to the beer (and, on `beers`, the collection).
export interface CollectionMemberRow {
  id: number;
  beer: Ref | null;
  collection?: Ref | null;
  created_at: string;
}

// Response of GET /admin-api/v1/catalog/collections/:id is FLAT: the
// collection fields, plain arrays of member rows under `beers` and
// `members`, and the pagination object at the top level.
export interface CollectionDetail extends Collection {
  beers: CollectionMemberRow[];
  members: CollectionMemberRow[];
  pagination: PaginationInfo;
  badge_holder_count: number;
}

export interface BeverageImage {
  id: number;
  beverage_id: number;
  source_type?: string | null;
  source_url?: string | null;
  storage_key?: string | null;
  license_type?: string | null;
  attribution?: string | null;
  license_url?: string | null;
  status: string;
  verified_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AppUser {
  id: number;
  user_name: string;
  email: string;
  age: number | null;
  private: boolean;
  created_at: string;
  tried_count: number;
  badge_count: number;
}

export interface UserDetail extends AppUser {
  uid: string;
  updated_at?: string;
  notification_count?: number;
  friend_count?: number;
  counts?: {
    user_beers: number;
    user_badges: number;
    notifications: number;
  };
}

export interface UserBeerRow {
  id: number;
  beer: Ref;
  liked: boolean;
  created_at: string;
}

export interface UserBadgeRow {
  id: number;
  collection: Ref;
  earned: boolean;
  progress: number;
  created_at?: string;
}

export interface UserFriendRow {
  id: number;
  other_user: { id: number; user_name: string } | null;
  created_at: string;
}

export interface UserNotificationRow {
  id: number;
  type: string;
  message: string;
  viewed: boolean;
  created_at: string;
}

export interface AdminAccount {
  uid: string;
  email: string | null;
  is_admin: boolean;
  created_at: string | null;
  last_sign_in_at: string | null;
  disabled: boolean;
}

export interface AccountsResponse {
  results: AdminAccount[];
  next_cursor: string | null;
  firebase_configured: boolean;
}

export interface ApiKey {
  id: number;
  name: string;
  revoked: boolean;
  created_at: string;
  last_used_at: string | null;
  last_mod: string;
}

// --- Discovery staging hub (Phase 2, read-only) ---

// Breakdown maps of GET /admin-api/v1/discovery/batches: each key is a
// bucket/status value, each value the number of candidates in it.
export interface DiscoveryBatchCounts {
  by_origin_bucket: Record<string, number>;
  by_image_status: Record<string, number>;
  by_hold_reason: Record<string, number>;
  by_review_status: Record<string, number>;
}

export interface DiscoveryReviewProgress {
  total: number;
  decided: number;
  pending: number;
  percent_reviewed: number;
}

// One row of GET /admin-api/v1/discovery/batches.
export interface DiscoveryBatch {
  id: number;
  slug: string;
  title: string | null;
  source: string;
  source_summary: string | null;
  record_count: number;
  status: string;
  bundle_sha256: string;
  ingested_at: string;
  counts: DiscoveryBatchCounts;
  review_progress: DiscoveryReviewProgress;
}

// One row of GET /admin-api/v1/discovery/batches/:id/candidates.
export interface DiscoveryCandidate {
  id: number;
  batch_id: number;
  candidate_key: string;
  name: string;
  brewery_name: string | null;
  style: string | null;
  abv: number | null;
  barcode: string | null;
  source: string;
  origin_bucket: string | null;
  image_status: string | null;
  image_status_normalized: string | null;
  image_verified: boolean | null;
  hold_reason: string | null;
  review_status: string;
  dedupe_outcome: string;
  matched_beer_id: number | null;
}

export interface DiscoveryOriginEvidence {
  signal: string;
  value: string;
}

// One duplicate-pair row on a candidate detail: candidate_id is the
// candidate the detail page is for, candidate_id_b the other side
// (null when the pair points at an external record instead, named by
// external_ref). rival is the resolved other candidate when present.
export interface DiscoveryPair {
  id: number;
  candidate_id: number;
  candidate_id_b: number | null;
  external_ref: string | null;
  comparison: string | null;
  method: string | null;
  score: number | null;
  status: string;
  decided_by: { id: number; user_name: string } | null;
  decided_at: string | null;
  rival: {
    id: number;
    name: string;
    brewery_name: string | null;
    style: string | null;
    abv: number | null;
    barcode: string | null;
    source: string;
    origin_bucket: string | null;
    image_status_normalized: string | null;
    review_status: string;
  } | null;
}

// One audit row from GET /admin-api/v1/discovery/candidates/:id/decisions
// or /discovery/batches/:id/decisions. decision uses the issues/001
// action vocabulary (select / hold / reject / unhold for candidates,
// mark_duplicate / mark_distinct for pairs). The decider is the users
// id + user_name only; the API never sends the Firebase UID.
export interface DiscoveryDecision {
  id: number;
  candidate_id: number | null;
  pair_id: number | null;
  decision: string;
  from_status: string | null;
  to_status: string | null;
  reason: string | null;
  note: string | null;
  decided_by: { id: number; user_name: string } | null;
  created_at: string;
}

// One side of the side-by-side pair view (GET /discovery/pairs/:id):
// the candidate list-row fields plus provenance identifiers.
export interface DiscoveryPairSide extends DiscoveryCandidate {
  source_record_id: string;
  source_url: string | null;
}

// Response of GET /admin-api/v1/discovery/pairs/:id: the pair plus
// both sides serialized (rival is null when it lives in another batch
// and is named by external_ref).
export interface DiscoveryPairDetail {
  id: number;
  batch_id: number;
  candidate_id: number;
  candidate_id_b: number | null;
  external_ref: string | null;
  comparison: string | null;
  method: string | null;
  score: number | null;
  status: string;
  decided_by: { id: number; user_name: string } | null;
  decided_at: string | null;
  created_at: string;
  candidate: DiscoveryPairSide | null;
  rival: DiscoveryPairSide | null;
}

// Response of GET /admin-api/v1/discovery/candidates/:id: the list-row
// fields plus provenance, image, and review detail, the owning batch
// ref, and the candidate's duplicate pairs.
export interface DiscoveryCandidateDetail extends DiscoveryCandidate {
  ibu: number | null;
  description: string | null;
  source_record_id: string;
  source_url: string | null;
  retrieved_at: string | null;
  tier: string | null;
  origin_evidence: DiscoveryOriginEvidence[] | null;
  image_url: string | null;
  image_source: string | null;
  image_tier: string | null;
  image_flag_reason: string | null;
  image_license: string | null;
  image_page_url: string | null;
  image_width: number | null;
  image_height: number | null;
  hold_note: string | null;
  duplicate_of_candidate_id: number | null;
  // Current hash-bound image decision state (Phase 4): the decision
  // (approved / rejected), the fetch it binds to, and when it was
  // recorded. All null until an image decision exists.
  image_decision: string | null;
  image_decision_fetch_id: number | null;
  image_decision_at: string | null;
  created_at: string;
  updated_at: string;
  batch: { id: number; slug: string; title: string | null };
  pairs: DiscoveryPair[];
}

// One row of GET /admin-api/v1/discovery/candidates/:id/image-fetches:
// a single server-side fetch attempt of the candidate's staged image.
// outcome is 'success' or a failure class (dns_blocked,
// redirect_blocked, downgrade_blocked, too_large, not_image,
// magic_mismatch, unreachable, timeout). sha256 / content_type /
// dimensions are set only on success; content_type is the VERIFIED
// type from the magic bytes. decision is the fetch's image decision
// when one exists (a fetch can be decided exactly once).
export interface DiscoveryImageFetch {
  id: number;
  candidate_id: number;
  image_ref: string;
  sha256: string | null;
  content_type: string | null;
  byte_size: number | null;
  width: number | null;
  height: number | null;
  outcome: string;
  outcome_detail: string | null;
  fetched_by: { id: number; user_name: string } | null;
  fetched_at: string;
  decision: { id: number; decision: string; decided_at: string } | null;
}

// One row of GET /admin-api/v1/discovery/candidates/:id/image-decisions:
// the append-only audit of hash-bound image decisions. image_sha256
// is the hash of the exact bytes that were previewed from the named
// fetch; the decider is users id + user_name only.
export interface DiscoveryImageDecision {
  id: number;
  candidate_id: number;
  fetch_id: number;
  image_ref: string;
  image_sha256: string;
  image_content_type: string | null;
  image_width: number | null;
  image_height: number | null;
  image_source: string | null;
  image_license: string | null;
  decision: string;
  note: string | null;
  decided_by: { id: number; user_name: string } | null;
  decided_at: string;
}

// --- Discovery import manifests (Phase 5) ---

// Per-table catalog fingerprint recorded when a manifest was built:
// row count + MD5 over the table's content-bearing columns in id
// order. The import executor refuses when the live fingerprint has
// moved (decision 006 check 5).
export interface DiscoveryCatalogFingerprint {
  beers: { count: number; md5: string };
  breweries: { count: number; md5: string };
  beverage_images: { count: number; md5: string };
}

// One row of GET /admin-api/v1/discovery/manifests. can_approve is
// computed SERVER-side from the manifest approver allowlist for the
// signed-in account; the client only uses it to show or hide the
// approve control (the API enforces the gate regardless). No
// Firebase UID is ever present.
export interface DiscoveryManifest {
  id: string;
  batch_id: number;
  batch_slug: string | null;
  record_count: number;
  status: "draft" | "approved" | "imported" | "void" | string;
  sha256: string;
  sha256_short: string | null;
  built_by: { id: number; user_name: string } | null;
  approved_by: { id: number; user_name: string } | null;
  approved_at: string | null;
  approved_sha256: string | null;
  imported_at: string | null;
  created_at: string;
  can_approve: boolean;
}

// One manifest record on the detail response: the candidate, its
// build-time resolution (existing brewery/style by id, or a brewery
// the import will create), and the approved Phase 4 image decision
// bound to the record, if any.
export interface DiscoveryManifestRecord {
  candidate_id: number;
  candidate_key: string;
  payload_sha256: string;
  selection_decision_id: number;
  beer_name: string | null;
  brewery_name: string | null;
  brewery: { mode: "existing"; brewery_id: number } | { mode: "new" } | null;
  style:
    | { mode: "existing"; style_id: number; category_id: number | null }
    | { mode: "none" }
    | null;
  image: {
    decision_id: number;
    fetch_id: number;
    ref: string;
    sha256: string;
  } | null;
}

// One audit row of a manifest's lifecycle (build / approve / void /
// import). The actor is users id + user_name only; import events are
// recorded by the operator executor and carry no actor.
export interface DiscoveryManifestEvent {
  id: number;
  manifest_id: string;
  action: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  actor: { id: number; user_name: string } | null;
  created_at: string;
}

// Response of GET /admin-api/v1/discovery/manifests/:id.
export interface DiscoveryManifestDetail extends DiscoveryManifest {
  bundle_sha256: string | null;
  catalog_fingerprint: DiscoveryCatalogFingerprint;
  records: DiscoveryManifestRecord[];
  events: DiscoveryManifestEvent[];
}

// One blocking candidate in a 422 manifest-build refusal
// (POST /discovery/batches/:id/manifests): the candidate and every
// eligibility reason it failed. A manifest is never built while any
// selected candidate is blocked.
export interface DiscoveryManifestBlocker {
  candidate_id: number;
  candidate_key: string;
  reasons: string[];
}
