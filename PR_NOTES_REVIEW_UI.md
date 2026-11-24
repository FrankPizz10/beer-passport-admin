### Catalog review workflow UI (DRAFT: two backend capabilities pending Codex)

Client + docs only, from master 987a61d (merge of admin PR #22). No
server changes, nothing merged or deployed. Open as a DRAFT: the UI
is complete and tested against the endpoints that exist, and the two
missing backend capabilities are typed in the client interface and
specified in the contract doc.

#### Files

New:
- `docs/DISCOVERY_REVIEW_API_CONTRACT.md` - the contract (below).
- `src/api/discoveryReview.ts` - `DiscoveryReviewClient` interface +
  HTTP implementation over the existing api client, plus the pure
  field-review model (field defs, diff, validation) and the batch
  composition counter.
- `src/components/DiscoveryCandidateFieldReview.tsx` - original vs
  proposed field table with diff and validation.
- `src/components/DiscoveryExistingBeerPanel.tsx` - explicit
  existing-catalog-beer panel for matched candidates.
- `src/components/DiscoveryManifestComposition.tsx` - "What will be
  imported": new beers vs image-only split for a manifest's batch.
- Tests: `src/api/discoveryReview.test.ts`,
  `src/components/DiscoveryCandidateFieldReview.test.tsx`,
  `src/components/DiscoveryExistingBeerPanel.test.tsx`,
  `src/components/DiscoveryManifestComposition.test.tsx`,
  `src/pages/DiscoveryImageReviewPanel.review.test.tsx`.

Modified (wiring only, +15 lines total):
- `src/pages/DiscoveryCandidateDetailPage.tsx` - mounts the field
  review section.
- `src/pages/DiscoveryImageReviewPanel.tsx` - mounts the
  existing-beer panel; adds the decision-is-not-import gate copy next
  to the approve/reject actions.
- `src/pages/DiscoveryManifestDetailPage.tsx` - mounts the
  composition section. The manifest ID, full SHA-256 display, and
  the hash-bound approve flow are unchanged.

#### Existing endpoints used (verified in server code, contract section A)

GET candidate detail, GET candidate decisions, POST candidate decide
(select/hold/reject/unhold), GET/POST candidate image-fetches, GET
image-fetch preview (stored bytes only), GET/POST candidate
image-decisions, GET /catalog/beers/:id (matched beer name), GET
batches, GET batch candidates (review_status filter, server-side
pagination), GET manifest detail, POST manifest approve {sha256}.

#### The two contract gaps (contract section B, for Codex)

1. Candidate field edits: proposed
   `PATCH /discovery/candidates/:id/fields` carrying per-field
   {field, original, proposed}, server validation, stale-original
   409, and an audit event with original + proposed values. The
   grant/schema tension is named, not decided: the reviewer role's
   UPDATE grant covers only decision columns (migration 003), so
   Codex picks between widening the grant, a separate
   reviewer-writable proposed-values table the builder resolves, or
   apply-on-select proposals. UI: full field table, diff, and
   validation today; save throws NotYetAvailableError and the
   section shows the pending-API state. Decisions are unaffected.
2. Image-only manifest entries: manifest entries of kind image_only
   {candidate_id, beer_id, image decision ref} whose import writes
   only a beverage_images row. Current blocker, verbatim from
   server/src/discoveryManifestCore.ts (evaluateEligibility, line
   290): a selected candidate with matched_beer_id is refused with
   reason already_in_catalog, so image-only records cannot be
   imported at all today, and a selected one blocks the batch's
   manifest build. UI: image-only candidates are counted and listed
   separately with a "Pending backend support" badge, never
   presented as part of a manifest.

#### Behavior notes

- ABV precision (the staged 3.2123353678124 case): a warning in read
  mode and in edit mode, never an auto-correction and never a hard
  block; ABV outside [0, 20] or non-numeric is a hard error; name
  and brewery are required. Values are handled as strings end to
  end so staged precision is never silently reformatted.
- The image preview renders only the API preview endpoint's stored
  bytes (existing behavior, kept); the origin URL is text-only
  provenance everywhere new UI renders it.
- Composition counts page the candidates endpoint until the
  server-reported total is covered; batch views show the batch's
  full record count (6,817 for the production batch). Nothing
  implies sample-only approval.
- Accessibility: labelled inputs, aria-describedby field issues,
  aria-live announcements for issues/diff/save state, role=alert
  summaries, text badges (not color-only), Loading/Empty/Error
  states reused from src/components/States.tsx.

#### Test report

- Baseline on untouched master: CI=true npm test, 20 suites / 60
  tests passed.
- After: CI=true npm test, 25 suites / 82 tests passed, 0 failed
  (all pre-existing tests green; +22 new tests covering the
  interface paths and NotYetAvailableError, ABV validation incl.
  3.2123353678124 warning and 25 hard error, changed-fields-only
  diff, pending-API save state, existing-beer panel incl. error
  state, preview src bound to the blob/preview path and never the
  origin URL, decision-vs-import copy, composition counts incl.
  two-page paging, and empty/error states).
- CI=true npm run build: Compiled successfully.

#### Deviations

- The matched beer's name is not in the candidate API (only
  matched_beer_id); the panel resolves it through the existing
  catalog endpoint GET /catalog/beers/:id and degrades to id-only
  with an error state if that load fails.
- Batch composition needs a matched-beer split the batches endpoint
  does not expose; it is computed by paging the candidates list
  endpoint with its existing review_status=selected filter, as the
  contract doc records.
- Existing page tests mock ../api/client; the new components take an
  injectable DiscoveryReviewClient (defaulting to the HTTP
  implementation) and their tests mock at that interface level, per
  the brief.

#### Blockers

- Codex: contract B1 (field edits endpoint + grant/schema choice)
  and B2 (image_only manifest entries + importer branch). Until B1
  ships, field edits cannot be saved; until B2 ships, image-only
  records cannot be imported and a selected image-only candidate
  blocks its batch's manifest build.
- The review image store configuration and the Bud Light live image
  test are Codex's deployment work, untouched here.
