# Discovery Review API Contract

The contract between the admin review UI (`src/api/discoveryReview.ts`,
`DiscoveryReviewClient`) and the admin API, for the catalog discovery
workflow. Codex owns the API; this document records what the UI was
built against, in three clearly separated classes:

- **Section A**: endpoints that exist in the admin API on master,
  verified against the server route modules.
- **Section A2**: the review-intent endpoints. These are a contract
  supplied by Frank, implemented in Codex's LOCAL backend, and NOT
  deployed or merged. They are not verified in master code; the UI
  integrates against them as specified in section B1.
- **Section B**: the capabilities behind those contracts and their
  current deployment status, including the image_url limitation.

Server errors are part of the contract: the API's error status and
message reach the UI untouched (the shared client throws `ApiError`
with both), and the UI displays the server's own message rather than
a generic substitute.

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
| `getCatalogBeer` | GET `/catalog/beers/:id` | catalog.ts |
| `searchCatalogBeers` | GET `/catalog/beers?q=...` | catalog.ts |
| `listBatches` | GET `/discovery/batches` | discovery.ts |
| `listBatchCandidates` | GET `/discovery/batches/:id/candidates` | discovery.ts |
| `getManifest` | GET `/discovery/manifests/:id` | discoveryManifests.ts |
| `approveManifest` | POST `/discovery/manifests/:id/approve` | discoveryManifests.ts |

Shapes the UI depends on:

- Candidate detail returns the list-row fields plus provenance,
  `image_url` / `image_source` / `image_license` and the other staged
  image fields, `image_decision` / `image_decision_fetch_id` /
  `image_decision_at`, the owning `batch` ref, and `pairs`. The
  staging collision detector's output is `matched_beer_id` and
  `dedupe_outcome` (e.g. `no_match`); the UI displays both as staging
  information only (see B1 for why they never drive behavior).
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
  the per-reviewer rate limit (see the rate limit paragraph below).
- Image fetch rate limit: attempts are counted per reviewer from
  `discovery_image_fetches` over a rolling one-hour window; every
  attempt that reaches the fetcher counts, success or failure
  (pre-flight refusals - 503 unconfigured, 404, 422 - write no row
  and do not count). The limit defaults to 30 per hour and is
  operator-configurable via `DISCOVERY_IMAGE_FETCH_RATE_LIMIT`
  (positive integer, hard maximum 600, read at server start; unset
  or invalid values keep the default). Past the limit the POST
  answers 429 with the standard error shape plus one added field:
  `{error: {code: 'too_many_requests', message,
  retry_after_seconds}}`, where `retry_after_seconds` is the wait
  until the oldest counted attempt leaves the rolling window; the
  same value is sent as the `Retry-After` response header. The UI
  renders that guidance instead of a bare "try again later".
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
- Catalog beer list: `GET /catalog/beers` accepts `q` (a
  case-insensitive name `contains` match) plus the shared pagination
  and sort parameters; rows are the beer list shape (`id`, `name`,
  `brewery` ref, ...). The UI's image-only target picker searches
  with it, so a reviewer can find a target beer even when the
  staging collision detector reported no match.
