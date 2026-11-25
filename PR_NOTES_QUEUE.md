# PR notes: fast review queue UI (WS2)

Branch: `ui/fast-review-queue` (local only, not pushed). Client and
docs only: nothing under `server/`, no new dependencies, no
production writes. All tests run against mocked clients.

## What this builds

Reviewing 6,817 staged candidates one detail-page load at a time
was the bottleneck. This adds the fast path:

1. **Review queue** (`/admin/discovery/review-queue`): a filterable
   work list for one batch. Filters: All actionable, Needs
   attention (held for missing_brewery / metadata_incomplete /
   unresolved duplicate pair), No image, With image, Already
   reviewed. Every filter maps to the candidates list endpoint's
   own parameters (`review_status`, `hold_reason`, `image_status`);
   filters that span several values are sub-selects, each issuing
   its own server query. Nothing is composed client-side across a
   batch. Server pagination (page size up to 100) with the full
   filtered total shown. Queue position (batch, filter, sub, page)
   lives in the URL query and sessionStorage; returning from a
   guided review restores the same page and highlights the worked
   item.
2. **Guided review** (`/admin/discovery/review-queue/:candidateId`):
   one screen in decision order: staged summary with provenance in
   an expandable "Technical history and provenance" details block;
   match suggestions plus manual catalog search; the stored-preview
   image panel; the four choices (Add new / Add image to existing
   beer / Hold / Reject); and Approve for import. Prev/next moves
   within the filtered queue, fetches the neighboring page at a
   boundary, and prefetches the next item's read-only data
   (candidate, intent, image fetches and decisions, suggestions)
   into a small in-memory cache. Reads only, never writes.
   Keyboard: `[` / `]` or arrow keys for prev/next, `1`-`4` focus
   the four choices, Ctrl+Enter approves when enabled, `?` opens
   shortcut help. Shortcuts never fire while typing in an input,
   select, textarea, or editable element.
3. **Approve for import orchestration**
   (`src/components/reviewQueue/approveFlow.ts`): a state machine
   that (a) saves the review intent only when the current choice
   differs from the saved one, (b) records the image decision
   "approved" only when a valid stored preview fetch exists, no
   image decision is recorded yet, and the chosen mode uses the
   image (a 409 already-decided response, or a decision appearing
   in the audit list, counts as done), and (c) selects the
   candidate, skipping when already selected. A live step checklist
   shows pending / running / done / skipped / failed. Partial
   failure stops the run with the exact server error; Resume
   re-reads intent, fetches, and decisions first and performs only
   the missing steps, so retries never record duplicates. Success
   copy says "Ready for import" and states plainly that nothing is
   published: a manifest must still be built, approved by its exact
   ID and SHA-256, and imported by the operator.
4. **Bulk hold / reject** (queue list only): explicitly checked
   items on the current page, a reason, a confirmation summary
   naming every item, sequential execution, per-item outcomes, and
   a retry-failed-only action. UI copy at the bulk bar states there
   is no bulk Approve, no bulk image decision, and no bulk intent.
5. **Mobile and clarity**: guided view reserves bottom padding for
   a sticky action bar (prev / position / next / Approve) so it
   never covers content; 24px section gaps, 16px card padding,
   44px touch targets, full-width actions at phone widths. The
   header account button opens a menu holding the signed-in email,
   the database target, and Logout; the inline target chip hides at
   440px/390px widths. "Image Queue" is renamed "Catalog Image
   Approvals" in the nav, breadcrumb, and page heading, with
   one-line copy distinguishing Discovery review (staged
   candidates), Catalog Image Approvals (images for beers already
   in the catalog), and Import (the later exact-hash manifest
   approval plus operator import).

## Contracts used

- **Contract A (WS1 match suggestions, parallel PR, NOT yet
  merged)**: `GET /discovery/candidates/:id/match-suggestions` as
  documented in `docs/DISCOVERY_REVIEW_API_CONTRACT.md` section A3.
  On 404 the panel hides with a note and manual search remains.
  Evidence codes render as human-readable chips; `exhaustive:
  false` shows the may-not-cover-the-whole-catalog note.
  Suggestions never auto-select a target.
- **Contract B (WS3 rate limit, parallel PR, NOT yet merged)**: a
  429 image-fetch refusal may carry `retry_after_seconds`; the
  image panel then shows "try again in about N minutes" guidance.
  Without the field, the server message shows verbatim.
- **Contract C**: everything else uses existing endpoints only
  (candidates list, candidate detail, review intent, image
  fetch/preview/decisions, candidate decisions, catalog search).

