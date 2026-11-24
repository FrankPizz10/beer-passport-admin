# PR notes: discovery hub phase 5 (import manifests, hash-bound approval, import executor)

Stacked on discovery/phase4-image-decisions (PR #19). Local only:
not pushed, no PR created. This phase implements ONLY the manifest
gate and the import executor (hub decision 006 revisions 1 and 2,
issues/001 section 4): immutable import manifests, Frank's
hash-bound manifest approval, and the operator import executor with
the five revalidation checks. The executor was exercised ONLY
inside a disposable database (see Rehearsal evidence). No
production, AWS, or live catalog was touched.

## Summary

- Migration 005 adds `discovery_import_manifests` (mf- format id as
  primary key, batch FK, canonical manifest jsonb, unique sha256,
  record_count, build-time catalog fingerprint jsonb, status
  draft/approved/imported/void, builder and approver identity,
  approved_sha256, imported_at) and `discovery_manifest_events`
  (build/approve/void/import audit), with guarded viewer SELECT
  grants.
- The reviewer role gains INSERT + SELECT on both manifest tables
  and UPDATE on exactly the four approval columns
  (`status, approved_by, approved_at, approved_sha256`) of
  `discovery_import_manifests`, plus USAGE on the events sequence.
  Marking a manifest imported is deliberately not granted to any
  API role.
- Manifest builder + API (`server/src/routes/discoveryManifests.ts`,
  canonicalization in `server/src/discoveryManifestCore.ts`):
  build from a batch's selected candidates with a 422 + full
  blocker list when any selected candidate is not import-eligible
  (nothing is created); list + detail; export of the exact hashed
  bytes; hash-bound approve restricted to the
  `DISCOVERY_MANIFEST_APPROVER_USER_IDS` allowlist (unset = nobody,
  fail closed); void for draft/approved. No response contains a
  Firebase UID; the detail response carries a server-computed
  `can_approve`.
- Import executor (`server/scripts/import-discovery-manifest.ts`):
  operator identity only (`DATABASE_URL_ADMIN_LOADER`), manifest id
  + expected sha256 both required. One REPEATABLE READ transaction,
  fixed advisory lock, candidate rows locked FOR UPDATE, all five
  checks inside the transaction, images re-fetched through the
  Phase 4 restricted fetcher and re-hashed (mismatch aborts),
  `--dry-run` that validates everything and rolls back, JSON import
  report.
- Client: Manifests list + detail pages (full hash with copy
  affordance, fingerprint summary, records with image decision
  provenance, approve control rendered only when the API's
  `can_approve` is true and the manifest is a draft, void control,
  Export download), a per-batch "Build import manifest" action on
  the Batches page that surfaces 422 blockers readably, routes, and
  a Manifests nav entry.

## The gate separation, as implemented

- Gate 1 (selection, Phase 3) and gate 2 (image approval, Phase 4)
  are unchanged. Building a manifest consumes their outcomes but
  grants nothing.
- Gate 3 is Frank's alone: the approve endpoint checks the caller's
  `users.id` against `DISCOVERY_MANIFEST_APPROVER_USER_IDS` in the
  API layer (Postgres cannot see Firebase identity). Non-allowlist
  callers get 403; an empty allowlist approves for nobody; a wrong
  hash gets 422; a non-draft manifest gets 409. Approval writes
  status/approved_by/approved_at/approved_sha256 atomically with
  the audit event, and the reviewer role's column grant covers
  exactly those four columns, so no other manifest field can be
  altered through the API write path.
- The executor is the enforcement point for import: it refuses
  (before any write) unless the manifest is `approved` and the
  operator-supplied hash, the stored hash, the approved hash, and
  the recomputed content hash all agree. A production import
  additionally requires Frank's approval of the exact manifest id +
  sha256 recorded out of band; that rule is written into the
  runbook and the executor's header.

## Files

New:

- `server/db/migrations/005-discovery-manifests.sql`
- `server/src/discoveryManifestCore.ts` (+ `.test.ts`)
- `server/src/routes/discoveryManifests.ts` (+ `.test.ts`)
- `server/scripts/import-discovery-manifest.ts`
- `server/scripts/test-discovery-manifests.sh`
- `server/test/discoveryManifests.integration.test.ts`
- `src/pages/DiscoveryManifestsPage.tsx` (+ `.test.tsx`)
- `src/pages/DiscoveryManifestDetailPage.tsx` (+ `.test.tsx`)
- `qa-screenshots-discovery-phase5/` (4 screenshots, not committed
  per the standing convention for QA artifacts; they live in the
  working tree only)

Changed:

- `server/prisma/schema.prisma` (manifest + event models)
- `server/db/discovery-reviewer-role.sql`,
  `server/db/verify-discovery-reviewer.sql`,
  `server/db/verify-discovery.sql` (manifest grants + proofs)
- `server/scripts/test-discovery-roles.sh` (applies migration 005)
- `server/src/app.ts` (mounts the manifests router;
  `discoveryManifestApproverIds` dep), `server/src/errors.ts`
  (403 factory), `server/src/discoveryWriteDb.ts` (header),
  `server/src/routes/discovery.ts` (`imported` review status),
  `server/src/readOnlyGuard.test.ts` (allowlist: the manifests
  router is a genuine mutation module; the core module only for
  crypto Hash.update)
- `src/api/types.ts` (manifest types), `src/api/client.ts`
  (ApiError carries the parsed error body so the build's 422
  blockers render readably)
- `src/pages/DiscoveryBatchesPage.tsx` (+ test mock update),
  `src/App.tsx` (routes), `src/layout/AdminLayout.tsx` (nav)
- `docs/DISCOVERY_HUB_RUNBOOK.md` (manifest lifecycle, the five
  checks, operator procedure, production approval rule, manifest
  rollback, rehearsal)

## Test report

Server unit (local, `npx jest`): 215 passed, 17 skipped, and one
pre-existing suite-load failure documented under Blockers. New:
manifest core 18 tests (canonicalization known-answer vectors
below, eligibility matrix), manifests routes 14 tests (build happy path + hash
integrity, 422 blockers create nothing, zero-selected 422, approve
happy/403/403-empty-allowlist/400/422/409/503, void lifecycle,
export byte-identity, can_approve both ways, no-UID assertions).
`npx tsc --noEmit` clean; the executor script also typechecks
clean standalone (scripts are outside the tsconfig include).

Canonicalization known answers (asserted in tests): canonical
bytes of `{a:1,b:{x:[1,2],y:"z"},c:null}` are
`{"a":1,"b":{"x":[1,2],"y":"z"},"c":null}` + LF with SHA-256
`83c182380de7d1ac854abe4a6c5bc5462b2cd232336cb0022e792412d6230d12`;
`payloadSha256({name:'Test Ale',brewery_name:'Acme'})` is
`85c7f6c335aecaf3305a5b1b14d6e7ef2bcfb6ee08887b8aeb26379b9edeff51`.

Client (local): 20 suites / 60 tests pass, including the new
manifest list/detail tests (draft/approved/imported/void states,
can_approve true/false, approve posts the exact hash, export via
the authenticated blob endpoint) and the batches build-action tests
(success navigation, 422 blocker display). `CI=true` production
build clean.

Roles (disposable DB): `bash server/scripts/test-discovery-roles.sh`
passes end to end, including the new manifest grant proofs (allowed
approval-column UPDATE; sha256 / imported_at UPDATE and DELETE
denied) and the Phase 3/4 integration suites (7/7).

## Rehearsal evidence (Deliverable E)

Command: `bash server/scripts/test-discovery-manifests.sh`
(disposable socket-only PG16, scratch copy of the db-recovery
binaries, uid 65534; base schema from the pre-migration-001 Prisma
schema; migrations 001-005; viewer + reviewer roles; seed users
integration-admin and integration-frank; nothing leaves the
scratch directory).

Seed bundle, built and ingested in the harness:

```
build-discovery-bundle.ts --in candidates-us.json --slug manifest-seed-25 --source openfoodfacts --limit 25
{ "records": 25, "holds_by_reason": { "image_unverified": 2, "metadata_incomplete": 17, "missing_brewery": 6 }, "pairs": 0,
  "candidates_sha256": "667c7c1fa675f2057649b12607b709fb4c014730efdaadd48e7c78112b2bd760" }
ingest: { "status": "inserted", "inserted": 25, "collisions_flagged": 0, "pairs_inserted": 0 }
```

Executor CLI refusals, before any import logic:

```
no-loader-env exit=2: REFUSING TO IMPORT: DATABASE_URL_ADMIN_LOADER is not set (the operator/migration identity is required; the API roles cannot write the catalog).
missing-manifest exit=1: IMPORT REFUSED [check1]: manifest mf-none-20260101-01 does not exist.
```

Integration suite (`RUN_DB_TESTS=1 npx jest
test/discoveryManifests.integration.test.ts`): 7 passed, 7 total.
The suite drives real Phase 3 decisions and one real Phase 4 image
approval flow per candidate against a local stub origin, then:

- Positive: build (3 records: one existing-brewery, two
  new-brewery, two with approved images, one without an image),
  approve-as-admin 403, wrong-hash 422, approve-as-approver 200,
  export byte-hash equals the recorded sha256, real import:
  report beers_inserted 3 / images_inserted 2 / breweries_inserted
  as recorded; new beer ids all above the seeded max (102), in
  manifest order; beverage_images rows approved with verified_at
  and the image decision named in attribution; candidates and
  manifest marked imported; events are build, approve, import.
- Negative 1 (draft): runImport rejects with check `check1`; beer
  count unchanged; manifest still draft.
- Negative 2 (fingerprint): a seeded beer renamed after build +
  approval (count-preserving) aborts with check `check5`
  (fingerprint mismatch); catalog unchanged; manifest still
  approved.
- Negative 3 (decision change): candidate rejected through the
  Phase 3 endpoint after approval aborts with check `check2`;
  nothing written.
- Negative 4 (tampered image): the stub origin serves different
  bytes after approval; the import aborts with check
  `image_refetch`; no beer or image rows written.
- Negative 5 (concurrency): two simultaneous imports of one
  approved manifest produce exactly one success; the loser aborts
  as stale (an ImportRefusedError: check1/check2/stale); beer and
  image counts equal exactly one import.
- Negative 6 (--dry-run): report has dry_run true with the would-be
  id assignment (max beer id + 1); beer/image counts unchanged;
  manifest still approved; candidate still selected.

Offline verification (harness, after the suite):

```
sha256sum: 09b08505d74592ed073f422f48fb2a4b065064c5470db299a98f221e6edb0a47
recorded:  09b08505d74592ed073f422f48fb2a4b065064c5470db299a98f221e6edb0a47
ALL DISCOVERY MANIFEST CHECKS PASSED
```

The full harness was run three times (twice on 2026-11-23, once on
2026-11-24) and passed end to end each time; the 2026-11-24 run's
export hash was
`7372c9d784477d731f2f23e89074e09e156a7c9b2f0844dc9c343c2226660ef9`
(the manifest id embeds the build date, so the hash differs across
days; sha256sum equaled the recorded hash in every run).

Screenshots (stub API + temporary entry harness, restored after):
`qa-screenshots-discovery-phase5/desktop-manifests-list.png`,
`desktop-manifest-detail.png`, `iphone-manifests-list.png`,
`iphone-manifest-detail.png`. The detail shot shows a draft
manifest with the full hash, fingerprint summary, records, and the
approve control visible for the allowlisted account.

## Deviations

- Fingerprint timestamp column: issues/001 names `updated_at` for
  beers and breweries; the catalog tables' timestamp column is
  `last_mod`. The fingerprint uses beers (id, name, brewery_id,
  last_mod), breweries (id, name, last_mod), beverage_images (id,
  beverage_id, status, updated_at). Recorded in the migration 005
  header, the core module, and the runbook.
- "Attached image" means a staged image URL on the candidate. An
  undecided image blocks the build (`image_unverified`) and a
  rejected image blocks it too (`image_rejected`): there is no
  detach operation in Phase 4, so a rejected image must be
  re-fetched and approved before its candidate can be imported.
  This follows decision 006's text (attached images carry an
  approved Phase 4 decision) and is documented in the runbook.
