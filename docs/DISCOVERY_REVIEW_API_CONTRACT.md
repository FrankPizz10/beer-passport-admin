# Discovery Review API Contract

The contract between the admin review UI (`src/api/discoveryReview.ts`,
`DiscoveryReviewClient`) and the admin API, for the catalog discovery
workflow. Codex owns the API; this document records what the UI was
built against and the two capabilities the UI needs that do not exist
yet. Nothing in section B is implemented; the UI's HTTP client throws
`NotYetAvailableError` for those operations and the UI renders a
pending-API state for them.

## A. Existing endpoints the UI uses

All paths are under `/admin-api/v1` and behind the admin auth used by
every admin route. Verified in the server route modules on master
(admin PR #22 stack); file references are to `server/src/routes/`.

| Operation (client method) | Method and path | Verified in |
| --- | --- | --- |
| `getCandidate` | GET `/discovery/candidates/:id` | discovery.ts |
| `getCandidateDecisions` | GET `/discovery/candidates/:id/decisions` | discoveryDecisions.ts |
| `decideCandidate` | POST `/discovery/candidates/:id/decide` | discoveryDecisions.ts |
| `listImageFetches` | GET `/discovery/candidates/:id/image-fetches` | discoveryImages.ts |
| `requestImageFetch` | POST `/discovery/candidates/:id/image-fetches` | discoveryImages.ts |
| `getImagePreviewUrl` | GET `/discovery/image-fetches/:fetchId/preview` | discoveryImages.ts |
| `listImageDecisions` | GET `/discovery/candidates/:id/image-decisions` | discoveryImages.ts |
| `decideImage` | POST `/discovery/candidates/:id/image-decisions` | discoveryImages.ts |
| `getCatalogBeer` | GET `/catalog/beers/:id` | catalog routes (used by BeerDetailPage) |
| `listBatches` | GET `/discovery/batches` | discovery.ts |
| `listBatchCandidates` | GET `/discovery/batches/:id/candidates` | discovery.ts |
| `getManifest` | GET `/discovery/manifests/:id` | discoveryManifests.ts |
| `approveManifest` | POST `/discovery/manifests/:id/approve` | discoveryManifests.ts |

Shapes the UI depends on:

- Candidate detail returns the list-row fields plus provenance,
  `image_url` / `image_source` / `image_license` and the other staged
  image fields, `image_decision` / `image_decision_fetch_id` /
  `image_decision_at`, the owning `batch` ref, and `pairs`. The
  matched catalog beer is exposed as `matched_beer_id` only; the
  beer's name is resolved through GET `/catalog/beers/:id`.
- `decideCandidate` body: `{decision, reason?, note?}` with decision
  in `select | hold | reject | unhold`. Hold and reject require a
  reason from the hold-reason vocabulary; reason `other` requires a
  note. Refusals: 503 when the discovery write path is unconfigured,
  404 unknown candidate, 409 for state conflicts (held candidate
  selected, unresolved duplicate pair, final status), 422 for a
  missing reason. The response is the updated candidate list row.
- Image fetch POST returns 201 with the fetch record
  (`{id, candidate_id, image_ref, sha256, content_type, byte_size,
  width, height, outcome, outcome_detail, fetched_by, fetched_at,
  decision}`); the outcome field carries success or the failure
  class. Refusals: 503 unconfigured write path or image store, 404
  unknown candidate, 422 no fetchable http(s) image URL, 429 past
  the per-reviewer rate limit (30/hour).
- The preview endpoint serves the STORED bytes for a successful
  fetch with the verified content type, `X-Content-Type-Options:
  nosniff`, and a sandboxing CSP. The UI fetches those bytes through
  the authenticated blob helper and renders the object URL; the
  staged origin URL is never an image source.
- Image decision POST body: `{fetch_id, decision, note?,
  image_sha256?}` with decision in `approved | rejected`; returns
  201 with the decision record. Refusals: 503, 404 (unknown candidate
  or a fetch that does not belong to it), 422 when the fetch did not
  succeed, 409 when the fetch is already decided, when a supplied
  `image_sha256` does not match the fetch, or when the stored bytes
  no longer hash to the fetch's recorded SHA-256.
- Batch list rows carry `record_count` (the batch's full staged
  count) and grouped counts by review status, but no split by
  catalog match. The composition view therefore pages
  GET `/discovery/batches/:id/candidates?review_status=selected`
  (the endpoint's existing filter; the shared list envelope with
  server-side pagination) and counts rows with `matched_beer_id`
  set. Counts describe the complete batch, never a single page.
- Manifest detail carries the full `sha256`, `can_approve`
  (computed server-side from the approver allowlist), the canonical
  `records`, the build-time `catalog_fingerprint`, and lifecycle
  `events`. Approve POST body is exactly `{sha256}`; refusals: 503
  unconfigured, 403 not allowlisted, 400 malformed hash, 422 hash
  mismatch, 409 not draft.

## B. Proposed capabilities (NOT implemented; for Codex)

### B1. Candidate field edits before approval

Reviewers need to correct staged fields (the motivating case is a
staged ABV of 3.2123353678124, which a human must fix or consciously
accept) before selecting a candidate, without losing the staged
original or the audit trail.

Proposed endpoint:

```
PATCH /discovery/candidates/:id/fields
Request:  { "edits": [ { "field": "abv", "original": "3.2123353678124",
                         "proposed": "4.2" } ],
            "note": "optional reviewer note" }
Response: 200 with the updated candidate detail.
```

Semantics the UI is built against:

- Fields are limited to the staged data fields: `name`,
  `brewery_name`, `abv`, `style`, `barcode`, `image_url`.
- Each edit carries the staged original the reviewer saw; the server
  refuses (409) when the candidate's current value no longer equals
  the supplied original, so a stale edit can never overwrite a newer
  state silently.
- The server validates: name and brewery non-empty; ABV numeric and
  within [0, 20]. (The UI additionally warns, without blocking, when
  an ABV has more than 2 decimal places; whether the server records
  an accepted-as-staged high-precision ABV is Codex's call.)
- Every applied edit writes an audit event recording the field, the
  original value, and the proposed value, attributed to the reviewer
  (users id; the Firebase UID stays in audit columns only, as with
  the existing decision endpoints).
- Edits are allowed only while the candidate is in a reviewable
  state (pending or held); a selected candidate's fields are frozen
  by its manifest payload hash, so an edit after selection must
  either be refused or invalidate any draft manifest built from the
  old payload.

Grant and schema implications (Codex's design call; the UI takes no
position beyond naming the constraint):

- The reviewer role's UPDATE grant on `discovery_candidates` covers
  only the decision columns (`review_status`, `hold_reason`,
  `duplicate_of_candidate_id`, `updated_at`, migration 003). Any
  implementation must reconcile with that boundary. Options:
  (a) widen the reviewer UPDATE grant to the staged data columns
  (simplest; weakens the decision-columns-only boundary);
  (b) store proposed values in a separate reviewer-writable table
  and have the manifest builder resolve proposed-over-staged when
  computing payloads (preserves the boundary; the builder and the
  import revalidation must agree on the resolution);
  (c) record edits as audited proposals that take effect on the
  candidate only when a selection decision applies them.
- Per the repo's migration rule, any schema change ships once
  through the canonical server-repository Prisma migration; the
  admin repo does not apply mirror DDL to production.

UI status: the field-review section renders originals, staged-value
warnings, proposed inputs, and the changed-fields diff today;
`saveFieldEdits` throws `NotYetAvailableError` and the section shows
a pending-API banner. Selection, hold, and reject decisions do not
depend on this capability and remain fully usable.

### B2. Image-only manifest entries

A selected candidate that matched an existing catalog beer
(`matched_beer_id` set) represents an image for a beer that already
exists. Reviewers can already approve its image through the existing
hash-bound image decision. What is missing is any way to IMPORT
that approved image: the import must add a `beverage_images` row
(through the existing verified-bytes S3 upload path) for the
existing beer, creating and updating no beer row.

Current blocker, verbatim from the server code:
`server/src/discoveryManifestCore.ts`, in `evaluateEligibility`, a
selected candidate with `matched_beer_id` set is refused with reason
`already_in_catalog` (line 290), and the manifest build endpoint
refuses the whole build 422 while any selected candidate is blocked.
So today an image-only record cannot be imported at all, and its
presence in the selected set blocks the batch's new-beer manifest
too.

Proposed change:

- Manifest content gains an entry kind. New-beer entries stay as
  they are; an image-only entry is:
  `{ "kind": "image_only", "candidate_id": ..., "beer_id": ...,
     "image": { "decision_id": ..., "fetch_id": ..., "sha256": ... } }`
  referencing the existing catalog beer id and the candidate's
  approved image decision, exactly as new-beer entries reference
  their image decision today.
- The builder treats a selected, matched candidate with a current
  approved image decision as an image-only entry instead of an
  `already_in_catalog` refusal. A matched candidate WITHOUT an
  approved image decision remains a refusal (nothing importable).
- The import executor gains an image-only branch: for these entries
  it writes only the `beverage_images` row (verified bytes re-fetched
  and re-hashed, uploaded to the content-addressed S3 key, stored in
  `storage_key`, per the existing image path), performs no beer or
  brewery write, and the catalog-collision revalidation treats the
  match as the entry's purpose rather than a conflict. The other
  revalidation checks (approved manifest, hash binding, decision
  currency, catalog fingerprint) apply unchanged.
- Canonical JSON, hashing, approval, and void semantics are
  unchanged: an image-only entry is inside the same hash Frank
  approves, or it does not import.

UI status: the manifest view counts and lists image-only candidates
in the batch separately, badged "Pending backend support", and never
presents them as part of a manifest. `requestImageOnlyManifest`
throws `NotYetAvailableError`.

## C. Gates stay separate

Three independent gates, none implying another:

1. Candidate selection (and hold/reject) is a reviewer decision,
   audited per candidate.
2. An image decision approves or rejects the exact fetched bytes for
   one candidate. It publishes nothing by itself: no catalog row is
   created or changed, and no image becomes visible anywhere.
3. A manifest imports only after Frank approves its exact manifest
   ID and full SHA-256, and the operator executor revalidates
   everything at import time. An approved image reaches the catalog
   only as part of an approved manifest's import (for image-only
   records, once B2 exists).