- Manifest detail carries the full `sha256`, `can_approve`
  (computed server-side from the approver allowlist), the canonical
  `records`, the build-time `catalog_fingerprint`, and lifecycle
  `events`. The "What will be imported" composition is derived from
  those records (see B2 for the version 2 `kind` field); the detail
  serialization must pass each record's `kind` and `target_beer_id`
  through, as the canonical manifest content (and therefore the
  export endpoint's bytes) already carries them. Approve POST body
  is exactly `{sha256}`; refusals: 503 unconfigured, 403 not
  allowlisted, 400 malformed hash, 422 hash mismatch, 409 not draft.

## A2. Supplied contract (implemented by Codex; live in production)

Supplied by Frank on 2026-11-24 from Codex's backend
implementation, and since shipped: the review-intent endpoints
are live in production (a saved intent exists there). Listed
separately from section A because they were supplied as a
contract rather than read from the master server code; the full
contract is section B1.

| Operation (client method) | Method and path |
| --- | --- |
| `getReviewIntent` | GET `/discovery/candidates/:id/review-intent` |
| `saveReviewIntent` | POST `/discovery/candidates/:id/review-intent` |

## B. Capabilities and their status

### B1. Review intent (replaces the former field-edits proposal)

Status: **specified by Frank, implemented in Codex's backend, and
live in production.** Intent loads and saves run against the
deployed API; when a call fails, the UI surfaces the server's
error verbatim.

A review intent records WHAT should be imported for a candidate, as
an audited server-side snapshot. The backend retains the original
source payload. Saving an intent is DISTINCT from the existing
select / hold / reject decision endpoints: neither implies the
other, and the UI keeps them as separate actions with copy that
says so.

Endpoints:

```
GET /discovery/candidates/:id/review-intent
Response: 200 with null (no intent saved), or
          { "id": <integer>, "candidate_id": <integer>,
            "intent": <intent>, "created_at": <timestamp> }

POST /discovery/candidates/:id/review-intent
Request:  { "expected_revision": null | <integer>,
            "intent": <intent> }
Response: the saved intent record (same shape as GET).
```

Revision semantics: `expected_revision` is the last returned intent
`id`, or `null` when no intent exists. A stale revision is refused
**409**; the UI treats 409 as reload-required (it shows the conflict
and a reload action) and never retries or overwrites blindly.

Intent shapes (a discriminated union on `mode`):

- Image only: `{ "mode": "image_only", "target_beer_id": 42 }`.
  The reviewer explicitly chooses this mode, searches the catalog
  for the target beer, and confirms the chosen beer (id + name)
  before saving; the server records that target as part of the
  audited intent. Image-only intent is NEVER inferred from
  `matched_beer_id`: the staging collision detector's output
  (`matched_beer_id`, `dedupe_outcome` such as `no_match`) is
  displayed as staging information only, and the picker works from
  the catalog search endpoint (section A) precisely so a target can
  be found when the detector did not match one (the staged Bud
  Light in production carries `no_match`).
- New beer: `{ "mode": "new_beer", "beer": { "name": ...,
  "brewery_name": ..., "style": ..., "abv": ..., "ibu": ...,
  "barcode": ..., "description": ... } }`. ALL seven fields are
  supplied; optional fields that are missing are `null`, never
  omitted. The form starts from the staged values so the reviewer
  can accept as-is or edit individual fields; this is how field
  correction before approval is expressed (it replaces the former
  B1 proposal of a separate field-edit endpoint entirely).

Rules the UI is built against:

- The candidate must be **pending** for an intent save; the UI
  disables the intent controls with an explanation for any other
  status.
- ABV: the backend accepts valid ABV from **0 to 100** (there is no
  20% ceiling). The UI hard-errors only on a non-numeric value or
  one outside [0, 100]. An ABV with more than 2 decimal places
  (the staged 3.2123353678124 case) raises a precision warning that
  never blocks and never rewrites the value; saving the value
  unchanged is the explicit accept-as-staged choice.
- `name` and `brewery_name` are required; the UI refuses to build a
  payload without them.
- Server errors (validation 422s, the 409 above, anything else)
  reach the UI with the server's status and message preserved.

### B2. Version 2 manifest entries (image-only imports)

Status: **implemented in Codex's backend and shipped.** The UI
describes image-only entries as part of the manifest they belong
to; there is no pending-backend notice.

Manifest content version 2 gives each entry a `kind`:

- `{ "kind": "image_only", "candidate_id": ..., "target_beer_id":
  ..., "image": { ... } }` imports an image for the EXISTING
  catalog beer `target_beer_id`: the import writes only a
  `beverage_images` row (through the existing verified-bytes S3
  upload path) and creates or changes no beer.
- Entries with `kind: "new_beer"`, and version 1 entries with no
  kind at all, are new-beer imports, exactly as before.

The UI derives the manifest composition from the manifest's own
records (the `kind` of each entry), never from candidate matching:
a candidate that matched a catalog beer counts for nothing here
unless a manifest entry says so. This supersedes the previous
behavior on both sides: on master today,
`server/src/discoveryManifestCore.ts` (`evaluateEligibility`)
refuses a selected candidate with `matched_beer_id` set with
reason `already_in_catalog`, so an image-only record cannot be
imported at all and its presence blocks the batch's manifest build;
the v2 backend replaces that refusal for candidates whose saved
review intent is image-only with an approved image decision.

Canonical JSON, hashing, approval, and void semantics are
unchanged: an image-only entry is inside the same manifest ID and
SHA-256 Frank approves, or it does not import, and the import
executor's revalidation checks apply as before.

### B3. image_url is not editable

Changing a candidate's `image_url` is NOT supported by the current
backend and is deliberately absent from the review-intent payload
(the B1 beer shape has no image_url). A URL change would need a
separate audited refetch and invalidation design: the staged URL is
the provenance for every fetch and hash-bound image decision, so
swapping it silently would orphan those decisions. In particular,
an approved hash NEVER carries over to a new URL: approval binds to
the exact fetched bytes of the current URL, and a different URL is
a different image until it is fetched and decided on its own. The
UI renders `image_url` read-only with this limitation stated next
to it.

## C. Gates stay separate

Four distinct recorded actions, none implying another:

1. A **review intent** (B1) records what should be imported for a
   candidate: a new beer from confirmed field values, or an image
   for one explicitly chosen existing beer. It selects nothing and
   approves nothing.
2. **Candidate selection** (and hold/reject) is a reviewer decision,
   audited per candidate, through the pre-existing decision
   endpoints.
3. An **image decision** approves or rejects the exact fetched
   bytes for one candidate. It publishes nothing by itself: no
   catalog row is created or changed, and no image becomes visible
   anywhere.
4. A **manifest** imports only after Frank approves its exact
   manifest ID and full SHA-256, and the operator executor
   revalidates everything at import time. An approved image reaches
   the catalog only as part of an approved manifest's import (for
   image-only records, once B2 is deployed).