- Image provenance at import: the catalog schema has no dedicated
  provenance column for the candidate image decision, so the
  decision id is recorded in the beverage_images attribution text
  (`Discovery hub import: manifest <id>, candidate <key>, image
  decision <id>`, appended after any staged attribution, capped at
  the column's 512 chars). Documented in the executor header and
  the runbook.
- Concurrency abort shape: under REPEATABLE READ, SELECT ... FOR
  UPDATE on a row a concurrent import already updated raises a
  serialization failure (SQLSTATE 40001 / Prisma P2034) rather than
  returning the new row version. The executor maps that failure to
  a `stale` refusal (nothing written, retry deliberately), which is
  the spec's "aborts as stale" outcome with a specific message.
- Manifest events live in a dedicated `discovery_manifest_events`
  table rather than `discovery_decisions`, whose CHECK requires a
  candidate or pair target. Same conventions otherwise.

## Blockers / known issues

- Pre-existing (not Phase 5): `test/discoveryDecisions.integration.test.ts`
  fails to LOAD under a plain `npx jest` run without the harness
  environment, because its describe body constructs a PrismaClient
  with an unset owner URL (describe.skip still evaluates the body).
  Verified identical at the Phase 4 tip 0df1fd0. The suite passes
  under test-discovery-roles.sh where the env is set. The Phase 5
  suite constructs its clients lazily in beforeAll and does not
  repeat the wart.
- Not done, by design: no production import was run or attempted;
  migration 005 has not been applied anywhere outside disposable
  databases; nothing was pushed and no PR was created. The stacked
  PR (against discovery/phase4-image-decisions) is Frank's/Codex's
  to open after review.