## Files

New:

- `src/pages/DiscoveryReviewQueuePage.tsx` (+ test)
- `src/pages/DiscoveryGuidedReviewPage.tsx` (+ test)
- `src/components/reviewQueue/approveFlow.ts` (+ test)
- `src/components/reviewQueue/ApproveForImport.tsx`
- `src/components/reviewQueue/GuidedImagePanel.tsx`
- `src/components/reviewQueue/GuidedIntentEditor.tsx`
- `src/components/reviewQueue/MatchSuggestionsPanel.tsx`
- `src/components/reviewQueue/prefetchCache.ts`
- `src/components/reviewQueue/queueFilters.ts`
- `PR_NOTES_QUEUE.md` (this file)

Changed:

- `src/api/discoveryReview.ts`: `getMatchSuggestions` on the
  client, suggestion types, evidence labels,
  `isMatchSuggestionsUnavailable`, `extractRetryAfterSeconds`,
  `intentsEqual`.
- `src/App.tsx`: the two queue routes.
- `src/layout/AdminLayout.tsx`: account menu, "Catalog Image
  Approvals" label, Review Queue nav link and breadcrumb.
- `src/pages/ImageQueuePage.tsx`: heading rename + distinguishing
  lede.
- `src/pages/DiscoveryBatchesPage.tsx`: "Open review queue" link
  per batch.
- `src/pages/DiscoveryCandidatesPage.tsx`: link to the queue for
  its batch.
- `src/pages/DiscoveryManifestsPage.tsx`: one added sentence tying
  manifests to the later exact-hash approval step.
- `src/viewer.css`: queue, guided, checklist, suggestions, account
  menu, sticky bar, and phone-width rules.
- `docs/DISCOVERY_REVIEW_API_CONTRACT.md`: section A3 for the two
  parallel-PR contracts.

Existing tests changed (appended cases only, no existing case
edited): `src/api/discoveryReview.test.ts` (+5 tests),
`src/layout/AdminLayout.test.tsx` (+1 test).

## Test report

- Master baseline before this work (recorded on untouched
  ff3e11b): 26 suites / 106 tests, all passing.
- After: **29 suites / 132 tests, all passing** locally via
  `CI=true npm test`; `CI=true npm run build` compiles clean.
- New coverage: orchestration order and skip logic; partial
  failure at each of the three steps with resume completing only
  the missing steps (exact call sequences asserted on a stateful
  fake client); 409 already-decided treated as done; intent 409
  conflict surfaced; suggestions rendering with evidence chips,
  not-exhaustive note, and 404 fallback; image gate skip note;
  429 timed guidance; filter composition to endpoint parameters;
  bulk hold with per-item outcomes and retry-failed-only; prev/next
  across a page boundary; shortcuts not firing while typing;
  saved-intent preselection.

## Throughput analysis

Reviewer actions counted per item (clicks and key presses,
excluding reading time and typing a hold note). "Before" is the
five-section candidate detail page reached from the candidates
list; "After" is the queue plus guided view.

| Case | Before | After |
| --- | --- | --- |
| Clean new beer with image | ~11 actions, 2 page loads, list place lost | 5: Review, Fetch image, choice 1, Approve for import, `]` |
| Image-only with a suggested match | ~14 actions (manual catalog search, choose, confirm, save, fetch, approve image, select) | 4-5: Review, Use as image-only target, Confirm target, Approve for import, `]` (plus Fetch first if no stored preview) |
| No-image new beer | ~8 actions | 4: Review, choice 1, Approve for import (image step auto-skips with a note), `]` |

The structural savings: one page load per item instead of two,
zero scrolling between five sections, no return trip to the list
to find the next row, and three audited writes collapsed into one
Approve action whose checklist proves what happened.

**Binding constraint: the image-fetch limit.** Only 216 of the
6,817 candidates (3.2%) have image URLs; the other 6,601 never
need a fetch. Stored previews are reused and never auto-refetched,
so the steady state is at most one fetch per with-image candidate.
If the WS3 fetch budget is F fetches per hour, with-image
throughput is at most F items/hour: clearing all 216 with-image
candidates takes at least 216/F hours (3.6 hours at F = 60, 1.8
hours at F = 120; F is a WS3 deployment parameter, not set by this
UI). Worked in queue order, the cap only binds if a reviewer
sustains more than roughly 31 x F total items/hour, so for mixed
passes the binding constraint is reviewer judgment time (an
estimated 60-100 items/hour allowing reading time, up from roughly
30-40 with the old page). For an image-focused pass (the With
image filter), the fetch cap is the whole story.

