### Catalog discovery hub: staging, bundle ingest, and read-only hub

Implements the read-only phase of hub decision 006 / issues/001
(selection policy decision 005): discovery staging tables, a
hash-verified idempotent bundle ingest, and a read-only hub in the
admin. No decision endpoints, no reviewer role, no
DATABASE_URL_DISCOVERY_WRITE, and no catalog writes of any kind.
Candidates stay staged; image statuses are preserved exactly as
staged and never promoted.

**Schema (server/db/migrations/002-discovery-staging.sql)**

- `discovery_batches`, `discovery_candidates`, `discovery_candidate_pairs`
  per decision 006, mirrored as Prisma models in
  server/prisma/schema.prisma. Indexes on batch, origin_bucket,
  hold_reason, review_status, barcode, normalized name, image status,
  and source.
- The viewer role's SELECT grants on the three tables ship inside the
  migration (guarded if the role does not exist yet);
  readonly-role.sql and verify-readonly-role.sql are untouched.
  `server/db/verify-discovery.sql` (new) proves the viewer can read
  all three tables and cannot INSERT, UPDATE, or DELETE them.

**Bundle builder + ingest (server/scripts/)**

- `discoveryBundleCore.ts`: canonical JSON (keys sorted), record
  mapping, pair extraction, and deterministic hold derivation with the
  documented precedence (missing_brewery, origin holds,
  duplicate_unresolved, image_unverified, metadata_incomplete).
- `build-discovery-bundle.ts`: staged JSON file -> bundle directory
  (manifest.json + candidates.jsonl), `--limit N` for seeds.
- `ingest-discovery-bundle.ts`: operator-run via
  DATABASE_URL_ADMIN_LOADER (refuses without it). Verifies the
  candidates SHA-256 and record count against the manifest before any
  database call; re-ingest of the same bundle hash is a no-op; a known
  slug with a different hash is refused. Live-catalog collisions
  (barcode, else normalized name + brewery) are re-checked per
  candidate and recorded as dedupe_outcome / matched_beer_id instead
  of dropping the record. Batch, candidates, and pairs load in one
  transaction.

**Read-only API (server/src/routes/discovery.ts)**

- GET /discovery/batches: per-batch grouped counts (origin bucket,
  normalized image status, hold reason, review status) and review
  progress. Null groups are explicit: not_classified / not_staged /
  none.
- GET /discovery/batches/:id/candidates: the shared list envelope;
  q searches name and brewery; filters origin_bucket, image_status,
  hold_reason (including 'none'), review_status, source; unknown
  filter values are a 400; sort allowlist name, brewery_name, abv.
- GET /discovery/candidates/:id: full detail with provenance, origin
  evidence, image fields, hold reason/note, dedupe outcome, and pairs.

**Client**

Discovery nav section with a Batches page (counts and progress per
batch), a per-batch Candidates page (search + filter selects +
DataTable), and a Candidate detail page (provenance, origin evidence,
image status, dedupe outcome, read-only pairs list). No decision
controls anywhere.

**Test report**

- Server unit/route suites (local, `npx jest` in server/): 10 suites
  passed, 2 live suites skipped, 78 tests passed, 7 skipped. New:
  scripts/discoveryBundle.test.ts (canonicalization, hold precedence
  incl. batch-2-shaped records, pair extraction, bundle hash/count
  verification, ingest idempotency decisions, mocked runIngest with
  collision + pair classification) and src/routes/discovery.test.ts
  (rollup null-group keys, envelope, filter pass-through and 400s,
  pagination bounds, 404s, 401).
- Server type-check (local, `npx tsc --noEmit`): clean.
- Client (local, repo root): `CI=true npx react-scripts test
  --watchAll=false`: 15 suites, 30 tests passed (3 new Discovery page
  suites). `CI=true npm run build`: compiles clean.
