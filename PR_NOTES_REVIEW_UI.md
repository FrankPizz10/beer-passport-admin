### Integration feedback adjustments (2026-11-24)

Applied on top of the original PR per Frank's integration feedback.
The PR stays DRAFT: Codex's backend is implemented locally and its
contract is integrated against, but it is not deployed or merged.

#### Changes

- **Review intent replaces field edits.** `DiscoveryReviewClient`
  gains typed `getReviewIntent` / `saveReviewIntent` against the
  Frank-supplied contract (contract doc section B1, listed separately
  in new section A2 because the endpoints are not in master):
  `GET /discovery/candidates/:id/review-intent` returns null or
  `{id, candidate_id, intent, created_at}`; POST takes
  `{expected_revision, intent}` where expected_revision is the last
  returned intent id or null. The old `saveFieldEdits`
  NotYetAvailable stub is gone; field editing is expressed through
  the new_beer intent. `requestImageOnlyManifest` is also gone (see
  composition below). Server errors are preserved end to end: the
  client lets `ApiError` (status + the server's message) propagate
  untouched, the UI displays the server's own words (a 422 test
  asserts the exact message), and 409 is distinguished via
  `isReviewIntentConflict`.
- **Candidate detail: Review Intent section** (the field-review
  component, reworked). On load it fetches the saved intent; the
  form is gated until that load settles and seeds the form, so a
  reviewer can never type into (or save from) an unseeded form.
  - New-beer mode starts from the staged values (or the saved
    intent's beer snapshot) with per-field editing of all seven
    intent fields (name, brewery_name, style, abv, ibu, barcode,
    description); saving posts the full payload with nulls for
    empty optionals. Saving unchanged values is the explicit
    accept-as-staged action.
  - Image-only mode is an explicit reviewer choice, NEVER inferred
    from `matched_beer_id`. Detector output (`matched_beer_id`,
    `dedupe_outcome` incl. `no_match`) is displayed as staging
    information only. The target picker searches the existing
    catalog endpoint (`GET /catalog/beers?q=`, verified in
    server/src/routes/catalog.ts), so a target can be found when
    the detector reported no_match (the staged Bud Light case);
    picking a result is not saving - the reviewer must explicitly
    confirm the named beer (id + name) before the save enables.
  - A saved intent is shown (mode, target beer or beer snapshot,
    saved-at, revision) and can be replaced, sending its id as
    expected_revision. A 409 switches the section to a
    reload-required state with a reload action; nothing overwrites.
  - Controls are disabled with an explanation when the candidate is
    not pending. Copy states saving an intent is distinct from the
    select/hold/reject decision, in both directions (a test asserts
    an intent save never calls the decision path).
- **ABV ceiling removed.** Hard errors only for non-numeric ABV or
  outside [0, 100] (the backend's range); 25 and 100 are valid. The
  >2-decimal precision warning is unchanged (3.2123353678124 warns,
  never auto-corrects, and accept-as-staged saves it verbatim).
  IBU gained a numeric-when-present check.
- **image_url is read-only.** It renders without an input, with the
  limitation stated (changing it needs a separate audited refetch
  and invalidation design; an approved hash never carries over to a
  new URL), and it is excluded from the intent payload and the diff
  (asserted in tests). Contract doc section B3 records this.
- **Existing-beer panel is intent-driven.** It renders only when a
  saved image_only intent exists, targets the intent's
  `target_beer_id` (name resolved via GET /catalog/beers/:id), and
  keeps the provenance display and hash-bound preview behavior.
  With no intent it renders nothing even when `matched_beer_id` is
  set (asserted in both the component suite and the image panel
  suite). The candidate page bumps a refresh key after an intent
  save so the panel re-reads the intent.
- **Manifest composition derives from manifest records.**
  `getManifestComposition` counts entries by their own `kind`:
  `image_only` (carrying `target_beer_id` and an image) vs
  `new_beer` or no kind (version 1 = all new beers). The
  candidates-endpoint paging derivation and `getBatchComposition`
  are removed. The section names the exact manifest ID and SHA-256
  it covers; the page's hash display and hash-bound approve gate
  are unchanged; the pending-backend notice stays (version 2
  backend implemented locally, not reviewed or deployed).
  `DiscoveryManifestRecord` gains optional `kind` /
  `target_beer_id`.
- **Contract doc** restructured: section A gains the catalog list
  endpoint; new section A2 lists the review-intent endpoints as a
  supplied contract (not verified in master); B1 is replaced by the
  full review-intent contract; B2 now describes version 2 manifest
  entries; B3 records the image_url limitation; section C lists
  four distinct recorded actions (intent, selection, image
  decision, manifest approval).

#### Test report (adjustments)

- CI=true npm test: **25 suites / 96 tests passed, 0 failed**
  (was 82; +14 net new/rewritten). Verified stable across four
  consecutive full runs. Coverage added/updated: intent load (null
  and existing, incl. expected_revision on replace), new_beer
  payload shape (all seven fields, nulls, staged defaults,
  accept-as-staged saving 3.2123353678124 verbatim), image_only
  save via searched target + explicit confirm for a no_match
  candidate, 409 -> reload state and refetch, non-pending controls
  disabled, ABV (warning case, 25 valid, 100 valid, 101 hard
  error), image_url read-only + absent from payloads, server 422
  message preserved verbatim, intent save never calls the decision
  endpoints, panel intent-driven (incl. no-intent-with-match and
  error states), manifest composition from kinds (mixed v2, v1 all
  new beers, empty), pending-backend notice still rendered.
- One component fix fell out of load testing: the intent form is
  now gated until the intent load seeds it (previously a late seed
  could overwrite early typing under load; the flake showed up as
  intermittent full-suite failures on the shared VM and is fixed at
  the component level, with per-test timeouts raised in the three
  async-heavy suites as headroom).
- One pre-existing suite needed a mock update:
  `DiscoveryImageReviewPanel.test.tsx`'s GET mock now answers the
  review-intent endpoint with null (its candidates have no saved
  intent); no assertions changed.
- CI=true npm run build: **Compiled successfully.**

#### Remaining integration blockers

- Codex's review-intent + version 2 manifest backend: implemented
  locally, not reviewed, merged, or deployed. Until deployment,
  intent loads/saves fail with the deployed server's error (shown
  verbatim in the UI) and production manifests remain version 1.
- The review image store configuration and the Bud Light live image
  test remain Codex's deployment work, untouched here.

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