**Remaining bottlenecks, honestly:**

- 6,685 of 6,817 candidates sit in image_unverified holds and
  6,601 have no image at all. The dominant cost is a human judging
  each record; this UI cuts the mechanics around that judgment,
  not the judgment.
- The Needs attention items (82 missing_brewery, 48
  metadata_incomplete, unresolved pairs) need research or staged
  record fixes that mostly still live outside this flow.
- Image-only confirmation stays one at a time by design; there is
  deliberately no bulk path for it.
- Until WS1 merges, image-only target picking is manual search
  only; until WS3 merges, a 429 shows the raw server message.
- Per-candidate readiness is not publication: the batch still
  needs a manifest, an exact-hash approval, and an operator
  import afterwards.

## Deviations and judgment calls

- `GuidedIntentEditor` is a new controlled component rather than a
  reuse of `DiscoveryCandidateFieldReview`: the orchestration
  needs the choice state (mode, proposed fields, target,
  confirmation) lifted into the page that owns Approve, the sticky
  bar, and the shortcuts. It reuses the same field model
  (`REVIEW_FIELDS`, `validateFieldValue`, `buildNewBeerIntent`,
  the diff helpers), so ABV range/precision rules and payload
  shapes are identical. The existing component and detail page are
  untouched and keep working.
- A saved image_only intent seeds the target as confirmed: the
  confirmation was recorded when that intent was saved, and the UI
  shows "Target confirmed" with a Change target path. A fresh pick
  from suggestions or search always starts unconfirmed. Flagged
  here for review because it is an interpretation of "preselect
  that mode/target as data".
- When the queue URL carries no parameters, the last queue state
  is restored from sessionStorage so a stray navigation does not
  lose the reviewer's place; explicit URL parameters always win.
- `src/qa-harness.tsx` fixture markup still says "Image Queue";
  it is a screenshot fixture, and screenshots are a later pass, so
  it was left alone.

## Blockers / dependencies

- WS1 (match suggestions endpoint) and WS3 (429
  `retry_after_seconds`) are parallel backend PRs, not yet merged.
  The UI is coded to the fixed contracts above and degrades
  gracefully without them; both degradations are covered by tests.
- The production image store (`DISCOVERY_IMAGE_STORE`) remains
  unset per Frank's report; the guided image panel reuses the
  existing plain-language callout for that state. Configuration is
  a server-side step owned outside this workstream.

## WS4 mobile validation

Method: the throwaway QA harness pattern from the earlier phases.
`src/qa-harness.tsx` was temporarily replaced with fixtures for the
queue work (batch of 6,817 with mixed statuses; a Bud Light
candidate with staged ABV 3.2123353678124, `no_match`, and a saved
image-only intent targeting catalog beer #3784; match suggestions
with evidence chips in exhaustive and not-exhaustive variants; a
stored-bytes preview served through the real preview path as a blob;
the `DISCOVERY_IMAGE_STORE`-unset 503 state; and a 429 state with
`retry_after_seconds: 1800`), the fetch layer was stubbed in the
harness only, and `src/index.tsx` pointed at the harness for the
capture build. The queue page, guided review page, and all review
components under test are the real ones. The shell is a fixture
mirroring AdminLayout's current markup and class names with working
nav/account toggles, because the real layout requires a signed-in
Firebase admin; the real layout was not rendered. After capture,
`src/index.tsx` was restored byte-identical and the harness file
was restored to its committed state (it is tracked on this branch;
the WS4 harness source is preserved outside the repo at
`~/workspace/admin-image-workflow/qa-harness-fast-review.tsx`).
Nothing was committed; all fixes below are in `src/viewer.css`
only. No test files were changed.

### Viewport matrix

- iPhone 16 Pro Max emulation: 440x956 CSS px, device scale
  factor 3, mobile/touch, iPhone Safari user agent.
- Narrow phone: 390x844 CSS px, device scale factor 3, same
  emulation.
- Desktop: 1440x900, scale factor 1.
- Driver: Playwright's bundled Chromium over `http://localhost`
  against a production build of the harness entry.

### Screenshot inventory

All under `~/workspace/admin-image-workflow/qa-screenshots-fast-review/`
(28 files, not committed):

- Queue: `queue-desktop.png`, `queue-desktop-full.png`,
  `queue-mobile440.png`, `queue-mobile440-full.png`,
  `queue-mobile390.png`.