- Disposable-database verification (socket-only PostgreSQL 16.2,
  binaries from the db-recovery workstream, run as uid 65534;
  database `discovery_verify`):
  - Base schema from the pre-migration-001 Prisma schema via
    `prisma migrate diff --from-empty` (14 tables), then migration
    001, then readonly-role.sql, then migration 002 (grant block
    issued the discovery SELECT grants). Note: readonly-role.sql
    references image_review_events, so it must run after migration
    001; the order is documented in the runbook.
  - verify-discovery.sql as the viewer: 8/8 PASS (reads succeed;
    INSERT/UPDATE/DELETE denied on all three tables).
  - verify-readonly-role.sql as the viewer: all checks behave as
    before EXCEPT its direct-privilege whitelist, which names the 15
    catalog tables and therefore reports exactly 3 "unexpected"
    privileges after migration 002: precisely the three discovery
    SELECT grants. A follow-up must add the discovery tables to that
    whitelist (the file is deliberately unmodified in this phase);
    the runbook documents this as the expected post-002 result.
  - Seed bundle (candidates-us.json, --limit 25): built (holds:
    missing_brewery 6, metadata_incomplete 17, image_unverified 2),
    ingested (25 inserted, 0 collisions against the empty catalog),
    ingested again (status noop, 0 inserted), and a tampered copy was
    refused with the SHA-256 mismatch printed, exit 1.
  - Batch 2 full bundle: 702 records built and ingested; holds
    missing_brewery 15 (matches issues/001's known count) and
    image_unverified 687 (see mapping gaps); 0 pairs.
  - Collision proof: two catalog rows planted (one barcode match, one
    normalized name + brewery match); a 30-record seed re-ingest
    flagged exactly 2 collisions with the right matched_beer_id
    values (one per check).
  - Full-set builder reconciliation (built, not ingested):
    reassessment-us 6,817 records (holds: image_unverified 6,685,
    missing_brewery 82, metadata_incomplete 48; 2 records unheld);
    reassessment-review 15,315 records (holds: origin_uncertain
    13,015, missing_brewery 1,766, duplicate_unresolved 534) and 694
    pair rows, matching issues/001's 694 relationships. 160 of the
    694 pair-flagged records also lack a brewery and therefore hold
    as missing_brewery under the mandated precedence; their pair rows
    are still extracted.
  - Live API tests (`RUN_DB_TESTS=1 npx jest
    test/discovery.integration.test.ts`) against the disposable DB
    with the API connected AS the viewer role: 3/3 passed (batch
    counts reconcile to record_count; candidate totals match; the
    hold_reason=none filter returns only unheld candidates).
- Screenshots (Playwright, Playwright's Chromium; CRA dev server with
  the Firebase Auth emulator pointed at a local stub and the API
  pointed at a local stub seeded from the real verification bundles):
  qa-screenshots-discovery/ (NOT committed): desktop-01/02/03 and
  iphone-01/02/03 for the batches page, the batch-2 candidates page,
  and a pair-carrying review candidate's detail page (390x844 and
  1280x800). Visually verified: counts match the ingest reports; the
  detail page renders provenance and sections in the single-column
  mobile layout.

**Staged-data mapping gaps (reported, not invented around)**

- batch-702.json carries no origin_bucket / origin_evidence and no
  image status fields at all. Origin stages as null (rollup key
  not_classified) and draws no origin hold (absence is not the
  'uncertain' bucket); image_status_normalized stages as null
  (not_staged). Under the mandated hold precedence, the 687
  non-missing-brewery batch-2 records land on image_unverified, so
  issues/001 section 5's "687 selectable, 170 verified images"
  staging state cannot be reproduced from this file alone: the
  per-record image verification lives in the POC manifest, not in the
  records. Reproducing it needs the POC manifest merged into the
  staged records before bundling.
- The reassessment files carry fields with no dedicated column:
  country, image_filename, and alternate_sources (the 87 cross-source
  merge links). They are preserved verbatim in the candidate payload;
  image_license and image_page_url do have columns. Merge links are
  provenance, not pairs, and have no row type in this phase.
- The origin evidence signal is fused
  (wikidata_country_p495_else_p17); P17-only and conflicting-evidence
  records cannot be distinguished from the staged files. The hold
  branches for explicit conflict / P17-only markers are implemented
  and unit-tested but fire zero times on current data, consistent
  with decision 005's QID audit (0 P17-only, 0 conflicts in the US
  set).
- Issue 001's bundle shape mentions category_hint; no staged file
  carries it, so there is no column for it.
- The 25-record seed is the head of candidates-us.json, which is the
  Open Food Facts us_market slice: representative of the pipeline,
  not of the full set's Wikidata majority.

**Deployment notes**

docs/DISCOVERY_HUB_RUNBOOK.md covers migration/grant order, bundle
building, ingest operation (including no-op and refusal behavior),
seed-then-full order, and rollback (revert deploys; optionally drop
the three discovery tables; the catalog is never touched). The
staging tables must be mirrored into beer-passport-server's canonical
Prisma schema before migration 002 is applied to production.
