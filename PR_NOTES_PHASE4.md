# PR notes: discovery hub phase 4 (image preview and hash-bound image decisions)

Stacked on discovery/phase3-decisions (PR #18). Local only: not
pushed, no PR created. This phase implements ONLY the image gate
(hub decision 006 revision 2, issues/001 sections 4 and 5): the
reviewer never views the origin URL for the binding preview; the
API fetches the staged image server-side under documented SSRF
restrictions, stores the bytes content-addressed under their
SHA-256, serves the preview from those stored bytes, and records
image decisions that name a fetch and are refused on hash
mismatch. No manifests, no catalog writes.

## Summary

- Migration 004 adds discovery_image_fetches (one row per fetch
  attempt: ref, SHA-256, verified content type, byte size,
  dimensions, outcome, fetcher identity, fetched_at) and
  discovery_image_decisions (append-only audit; fetch_id is UNIQUE
  so a fetch can be decided exactly once), plus three candidate
  columns (image_decision, image_decision_fetch_id,
  image_decision_at) carrying the current image decision state as
  a same-transaction projection of the audit row.
- The Phase 3 reviewer role gains INSERT and SELECT on both new
  tables (plus sequence USAGE) and UPDATE on the three new
  candidate columns; the role script, both verify scripts, and the
  disposable-DB role test were extended and re-run end to end.
- Restricted fetcher (server/src/discoveryImageFetch.ts) behind
  injectable DNS/transport seams: full address validation at every
  redirect hop, connection pinned to a validated address, 3
  redirects max, no https to http downgrade, 5s connect / 10s
  total timeouts, 10 MB streaming cap, Content-Type image/* AND
  magic-byte verification for jpeg/png/webp/gif/avif, dimensions
  for png/jpeg/gif/webp (avif: null, documented).
- API (server/src/routes/discoveryImages.ts): POST image-fetches
  (201 with the fetch record for success and failure outcomes),
  GET image-fetches history, GET preview (stored bytes, verified
  type, nosniff, CSP sandbox headers), GET image-decisions, POST
  image-decisions (re-hashes the stored bytes as a precondition;
  409 on mismatch, missing object, or already-decided fetch).
  Rate limit: 30 fetches per reviewer per rolling hour, then 429.
- Client: Image Review panel on the candidate detail page. The
  preview renders only from the preview endpoint (authenticated
  blob URL via the new apiGetBlobUrl helper); the staged URL is
  provenance text in the panel, never an img src. Approve/Reject
  bind to the displayed fetch and stay disabled until the preview
  has actually loaded, when the fetch failed, when it is already
  decided, or when a newer successful fetch exists.

## Decision vocabulary (where the docs name it)

- Image decisions: approved / rejected (issues/001 vocabulary for
  candidate images). The audit row in discovery_image_decisions is
  the decision record; the candidate columns image_decision,
  image_decision_fetch_id, image_decision_at are its projection.
- The decision request body is {fetch_id, decision, note?,
  image_sha256?} per issues/001. A supplied image_sha256 that
  disagrees with the fetch is refused 409; independently of what
  the caller sends, the server always re-hashes the stored bytes
  at decision time.
- Fetch outcomes: success, dns_blocked, redirect_blocked,
  downgrade_blocked, too_large, not_image, magic_mismatch,
  unreachable, timeout. These refine the coarser outcome set
  sketched in issues/001 (ok / not_image / unreachable / refused)
  so the reviewer sees exactly which restriction fired; the
  mapping is recorded in migration 004's header comment.

## Fetch-restriction implementation map

| Restriction (decision 006 rev 2) | Enforced in | Proven by |
| --- | --- | --- |
| http/https only, no URL credentials | parseFetchUrl in discoveryImageFetch.ts; route answers 422 before any fetch | fetcher tests: credentialed URL, non-http scheme, unparseable URL |
| DNS rejected when ANY resolved address is private/loopback/link-local/reserved (incl. 169.254.169.254, IPv6 equivalents) | blockedAddressReason range tables + validateAddresses in discoveryImageFetch.ts | fetcher tests: private/loopback/metadata/IPv6 literal URLs, hostname resolving private, hostname with one private address among public ones; address-table unit tests |
| No DNS rebinding window between check and connect | default transport pins the connection to the validated address via a custom lookup | fetcher test: transport receives the pinned address |
| Re-validation at every redirect hop | redirect loop in fetchImageRestricted re-runs parseFetchUrl + DNS validation per hop | fetcher test: redirect chain hopping to a private address on hop 2 |
| Max 3 redirects | MAX_REDIRECTS in discoveryImageFetch.ts | fetcher test: 4 redirects refused (redirect_blocked) |
| https to http downgrade refused | redirect loop scheme check | fetcher test: downgrade refused (downgrade_blocked) |
| Connect timeout 5s, total timeout 10s | CONNECT_TIMEOUT_MS / TOTAL_TIMEOUT_MS; total deadline enforced across hops and body streaming | fetcher test: stalled body exceeds the total deadline (timeout) |
| 10 MB streaming cap, abort as soon as exceeded | streamed body reader with MAX_BYTES check per chunk | fetcher test: over-cap body refused (too_large) with a small test cap |
| Final Content-Type image/* AND magic bytes verify (jpeg/png/webp/gif/avif) | sniffImage + declared-vs-verified agreement check | fetcher tests: non-image type (not_image), image type with wrong magic and declared-vs-magic mismatch (magic_mismatch), success for png/jpeg/gif/webp/avif |
| Preview serves stored bytes with verified type + nosniff + CSP sandbox | GET preview in routes/discoveryImages.ts | route tests: preview bytes and headers; integration test: preview returns the exact stored bytes |
| Every fetch audit-logged; per-reviewer rate limit | fetches row written for every attempt; count query in the fetch route; 429 with the new too_many_requests code | route tests: success and failure rows recorded, 429 at the limit |
| Decision refused on hash mismatch | decision route re-hashes the stored object inside the decision preconditions | route tests: tampered bytes 409, missing object 409, supplied-sha mismatch 409; integration test: tampered object yields 409 and zero audit rows |
| A fetch can be decided only once | UNIQUE(fetch_id) in migration 004 + API pre-check + P2002 mapping to 409 | route tests; integration test: second decision 409 |

## Files changed

New:
- server/db/migrations/004-discovery-image-review.sql
- server/src/discoveryImageFetch.ts
- server/src/discoveryImageFetch.test.ts
- server/src/discoveryImageStore.ts
- server/src/discoveryImageStore.test.ts
- server/src/routes/discoveryImages.ts
- server/src/routes/discoveryImages.test.ts
- server/test/discoveryImages.integration.test.ts
- src/pages/DiscoveryImageReviewPanel.tsx
- src/pages/DiscoveryImageReviewPanel.test.tsx
- PR_NOTES_PHASE4.md

Modified:
- server/prisma/schema.prisma (two models, candidate columns,
  users back-relations)
- server/db/discovery-reviewer-role.sql (image grants)
- server/db/verify-discovery-reviewer.sql (image checks)
- server/db/verify-discovery.sql (viewer checks for image tables)
- server/scripts/test-discovery-roles.sh (applies migration 004,
  runs both integration suites)
- server/src/app.ts (mounts the images router; image services in
  AppDeps for tests)
- server/src/errors.ts (too_many_requests / 429)
- server/src/discoveryWriteDb.ts (header comment)
- server/src/routes/discovery.ts (candidate detail returns the
  image decision state)
- server/src/readOnlyGuard.test.ts (allowlist widened, see
  deviations)
- src/api/client.ts (apiGetBlobUrl)
- src/api/types.ts (DiscoveryImageFetch, DiscoveryImageDecision,
  candidate image decision fields)
- src/pages/DiscoveryCandidateDetailPage.tsx (mounts the panel)
- src/pages/DiscoveryCandidateDetailPage.test.tsx (mock covers the
  panel endpoints; verbatim status now expected twice)
- src/viewer.css (panel styles, mobile textarea sizing)
- docs/DISCOVERY_HUB_RUNBOOK.md (image review section, rollback
  and follow-ups updated)

Not committed (by design): qa-screenshots-discovery-phase4/
(4 screenshots, see Verification).

## Verification (exact commands and results)

Server (in server/):

- `npx jest src/discoveryImageFetch.test.ts src/discoveryImageStore.test.ts src/readOnlyGuard.test.ts`
  68 passed. The SSRF battery lives here: private/loopback/
  metadata/IPv6 literals, hostname resolving private, ANY-address
  private, hop-2 private redirect, downgrade, 4 redirects,
  credentialed redirect target, non-image type, wrong magic,
  declared-vs-magic mismatch, over-cap body, connection refused,
  HTTP 404, stalled-body timeout, URL-shape refusals; success for
  png/jpeg/gif/webp/avif and a followed redirect; the blocked
  address table; store roundtrip, dedupe, missing object.
- `npx jest src/routes/discoveryImages.test.ts`
  22 passed: 401, both 503 paths, 404s, 422s, 429, success and
  failure fetch recording, preview bytes and security headers,
  every decision refusal class (wrong candidate, failed fetch,
  already decided, supplied-sha mismatch, tampered bytes, missing
  object), transaction shape, and no Firebase UID in any payload.
- `DISCOVERY_TEST_OWNER_URL=postgresql://postgres@localhost:54399/unused npx jest`
  (server, full suite): 14 suites passed, 4 skipped (the
  RUN_DB_TESTS-guarded live suites skip without a database), 183
  tests passed, 0 failed. Without the dummy URL the Phase 3
  integration suite throws at load time (pre-existing wart, see
  deviations); the Phase 4 suite skips cleanly either way.
- `npx tsc --noEmit` (server): clean.
- `bash server/scripts/test-discovery-roles.sh` (from repo root):
  ALL DISCOVERY ROLE CHECKS PASSED on a disposable PG16 with
  migrations 001 to 004, all three role scripts, and both verify
  scripts; integration suites 7/7 (Phase 3 decisions 4, Phase 4
  images 3). The image integration suite runs the REAL fetcher and
  transport against a Node http stub origin on 127.0.0.1 (the
  seams waive only the address block, and resolve to 127.0.0.1)
  with a real store in a temp dir: fetch, store, preview, decision
  hash binding, second decision 409, tampered object 409 with
  zero audit rows, not_image outcome.

Client (repo root):

- `CI=true npm test -- --watchAll=false`: 18 suites, 49 tests, all
  passed. The panel suite covers: no fetch yet (provenance as
  text, no img element), fetch button + 429 surfacing, failed
  fetch classes (dns_blocked shown, no preview, no decide
  controls), preview ready (img src is the preview blob URL,
  never the origin; SHA short form, type, dimensions shown;
  approve unlocks only after the img load event and posts
  {fetch_id, decision, image_sha256}), decided fetch (controls
  disabled with the already-decided explanation), and the older
  fetch case (previewable but not decidable when a newer fetch
  exists).
- `CI=true npm run build`: compiled clean (CI=true matters:
  Netlify treats lint warnings as errors; the preview img alt
  text avoids the word "image" per the jsx-a11y rule).

Screenshots (scaffolding in /tmp only: stub API + a temporary
index.tsx harness rendering the detail page against fixture data,
restored afterward; Playwright's own Chromium):

- qa-screenshots-discovery-phase4/desktop-image-review-preview.png
  (1280x800): panel with fetch history, amber preview rendered
  from stored bytes, SHA-256 short form, verified type,
  dimensions, note field, approve/reject.
- qa-screenshots-discovery-phase4/desktop-image-review-fetch-failed.png
  (1280x800): dns_blocked outcome with the block detail and the
  failure alert; no preview, no decide controls.
- qa-screenshots-discovery-phase4/iphone-image-review-preview.png
  and iphone-image-review-fetch-failed.png (390x844): same states,
  single column. All four visually checked.

## Deviations and notes

- Outcome vocabulary refines issues/001's coarser set (see the
  vocabulary section above); recorded in migration 004's header.
- URL-shape refusals (unparseable, non-http(s), credentialed)
  happen before any fetch: the route answers 422 and writes NO
  fetches row, because they are not fetch attempts. The fetcher
  throws FetchRefusedError for the same shapes when called
  directly.
- Fetch POST returns 201 with the fetch record for failure
  outcomes too; the outcome is reviewer-facing data, and the
  client surfaces it. Only transport-level API errors (503, 429,
  422, 404) use error responses.
- AVIF dimensions are null: the ISOBMFF box nesting has no cheap
  unambiguous parse, and dimensions are never faked. PNG, JPEG,
  GIF, and WebP dimensions are parsed for real.
- The decision row snapshots image_source and image_license from
  the candidate at decision time; attribution stays in the
  candidate payload, preserved verbatim by the staging schema.
- The candidate's image decision state needed NEW candidate
  columns (Phase 2/3 provided none for images), so migration 004
  ALTERs discovery_candidates, unlike migration 003 which needed
  no existing-table change. The audit table remains the history;
  the columns are its projection, written in the same transaction.
- readOnlyGuard.test.ts allowlist widened from 4 to 6 files:
  routes/discoveryImages.ts is a genuine mutation module (the
  Phase 3 pattern), and discoveryImageFetch.ts is listed ONLY
  because the text search matches crypto's Hash.update( inside
  the words "hash update"; it performs no database access. Both
  reasons are documented in the test and the module header.
- verify-discovery.sql changed in this phase (it gained the
  image-table viewer checks); earlier phases noted it passing
  unchanged, which no longer describes its content.
- The integration test's seams waive the address block only
  inside the test so the stub origin can live on 127.0.0.1; the
  production validator, including loopback literals, is proven
  by the SSRF battery. No production code path skips validation.
- Pre-existing wart found, not introduced here:
  server/test/discoveryDecisions.integration.test.ts constructs
  its Prisma client at module load, so a bare `npx jest` without
  DISCOVERY_TEST_OWNER_URL fails that suite's load instead of
  skipping. The Phase 4 suite constructs its owner client lazily
  inside beforeAll and skips cleanly. Fixing the Phase 3 suite is
  a one-line change left for its own PR.
- The fetch POST originally serialized the fetcher identity with a
  Prisma include on the reviewer client, which has no SELECT on
  users; it now attaches the identity from res.locals, the Phase 3
  pattern. Found by the integration suite (permission denied for
  table users), fixed, and covered by it.

## Blockers

None. Nothing was pushed, no PR was created, and nothing was
deployed; the branch is local for review.