- Guided (saved image-only intent, stored preview):
  `guided-desktop.png`, `guided-mobile440.png`,
  `guided-mobile390.png` (full page), `image-preview-desktop.png`,
  `image-preview-mobile440.png`, `image-preview-mobile390.png`
  (image section), `guided-bottom-desktop.png`,
  `guided-bottom-mobile440.png`, `guided-bottom-mobile390.png`
  (scrolled to the end, sticky bar check).
- Guided new-beer (Add new chosen, field comparison):
  `guided-new-desktop.png`, `guided-new-mobile440.png`,
  `guided-new-mobile390.png` (full page).
- Match selection: `matches-suggestions-desktop.png`,
  `matches-suggestions-mobile440.png`,
  `matches-confirm-desktop.png`, `matches-confirm-mobile440.png`
  (confirmation step after "Use as image-only target").
- Error states: `error-store-unset-desktop.png`,
  `error-store-unset-mobile440.png`, `error-429-desktop.png`,
  `error-429-mobile440.png` (full page).
- Shell and popover: `shell-account-menu-mobile440.png`,
  `shell-nav-mobile440.png`, `helptip-mobile390.png`.

Capture notes (honesty about the artifacts): full-page guided and
error captures were taken with the sticky action bar temporarily
set to `position: static` in the capture page only, so the stitched
image does not paint the bar over mid-page content; the bar's real
sticky behavior is what the `guided-bottom-*` viewport captures
show. In mobile full-page stitches, Chromium drops
`(pointer: coarse)` styles while resizing, so coarse-only touch
sizing appears smaller in those files; touch targets were verified
in viewport captures and by direct measurement instead.

### Checks that passed with no defect found

- Section spacing: `.review-section` margin-bottom measures 24px
  (`--bp-space-5`) at every viewport; control gaps are 8-12px
  (action bar 10px, decision actions 8px, mode picker 10px).
- No horizontal scrolling: document overflow-x measured 0 at 440px
  and 390px on every view after the fixes below.
- Sticky action bar: scrolled to the end at all three viewports,
  the bar is fully visible at the viewport bottom and the last
  controls (reason select, note field, Hold/Reject, the Approve
  section) are reachable and not obscured; the 96px bottom padding
  on `.guided-review` does its job. Shortcut hints are hidden on
  phones by design.
- Long values wrap: the unrounded staged ABV (3.2123353678124),
  long batch names, barcodes, provenance URLs, and evidence chips
  all wrap inside their cards at 390px.
- Mobile header: at 440px the header is one row, the database
  target chip is hidden, and email/target/Logout live in the
  account menu (verified open, fully inside the viewport, 44px
  Logout); the nav drawer opens full-width with the Review Queue
  item highlighted. At 390px the header wraps to two rows (toggle
  and title, then Account) - taller, but nothing is clipped or
  unreachable.
- Full-width mobile actions where specified: queue Review buttons,
  the sticky bar's Approve button, and the in-section Approve
  button are full-width at phone widths; Previous/Next share a row
  at 44px.
- Error states read correctly: the store-unset callout shows the
  server message and the plain-language explanation; the 429
  callout converts `retry_after_seconds: 1800` into "try again in
  about 30 minutes" and explains the rolling-hour limit.
- Stored preview: the preview image renders from stored bytes
  through the preview path with SHA-256, verified type, dimensions,
  and fetch time at all viewports.

### Defects found and fixed (all in `src/viewer.css`)

1. HelpTip popover clipped off-screen on phones. At 390px the
   popover for a left-side tip (the Image section heading) opened
   with its left edge at -164px; most of the help text was
   unreadable. The <=760px rule right-aligned the popover to its
   anchor, which only works for right-side tips. Fix: at <=760px
   the popover is now a viewport-anchored sheet (`position: fixed;
   left/right/bottom: 12px`), fully readable at 390px and 440px
   regardless of anchor position (see `helptip-mobile390.png`).
2. Queue Batch select overflowed a 390px viewport. The flex
   wrappers around the filters could not shrink below content
   width, so the long batch name pushed the select to a right edge
   of 394px and clipped its dropdown arrow. Fix: `.rq-filters > div
   { min-width: 0 }` and `max-width: 100%` on the filter controls;
   the select now fits and truncates its label inside the
   viewport.
3. Mode option labels collapsed into a one-word-per-line column.
   Flex shrink squeezed the "1. Add new" / "2. Add image to
   existing beer" labels to min-content (measured 34px wide) at
   every width, desktop included. Fix: the label no longer shrinks
   (`flex-shrink: 0`), the description may wrap (`min-width: 0`),
   and at <=760px the option stacks (label line, description
   below).
