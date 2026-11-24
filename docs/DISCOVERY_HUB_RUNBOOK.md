# Catalog discovery hub: staging, ingest, and read-only hub runbook

Hub decision 006 and issues/001-catalog-discovery-hub.md govern this
work; decision 005 is the selection policy (US-first, evidence-based).
This runbook covers the read-only phase: the staging schema
(migration 002), the bundle builder and ingest operator tools, and the
read-only hub in the admin. There are no decision endpoints, no
reviewer role, and no catalog writes in this phase. Nothing here
authorizes applying anything to production: every production step
remains a separately approved operator action.

## Schema: migration 002

`server/db/migrations/002-discovery-staging.sql` creates three tables,
fully separate from the catalog tables:

- `discovery_batches` (slug and bundle_sha256 unique; the bundle hash
  is the ingest idempotency key; the bundle manifest is stored
  verbatim as JSONB)
- `discovery_candidates` (the mapped staged fields plus the verbatim
  record in `payload`; image statuses preserved exactly as staged and
  never promoted; `review_status` starts at `pending`;
  `hold_reason` uses the issues/001 vocabulary; `dedupe_outcome` and
  `matched_beer_id` record the ingest-time collision check)
- `discovery_candidate_pairs` (ambiguous-pair relationships; the rival
  is `candidate_id_b` when staged, otherwise `external_ref` carries
  its source:source_record_id)

Application order on any database (verified on a disposable PG16):

1. Catalog base schema.
2. `server/db/migrations/001-image-approval.sql`.
3. `server/db/readonly-role.sql` (creates `beerpassport_admin_viewer`;
   it references `image_review_events`, so it must run after
   migration 001).
4. `server/db/migrations/002-discovery-staging.sql`. The viewer's
   SELECT grants on the three discovery tables are issued inside this
   migration (guarded: if the role does not exist yet, the grants are
   skipped with a notice and must be issued after the role is
   created). Grants ship with the migration, not in readonly-role.sql,
   so readonly-role.sql is unchanged by this phase.

Verify, connected AS the viewer role:

- `server/db/verify-discovery.sql`: discovery reads succeed; INSERT,
  UPDATE, and DELETE on the discovery tables are denied (8 checks).
- `server/db/verify-readonly-role.sql`: unchanged and still the
  catalog-grant verification, with one known interaction: its
  direct-privilege whitelist names the 15 catalog tables, so after
  migration 002 its whitelist check reports exactly 3 "unexpected"
  privileges, which are precisely the three discovery SELECT grants.
  A follow-up change must add `discovery_batches`,
  `discovery_candidates`, and `discovery_candidate_pairs` to that
  whitelist; until then, treat a count of exactly 3 (and no other
  failure in that script) as the expected post-002 result. This was
  verified on the disposable database: every other check in the script
  behaves as before.

Canonical schema: the staging tables must be mirrored into
beer-passport-server's Prisma schema before migration 002 is applied
to production (decision 006, deployment sequence step 1). The copy in
this repo (`server/prisma/schema.prisma`) is downstream; the drift
check reports the discovery models until the server mirror lands.

## Bundles: build off-server, ingest as operator

Bundles are immutable transport artifacts (manifest.json +
candidates.jsonl). They are built wherever the discovery work runs
(agent VM, Frank's Mac, CI), never on the Lightsail host, and are never
committed to git.

Build (one staged file per batch; `--limit N` builds a small seed):

```
cd server
npx ts-node --transpile-only scripts/build-discovery-bundle.ts \
  --in <staged.json> --slug <slug> --source <label> \
  --out <bundle-root> [--title <title>] [--limit N]
```

The builder maps each staged record onto the candidate columns,
derives `hold_reason` deterministically (precedence: missing_brewery,
then origin holds, then duplicate_unresolved, then image_unverified,
then metadata_incomplete; see `server/scripts/discoveryBundleCore.ts`
for the exact rules), extracts ambiguous pairs from cross_match data,
writes candidates.jsonl as canonical JSON (keys sorted), and records
its SHA-256 and counts in manifest.json.

Ingest (operator-run, from the operator's machine):

```
DATABASE_URL_ADMIN_LOADER=postgresql://... \
  npx ts-node --transpile-only scripts/ingest-discovery-bundle.ts <bundle-dir>
```

The ingest refuses to run without `DATABASE_URL_ADMIN_LOADER` (the
operator/migration identity; the API never ingests). It verifies the
candidates hash and record count against the manifest before touching
the database, then:

- Same bundle hash already ingested: prints a `noop` report, exit 0.
- Slug already present with a different hash: refuses. Bundles are
  immutable; changed input is a new batch under a new slug.
- Otherwise it re-checks live-catalog collisions per candidate
  (barcode equality against `beers.upc`, else exact normalized
  name + brewery match) and records `dedupe_outcome` /
  `matched_beer_id` on the candidate row instead of dropping it, then
  loads batch, candidates, and pairs in ONE transaction and prints
  the counts report (inserted, collisions flagged, holds by reason,
  pairs).

Seed order for a new environment (per issues/001 section 5): a small
seed first for end-to-end review (for example
`--limit 25` from the US set), then batch-2 (702), then
reassessment-us (6,817), then reassessment-review (15,315; 694 pair
rows). In production each ingest is its own approved operator action.

## Read-only hub

API (viewer role, existing admin auth):

- `GET /admin-api/v1/discovery/batches`: every batch with grouped
  counts (origin bucket, normalized image status, hold reason, review
  status) and review progress.
- `GET /admin-api/v1/discovery/batches/:id/candidates`: the shared
  list envelope; `q` searches name and brewery; filters
  `origin_bucket`, `image_status` (normalized; `not_staged` selects
  rows with no staged status), `hold_reason` (`none` selects unheld),
  `review_status`, `source`; sort allowlist name, brewery_name, abv.
  Unknown filter values are a 400.
- `GET /admin-api/v1/discovery/candidates/:id`: full detail with
  provenance, origin evidence, image fields, hold reason and note,
  dedupe outcome, and pairs.

UI: the Discovery section in the admin nav (Batches, per-batch
Candidates, Candidate detail). No decision controls exist in this
phase.

## Rollback

All schema is additive and confined to the discovery tables; the
catalog cannot be affected.

1. Revert the API and client deploys (the routes and pages are
   additive; nothing else references them).
2. Optionally drop the staging data:
   `DROP TABLE discovery_candidate_pairs, discovery_candidates, discovery_batches;`
   (order matters: pairs and candidates reference batches). Dropping
   the tables also drops the viewer's grants on them.
3. No other role or env change exists to unwind in this phase (there
   is no DATABASE_URL_DISCOVERY_WRITE until the review phase).

## Follow-ups owned by later phases

- Reviewer role (`beerpassport_discovery_reviewer`), decision
  endpoints, and `DATABASE_URL_DISCOVERY_WRITE` (issues/001 phase 2 in
  the issue's numbering).
- Image fetch/preview with hash-bound decisions, then immutable
  import manifests (issues/001 sections 4 and 6).
- The verify-readonly-role.sql whitelist addition noted above.
- Batch 2's per-record image verification state lives in the POC
  manifest, not in batch-702.json; reproducing issue 001's "170
  verified images" staging state needs that manifest merged into the
  staged records before bundling (see PR_NOTES_PHASE2.md).