4. Intent editor controls were 19px tall on touch devices. The
   catalog search input and the Search catalog / Choose as target /
   Confirm target beer / Change target buttons were not covered by
   any 44px rule (measured 19px at 440px). Fix: a coarse-pointer
   rule gives the editor's buttons and `#guided-target-search`
   `min-height: 44px`, and at <=760px the search input takes its
   own full-width row with the button below it.
5. HelpTip buttons stretched into ovals on touch devices. The
   coarse-pointer container rules (WS2's `.suggestions-panel
   button` rule, and the new editor rule before its exclusion was
   added) also matched the round `?` buttons inside those
   containers. Fix: editor rules exclude `.help-tip-button`, and a
   final coarse-pointer guard (`button.help-tip-button {
   min-height: 0; padding: 0 }`) keeps every HelpTip at its fixed
   round size in any container.
6. Desktop card padding was 18px/20px, not the 16px spec. Queue
   cards were already 16px and phone-width sections were already
   16px; `.review-section` on desktop was the outlier. Fix:
   `.review-section { padding: 16px }` at all widths.
7. Cosmetic: the intent editor's bare `fieldset` showed the
   browser default border, double-bordering the mode cards and
   field rows inside it. Fix: `fieldset.intent-form` border,
   margin, and padding reset (plus `min-width: 0` against the
   fieldset overflow quirk).
8. Cosmetic: the image decision note and hold/reject note
   textareas floated inline beside (or above) their labels on wide
   screens. Fix: both are now block, full-width, under their
   labels.

### Blockers

None. Every defect found was fixable inside client CSS; no issue
had to be left unfixed, and no server or contract change is needed
for any fix above.

### Final regression gate (after all fixes)

- `CI=true npm test`: 29 suites passed, 132 tests passed (same as
  the WS2 finish; no tests changed).
- `CI=true npm run build`: compiled successfully (with the real
  `src/index.tsx` restored).

## Fix pass (Codex review)

Follow-up on branch `ui/fast-review-queue` (was head 8215acd5),
client and docs only: nothing under `server/`, nothing committed
by the fix agent. Three fixes from Codex's review of the fast
review queue.

### Fix 1: approval binds to the image the reviewer actually saw

`runApproveFlow` no longer picks the newest successful fetch. The
guided page now tracks a **reviewed snapshot** `{fetchId, sha256}`
that `GuidedImagePanel` reports only while the stored preview for
that fetch has loaded successfully on screen (`onLoad` sets it;
a load error, a fetch change, or a reload in flight clears it).
The snapshot is passed through `useApproveForImport` into the
flow, and the image step approves EXACTLY that fetch:

- Reviewed fetch gone, not successful, or its recorded hash no
  longer matches the snapshot: step **blocked** (`drift`), nothing
  approved, nothing selected; the page clears the snapshot and
  remounts the image panel so the reviewer must view the current
  preview before resuming.
- Reviewed fetch carries a REJECTED decision: **hard block**
  (`rejected`), flow stops before selection, candidate never
  reported ready. Copy gives the backend-consistent recovery:
  decisions are per-fetch and decided-once (server route
  `discoveryImages.ts`), so fetch a NEW image, view it, and
  approve that fetch; the new decision replaces the rejected one
  as the candidate's current decision.
- Reviewed fetch already APPROVED for exactly the snapshot hash:
  step done, no duplicate decision.
- A 409 from the decision POST is success ONLY after re-reading
  the audit list and verifying the exact reviewed fetch carries
  an APPROVED decision whose `image_sha256` equals the snapshot.
  A 409 caused by a concurrent REJECTED decision is the hard
  block, never success.
- No snapshot (preview never loaded / failed to load): the image
  step cannot run - no decision call. If the image dimension is
  already satisfied by an existing approved decision, the step
  completes on that basis; otherwise it blocks with "view the
  stored preview, then resume".
- A newer fetch arriving after the preview does NOT change what
  gets approved: the flow approves the reviewed fetch id (test
  proves fetch 500 is decided, not the newer 501).

Intent safety on resume: the flow accepts a session baseline
(the saved intent as this reviewer saw it, thereafter the last
revision this flow itself saved - tracked by the runner hook).
If the saved intent has changed to something else, the intent
step stops with a revision conflict and overwrites nothing; the
server's `expected_revision` 409 protection still applies on top.

Readiness honesty: `ready` now requires a pure eligibility
mirror, `imageEligibility` in `approveFlow.ts`, of the manifest
builder's image rules in `evaluateEligibility`
(`server/src/discoveryManifestCore.ts`):

- staged `image_url` non-empty + current decision `rejected`
  -> blocker `image_rejected`;
- staged image + decision not `approved`, or no verifiable
  binding approved decision row for `image_decision_fetch_id`
  -> blocker `image_unverified`;
- intent mode `image_only` + no approved image disposition
  -> blocker `approved_image_required`;
- new beer with NO staged image: no image requirement (the
  builder includes it with `image: null`).

The checklist renders these as "Not ready for import yet" with
the blocker text; the old behavior (image step "skipped" when no
preview existed, then "Ready for import" for a candidate with an
undecided staged image) is gone. The store-unset callout in
`GuidedImagePanel` no longer claims such a candidate "can still
be approved without an image decision".

Changed existing tests (they encoded the flagged behavior):
the approveFlow "image-only without a stored preview" case now
expects a block; the guided-page "approve orchestration" case is
split into blocked-without-preview, ready-after-viewing-preview
(asserts the decision binds fetch 500 + its SHA-256), and
ready-for-no-image cases; two approveFlow fixtures were made
realistic (the fake now projects `image_decision` /
`image_decision_fetch_id` on decision, like the real POST, and
the already-decided fixture carries the binding audit row).

New approveFlow tests: newer fetch after preview; preview load
failure (no snapshot -> no decision, no selection); hash drift;
pre-existing rejected decision; 409-concurrent-approved (done)
vs 409-concurrent-rejected (block); intent changed by another
reviewer (conflict, no overwrite, their intent untouched);
image-only with no staged image (not ready, nothing selected);
image-only happy path; six direct `imageEligibility` cases.

### Fix 2: honest match guidance

- Removed "The candidate is probably a new beer; a manual search
  below can confirm." Empty suggestions now say the search is
  bounded, that no result is NOT proof the beer is new, and that
  manual search is another bounded lookup, not a confirmation.
  The unavailable-endpoint (404) copy says the same about manual
  search. Nothing auto-selects; explicit target confirmation is
  unchanged.
- The "may miss matches" note now shows UNLESS the response
  affirmatively reports a complete catalog search under the
  corrected semantics: `suggestionsSearchComplete` requires
  `completeness.catalog_exhaustive === true`. The legacy
  `exhaustive: true` no longer suppresses the note (it only ever
  meant the token scan was not truncated). Truncated stages from
  the corrected shape are named in the note.
- Corrected contract proposed for the WS1 backend owner in
  `docs/DISCOVERY_REVIEW_API_CONTRACT.md` section A3.1 (additive):
  `completeness: { token_query_complete, catalog_exhaustive,
  stages_truncated: ["barcode_exact" | "name_exact" |
  "similarity_scan"] }`, with semantics: token-query completion
  says nothing about beers the token prefilter never retrieved
  (a typo sharing no token can be missed even untruncated);
  `catalog_exhaustive` is true only when every catalog beer was
  scored. The client type (`MatchSuggestionsCompleteness` in
  `src/api/discoveryReview.ts`) tolerates both shapes.
- Tests: no-shared-token empty result (guidance shown, Add new
  unchosen), legacy `exhaustive: true` still shows the note,
  corrected complete shape suppresses it, truncated stage named,
  same name / different brewery (both shown, neither preselected,
  Approve disabled), barcode evidence (existing), 404 fallback
  (existing).

### Fix 3: review queue correctness

- **Pagination shift (guided prev/next):** navigation no longer
  trusts the stored page. `goTo` re-resolves from FRESH list data
  for the active filter: it anchors on the current candidate's ID
  (its last-known page, then adjacent pages, since a sub-page
  shift can move it across a boundary); if the candidate has left
  the filter entirely, its recorded global index into the fresh
  ordering names the successor (next) or predecessor (previous).
  Tests with a stateful queue fake: decide the last item on page
  1 then Next lands on the true successor (63, not a skip);
  decide a mid-page item then Previous lands on the true
  predecessor; the current item vanishing between loads
  (concurrent decision) resolves to its replacement. The existing
  page-boundary test now asserts a page-2 fetch occurs during
  re-resolution (the current page is re-read first).
- **Bulk retry integrity:** the confirmed run is snapshotted at
  confirmation time - decision, reason, and the exact items with
  their displayed names (`bulkSnapshot`). Retry uses only the
  snapshot and the failed IDs from the outcomes; it no longer
  reads the live reason input (previously changing or clearing
  the reason after a partial failure changed or blocked the
  retry). Test: change the reason to a different value after a
  partial failure; retry still applies the original reason to
  only the failed ID.
- **Image indicators:** audit of `serializeCandidateListRow`
  (`server/src/routes/discovery.ts`): the key
  `image_status_normalized` is always emitted, but the column is
  nullable. Null is the server's own not-staged value (the list
  filter maps null to the `not_staged` filter value; batch counts
  group null under `not_staged`), so null still renders "Image:
  not staged" - with the citation recorded in `queueFilters.ts`.
  Any other unrecognized or absent value now renders "Image:
  unknown" instead of silently defaulting to "not staged".
  Unit tests in `queueFilters.test.ts` plus a queue-page test.

### Disposable end-to-end rehearsal

Runner + suite kept OUTSIDE the repo at
`~/workspace/admin-image-workflow/rehearsal/` (`run-rehearsal.sh`,
`fixpass.integration.test.ts`). It boots a socket-only disposable
PostgreSQL 16 (same pattern as
`server/scripts/test-discovery-manifests.sh`: base schema,
migrations 001-005, viewer + reviewer roles, seeded admin users),
composes the real app with the real restricted fetcher against a
loopback stub origin and a real temp-dir image store, and runs
with `RUN_DB_TESTS=1`. **Result: 5/5 passed.**

1. Review intent: save with `expected_revision: null` -> 201;
   stale revision -> **409**; current revision -> 201; stale
   again -> **409**.
2. Image decisions decided-once: approve -> 201; approve again
   -> **409**; reject after approve -> **409**; exactly one audit
   row.
3. Manifest build with a selected candidate whose image was
   rejected -> **422**, blocker `image_rejected`.
4. Manifest build with a selected image_only candidate and no
   approved image -> **422**, blocker
   `approved_image_required`.
5. Manifest build with a selected no-image new beer and a
   selected approved-image new beer -> **201**; the no-image
   record carries `image: null`, the approved record carries the
   fetched bytes' SHA-256.

Two rehearsal-environment findings (not product bugs):
(a) jest does not exit after this suite without `--forceExit`
(the app's Prisma singletons keep handles open); the runner uses
`--runInBand --forceExit`. (b) `discovery_review_intents` has no
DDL in admin migrations 001-005 - its table ships in the server
repo's mirror migration - so intent routes 500 in the admin
repo's disposable-DB pattern until the table exists; the runner
creates it in the disposable database only, exactly as the
Prisma schema model defines it, with the role scripts' grants.
Worth Codex's attention when the manifests harness next runs:
its intent cases would hit the same gap.

### Gates

- `CI=true npm test` (client): **30 suites / 160 tests, all
  passing** (baseline 29 / 132; +1 suite, +28 tests net). One
  flake seen during the pass: the new bulk-retry test raced the
  post-confirm list reload (outcomes block unmounts while
  loading); fixed by awaiting the retry button with `findByRole`,
  after which the full suite is green.
- `CI=true npm run build`: compiled successfully. (One ESLint
  warning-as-error along the way - the snapshot object is now
  memoized in `GuidedImagePanel`.)
- `tsc --noEmit`: clean.
- Nothing under `server/` was modified; the rehearsal's temporary
  test copy and scratch database are removed on exit.

### Views whose appearance/copy changed (for the WS4 screenshot re-capture)

- Guided review, Image section: store-unset callout text (no
  more "approved without an image decision"); preview load
  failure now also blocks Approve (checklist state, not layout).
- Guided review, Approve checklist: new **blocked** step state
  (warning styling, `!` marker), a blocked-step explanatory note,
  and a "Not ready for import yet" callout listing blockers.
- Guided review, Likely matches: empty-suggestions paragraph
  rewritten; the may-miss note now appears in MORE cases
  (including legacy `exhaustive: true` responses) and names
  truncated stages when provided; 404 note extended.
- Queue list rows: rows with an unrecognized image status now
  read "Image: unknown" (previously "Image: not staged").
- Queue bulk outcomes: retry copy now says the originally
  confirmed reason is used even if the input changed.

## Fix pass screenshot re-capture

Re-captured the new/changed states from the fix pass above into
`~/workspace/admin-image-workflow/qa-screenshots-fixpass/`
(34 files), using the WS4 method: the real queue and guided pages
rendered by the throwaway harness with fixture data only (shell
framing is fixture markup mirroring AdminLayout, as in WS4),
Playwright's Chromium at 440x956 (iPhone 16 Pro Max emulation,
DSF 3), 390x844, and 1440px desktop. The harness was extended from
the preserved WS4 copy (fix-pass copy kept outside the repo at
`~/workspace/admin-image-workflow/qa-harness-fixpass.tsx`) with
three fixtures: candidate #65 whose reviewed fetch (500) carries a
rejected decision, candidate #67 whose fetch (600) changes its
recorded SHA-256 between the panel's read and the approve flow's
re-read, and candidate #68 in the queue with an unrecognized
`image_status_normalized` ("quarantined"). `src/qa-harness.tsx`
and `src/index.tsx` were restored to their committed state after
capture; the tree is otherwise exactly the fix-pass tree.

Captured, per state:

- **Rejected image hard block (#65):** `guided-rejected-{desktop,
  mobile440,mobile390}.png` (full page after clicking Approve for
  import), `guided-rejected-checklist-{desktop,mobile440,
  mobile390}.png`, `guided-rejected-bottom-{desktop,mobile440,
  mobile390}.png`. Intent step skipped (already saved), image step
  blocked with the "!" marker and warning styling, the full
  rejected + fetch-a-new-image recovery copy, select step left
  pending, the blocked-step note, and the button relabeled
  "Resume - finish the remaining steps". One precision: the
  separate "Not ready for import yet" callout does NOT render on
  this path (the rejected finish carries no notReadyReasons); the
  not-ready outcome is stated in the blocked step itself ("this
  candidate cannot be reported ready") plus the blocked-step note.
- **Reviewed snapshot (#61):** `guided-snapshot-image-{desktop,
  mobile440,mobile390}.png` (image panel with the stored preview
  loaded and Approve/Reject image unlocked) and
  `guided-snapshot-mobile440.png` (full page).
- **Drift / re-view required (#67):**
  `guided-drift-{desktop,mobile440}.png` (full page) and
  `guided-drift-checklist-{desktop,mobile440}.png`. After the
  block the panel has remounted and shows fetch 600 with the NEW
  hash (b2b2...), so the reviewer must view the current preview
  before resuming - visibly distinct from the rejected state.
- **Store-unset, new copy (#63):**
  `store-unset-fixpass-{desktop,mobile440,mobile390}.png`
  (callout), `store-unset-fixpass-full-{mobile440,mobile390}.png`
  (full page), `store-unset-fixpass-bottom-mobile440.png`
  (max-scroll). The new text (image step cannot be completed; a
  manifest build would refuse it, image_unverified) is present;
  the old "can still be approved without an image decision"
  wording is gone (asserted absent in the page text).
- **Match guidance:** `matches-note-{desktop,mobile440}.png` -
  the may-miss-matches note now renders ABOVE the suggestions for
  candidate #66 under a legacy `exhaustive: true` response (it no
  longer suppresses the note); `matches-empty-{desktop,
  mobile440}.png` - the empty state for candidate #62 with the new
  bounded-search wording ("not proof the beer is new").
- **Queue "Image: unknown":** `queue-unknown-{desktop,mobile440,
  mobile390}.png` - row #68 reads "Image: unknown".
- **Bulk retry copy:** `bulk-confirm-{desktop,mobile440}.png` and
  `bulk-outcomes-{desktop,mobile440}.png` - a bulk hold over #61
  (succeeds) and #62 (fixture 500) ends with the per-item outcomes
  and the snapshot-retry copy ("with the decision and the
  originally confirmed reason, even if the reason input has
  changed since"). The WS4 set had no bulk outcome capture, and
  the retry paragraph is new copy, so this state is newly covered.

Checks: no horizontal overflow at 440 or 390 in any captured view
(document and body scroll widths equal the viewport width
everywhere). Touch targets measured live at phone widths: queue
Review buttons 44px; guided Fetch / Approve image 44px and Approve
for import 45px under coarse pointers. Sticky bar verified by
measurement, not just by eye: at maximum scroll on the rejected
views the checklist end sits above the bar top (440: 637 vs 678;
390: 525 vs 566; desktop: 622 vs 698), and on the store-unset page
the last section ends at 654 vs bar top 678 with the callout fully
scrollable above the bar. (Two capture artifacts, same class as
WS4: full-page stitches render the sticky bar mid-page, and
element shots of taller-than-viewport elements include the bar
where it overlays the viewport - the measurements above are the
authority, and the bottom viewport shots show the real end state.)

Defects found: **none.** No `viewer.css` change was needed for
the new states (the file's only diff remains the fix pass's own
one-liner). One copy observation, not a layout defect and left
untouched in this capture-only pass: the checklist renders a
blocked step's message with the same "Failed:" prefix it uses for
failed steps (see the checklist screenshots); the step is labeled
"blocked" with the "!" marker, so the state is unambiguous, but
the prefix wording belongs to the fix owner if it is worth
changing.
