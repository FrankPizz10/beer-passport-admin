# Catalog discovery hub: staging, ingest, hub, and decisions runbook

Hub decision 006 and issues/001-catalog-discovery-hub.md govern this
work; decision 005 is the selection policy (US-first, evidence-based).
This runbook covers the staging schema (migration 002), the bundle
builder and ingest operator tools, the read-only hub in the admin,
and the decision phase (migration 003, the
beerpassport_discovery_reviewer role, and the candidate-selection
decision endpoints). The decision phase implements ONLY the first of
the program's three approval gates (candidate selection): there are
no image decisions, no import manifests, and no catalog writes.
Nothing here authorizes applying anything to production: every
production step remains a separately approved operator action.

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
  Migration 003 adds a fourth (the viewer's SELECT on
  discovery_decisions), so the expected count after migration 003 is
  exactly 4. A follow-up change must add `discovery_batches`,
  `discovery_candidates`, `discovery_candidate_pairs`, and
  `discovery_decisions` to that whitelist; until then, treat a count
  of exactly 4 (and no other failure in that script) as the expected
  post-003 result. This was verified on the disposable database: every
  other check in the script behaves as before.

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
Candidates, Candidate detail).

## Decisions: migration 003 and the reviewer role

`server/db/migrations/003-discovery-decisions.sql` adds ONE table,
`discovery_decisions`: the append-only audit trail for review
decisions (candidate id and/or pair id, the decision, from/to status,
reason, note, the decider's users id and Firebase UID, created_at).
The UID is stored only in this table and is never serialized by the
API. No existing table changes: the decision columns the endpoints
write already exist from migration 002. The migration also issues
the viewer's SELECT grant on the new table (guarded, the migration
002 pattern).

`server/db/discovery-reviewer-role.sql` creates
`beerpassport_discovery_reviewer` with the same restricted attributes
as the approver (LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
NOINHERIT, NOREPLICATION, NOBYPASSRLS, CONNECTION LIMIT 5) and
exactly these grants (issues/001 section 3):

- SELECT on discovery_batches, discovery_candidates,
  discovery_candidate_pairs, discovery_decisions, beers, breweries.
- UPDATE (review_status, hold_reason, duplicate_of_candidate_id,
  updated_at) on discovery_candidates.
- UPDATE (status, decided_by, decided_at) on
  discovery_candidate_pairs.
- INSERT and SELECT on discovery_decisions, USAGE on its id sequence.
- Nothing else: no INSERT or DELETE on candidates or pairs, no write
  on any catalog table, no access to users.

Application order on any database (verified on a disposable PG16 by
`server/scripts/test-discovery-roles.sh`):

1. Catalog base schema, migration 001, readonly-role.sql, migration
   002 (the read-only phase order above).
2. `server/db/migrations/003-discovery-decisions.sql`.
3. `server/db/discovery-reviewer-role.sql` as superuser, with the
   role password supplied out of band:
   `psql -d <database> -v reviewer_password='<set-at-deploy-time>' -f server/db/discovery-reviewer-role.sql`
4. Set `DATABASE_URL_DISCOVERY_WRITE` for the API to the reviewer
   role's connection string, in
   `/etc/beerpassport/secrets/admin-api.env` alongside DATABASE_URL
   and DATABASE_URL_WRITE. Never point it at the owner, viewer, or
   approver identity.
5. Deploy the API and the client.

Kill switch: unset `DATABASE_URL_DISCOVERY_WRITE` and restart the
API. The decision endpoints answer 503; all browsing (including the
audit reads, which run on the viewer) keeps working.

Verify, after applying:

- Connected AS the reviewer:
  `server/db/verify-discovery-reviewer.sql` (24 checks: attributes,
  memberships, ownership, the privilege whitelist, the allowed writes
  succeeding, and every other write denied, including UPDATE of a
  non-decision candidate column, INSERT into discovery_candidates,
  UPDATE on beers, and DELETE anywhere).
- Connected AS the viewer: `server/db/verify-discovery.sql` still
  passes unchanged.
- From Frank's network: open a staged candidate, record a hold with a
  reason, unhold it, and confirm both rows appear in the batch
  Decision Audit view with the decider's name.

Decision API (reviewer role; same admin auth as every route):

- `POST /admin-api/v1/discovery/candidates/:id/decide`
  {decision, reason?, note?}: decision is select, hold, reject, or
  unhold (issues/001 vocabulary). Hold and reject require a reason
  from the hold-reason vocabulary ('other' requires a note). A held
  candidate cannot be selected, and a select is refused while an
  unresolved duplicate pair exists. Rejected and superseded are
  final. Answers 503 when DATABASE_URL_DISCOVERY_WRITE is unset.
- `POST /admin-api/v1/discovery/pairs/:id/decide` {decision, note?}:
  decision is same or distinct. 'same' supersedes the flagged
  candidate and sets its duplicate pointer in the same transaction;
  the audit row records the issues/001 action (mark_duplicate /
  mark_distinct).
- `GET /admin-api/v1/discovery/candidates/:id/decisions` and
  `GET /admin-api/v1/discovery/batches/:id/decisions`: the audit
  trail (viewer role), newest first.

UI additions: decision controls and decision history on the
candidate detail page, the side-by-side pair review at
Discovery > pair (linked from the candidate detail), and the batch
Decision Audit view linked from each batch card.

Rollback for the decision phase:

1. Revert the API and client deploys.
2. Unset `DATABASE_URL_DISCOVERY_WRITE` (the kill switch above);
   decision endpoints stop answering while browsing continues.
3. Optionally drop the reviewer role (after revoking its grants:
   run the role script's clean-slate section in reverse, or
   `DROP ROLE beerpassport_discovery_reviewer` once no session uses
   it) and drop the audit table: `DROP TABLE discovery_decisions;`
   (this also drops the viewer's grant on it).
4. Candidate and pair review_status values already written by
   decisions REMAIN as they are: they are the audit history of what
   was decided, and the decisions table (if kept) explains each one.
   Resetting decided candidates back to pending is a data change
   that needs its own approved operator action; it is not part of
   this rollback.

## Image review: migration 004, the image store, and hash-bound decisions

`server/db/migrations/004-discovery-image-review.sql` adds two
tables and three candidate columns:

- `discovery_image_fetches`: one row per server-side fetch attempt
  of a candidate's staged image (the ref fetched, SHA-256, verified
  content type, byte size, dimensions, outcome and failure detail,
  the fetcher's users id and Firebase UID, fetched_at). The UID is
  stored only in this table and is never serialized by the API.
- `discovery_image_decisions`: the append-only audit for image
  decisions (fetch id, UNIQUE so a fetch can be decided exactly
  once, the image hash and provenance snapshot the decision binds
  to, decision, note, the decider's users id and UID, decided_at).
- `discovery_candidates.image_decision`,
  `image_decision_fetch_id`, `image_decision_at`: the current image
  decision state, written in the same transaction as the audit row.
  The audit table is the history; these columns are its projection.

The reviewer role gains INSERT and SELECT on both new tables (plus
USAGE on their id sequences) and UPDATE on the three new candidate
columns; nothing else changes. `verify-discovery.sql` now also
checks the image tables from the viewer's side (reads succeed, all
writes denied), so the Phase 3 note above that it passes unchanged
no longer applies to its content, only to its result.

Application order on any database (verified on a disposable PG16 by
`server/scripts/test-discovery-roles.sh`, which now applies
migration 004 and runs both integration suites):

1. The read-only and decision phase order above, through migration
   003.
2. `server/db/migrations/004-discovery-image-review.sql`.
3. Re-run `server/db/discovery-reviewer-role.sql` as superuser
   (idempotent; it adds the new grants).
4. Create the image store directory (below) and set
   `DISCOVERY_IMAGE_STORE` for the API.
5. Deploy the API and the client.

The image store: fetched bytes live OUTSIDE the database in a
content-addressed directory whose root is the API env var
`DISCOVERY_IMAGE_STORE`. Object path is
`<root>/<first 2 chars of sha256>/<sha256>`; identical bytes are
stored once no matter how many fetches return them. Suggested host
path: `/var/lib/beerpassport-admin/discovery-images`, owned by the
API's service user, mode 750, on the API host's local disk. Sizing:
bytes are stored only for candidates a reviewer actually fetches
(reviewed candidates only, never the whole staged pool); at the
10 MB per-image cap, even 1,000 reviewed candidates stay under
10 GB, and typical product images are far smaller. If
`DISCOVERY_IMAGE_STORE` is unset, fetch and preview answer 503/404
and image decisions cannot be recorded; browsing is unaffected.

Fetch restrictions, as implemented in
`server/src/discoveryImageFetch.ts` (each one is proven by the
unit-test SSRF battery in `server/src/discoveryImageFetch.test.ts`):

- http and https URLs only; URLs with embedded credentials are
  refused. URL-shape refusals happen before any fetch and are
  answered 422 with no fetches row (they are not fetch attempts).
- DNS is resolved first and EVERY resolved address is checked
  against blocked ranges: private, loopback, link-local (including
  169.254.169.254), CGNAT, documentation, benchmarking, multicast,
  and reserved IPv4 ranges, plus the IPv6 equivalents (loopback,
  link-local, unique-local, multicast, documentation, discard,
  NAT64 well-known prefix, and IPv4-mapped addresses judged by
  their embedded IPv4 address). If ANY address is blocked, the
  fetch is refused (outcome dns_blocked). The connection is then
  pinned to a validated address, so the name cannot re-resolve to
  a different address between the check and the connect.
- Redirects are followed manually, at most 3, and every hop goes
  through the full URL and DNS validation again (a hop to a blocked
  address is outcome redirect_blocked; a credentialed or malformed
  hop is refused the same way). An https to http downgrade is
  refused (outcome downgrade_blocked).
- Connect timeout 5s, total timeout 10s (outcome timeout).
  Connection and HTTP failures are outcome unreachable.
- The body is streamed with a 10 MB cap, aborted the moment the
  cap is exceeded (outcome too_large); bytes are never buffered
  unboundedly.
- The final Content-Type must start with image/ (else outcome
  not_image) AND the magic bytes must verify as jpeg, png, webp,
  gif, or avif and agree with the declared subtype (else outcome
  magic_mismatch). The recorded content type is the VERIFIED type
  from the magic bytes. Dimensions are parsed for png, jpeg, gif,
  and webp; avif dimensions are recorded as null (no cheap
  unambiguous parse of the nested ISOBMFF boxes).
- Rate limit: 30 fetches per reviewer per rolling hour, counted
  from discovery_image_fetches; further fetches answer 429 until
  the window moves.

Image decision API (reviewer role; same admin auth as every route):

- `POST /admin-api/v1/discovery/candidates/:id/image-fetches`:
  fetches the candidate's staged image URL under the restrictions
  above, stores the bytes on success, and records the fetches row
  either way. Answers 201 with the fetch record for success AND
  failure outcomes (the outcome is data). 422 when the candidate
  has no fetchable http(s) image URL; 429 at the rate limit; 503
  when the write client or the image store is unconfigured.
- `GET /admin-api/v1/discovery/candidates/:id/image-fetches`: the
  fetch history (viewer role), newest first.
- `GET /admin-api/v1/discovery/image-fetches/:fetchId/preview`:
  serves the STORED bytes with the verified content type plus
  `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox`. The
  reviewer never previews the origin URL; the approved hash is the
  hash of these exact bytes. 404 when the fetch did not succeed or
  the stored object is missing (re-fetch to restore the evidence).
- `POST /admin-api/v1/discovery/candidates/:id/image-decisions`
  {fetch_id, decision, note?, image_sha256?}: decision is approved
  or rejected (issues/001 vocabulary for candidate images). The
  server re-hashes the stored bytes as a decision precondition:
  a missing object or a hash that no longer matches the fetch's
  recorded SHA-256 refuses the decision with 409, as do a fetch
  that is already decided and a caller-supplied image_sha256 that
  disagrees with the fetch. A fetch that belongs to another
  candidate answers 404; a fetch whose outcome was not success
  answers 422. On success, one transaction inserts the audit row
  and updates the candidate's image decision columns.
- `GET /admin-api/v1/discovery/candidates/:id/image-decisions`:
  the image decision audit (viewer role), newest first.

UI additions: the Image Review panel on the candidate detail page
(staged provenance as data, Fetch image button, fetch history,
preview rendered only from the preview endpoint through an
authenticated blob URL, SHA-256 short form, verified type and
dimensions beside the preview, approve/reject bound to the
displayed fetch and gated on the preview actually loading, and the
image decision history).

Kill switches: unset `DATABASE_URL_DISCOVERY_WRITE` and restart
the API to stop fetches and image decisions (503) while browsing
continues; unset `DISCOVERY_IMAGE_STORE` to disable fetching and
previews as well.

Rollback for the image phase:

1. Revert the API and client deploys.
2. Unset `DATABASE_URL_DISCOVERY_WRITE` (and optionally
   `DISCOVERY_IMAGE_STORE`); fetch, preview, and image-decision
   endpoints stop answering while browsing continues.
3. Delete the image store directory to drop the stored bytes (the
   fetches and decisions rows keep the hashes and provenance, so
   the audit of what was decided survives; previews are gone until
   a re-fetch).
4. Only on full teardown, drop the image tables and columns in
   dependency order: `DROP TABLE discovery_image_decisions,
   discovery_image_fetches;` then
   `ALTER TABLE discovery_candidates DROP COLUMN image_decision,
   DROP COLUMN image_decision_fetch_id, DROP COLUMN image_decision_at;`
   (the candidate column drops go with the tables in migration
   004's teardown; recorded image decisions are audit history and
   are not reset by a rollback).

## Import manifests: migration 005, hash-bound approval, and the import executor

Phase 5 is the only path from staged candidates to live catalog
rows. It implements hub decision 006 revisions 1 and 2: three
separate approval gates, and no gate implies another.

1. Candidate selection (Phase 3): a reviewer selects candidates and
   resolves their duplicate pairs.
2. Candidate image approval (Phase 4): a reviewer approves the exact
   fetched bytes of a candidate's image, bound to the fetch SHA-256.
3. Manifest approval (this phase): Frank approves ONE immutable
   manifest, identified by its id and the SHA-256 of its canonical
   bytes. Only that exact manifest, with that exact hash, can be
   imported, and only while nothing it froze has changed.

### Schema: migration 005

`server/db/migrations/005-discovery-manifests.sql` adds two tables:

- `discovery_import_manifests`: `id` in the
  `mf-<batch-slug>-<yyyymmdd>-<seq>` format is the primary key;
  `manifest` holds the canonical content as jsonb; `sha256` (unique)
  is the SHA-256 of the canonical bytes; `record_count`;
  `catalog_fingerprint` (jsonb) records the build-time catalog
  fingerprint; `status` is draft / approved / imported / void;
  `built_by` (+ uid), `approved_by`, `approved_at`,
  `approved_sha256`, `imported_at`, `created_at`.
- `discovery_manifest_events`: the manifest audit trail (build /
  approve / void / import, from/to status, note, actor). Manifest
  events live in their own table rather than `discovery_decisions`
  because that table's CHECK requires a candidate or pair target;
  the shape and conventions otherwise follow Phase 3.

The viewer role gets SELECT on both tables (guarded grant in the
migration). The reviewer role gets INSERT + SELECT on both tables
and UPDATE on exactly the four approval columns of
`discovery_import_manifests` (`status`, `approved_by`,
`approved_at`, `approved_sha256`), plus USAGE on the events id
sequence. Marking a manifest imported is deliberately NOT among the
reviewer's grants: only the operator executor (below) does that.

### Canonical form and ids

The manifest content is serialized as canonical JSON: keys sorted
at every depth, no insignificant whitespace, one trailing LF.
`sha256` is the SHA-256 of exactly those bytes; the export endpoint
returns exactly those bytes, so the hash is verifiable offline.
Manifest ids are `mf-<batch-slug>-<yyyymmdd>-<seq>` with the date in
UTC and a per-day sequence. A manifest covers ONE batch.

### Build (POST /discovery/batches/:id/manifests)

Building takes ALL of the batch's `selected` candidates, in
candidate_key order. A candidate is import-eligible when:

- its selection decision is final (it is `selected`, with a recorded
  selection decision);
- it has no unresolved duplicate pair and no live-catalog match;
- its brewery is known (a staged brewery name is required; the name
  resolves to exactly one live brewery, or to none, in which case
  the import creates it; more than one live namesake is ambiguous
  and blocks);
- its style resolves (a staged style name must match exactly one
  live style, whose category is recorded; a candidate with no style
  imports with no style);
- its attached image, if any, carries an approved Phase 4 decision.
  "Attached" means the candidate has a staged image URL. An
  undecided image blocks (`image_unverified`), and a REJECTED image
  also blocks (`image_rejected`): there is no detach operation, so a
  rejected image must be re-fetched and approved before the
  candidate can be imported.

If ANY selected candidate is not eligible, the build refuses with
422, lists every blocking candidate with every reason, and creates
nothing. A manifest never silently includes or excludes a
candidate. A batch with no selected candidates also refuses (422).
At build time the API computes the catalog fingerprint (below) and
records it in the manifest.

### Approval (POST /discovery/manifests/:id/approve)

Frank's gate. The body is `{ "sha256": "<64 hex>" }`. The caller
must be on the API-layer allowlist: the
`DISCOVERY_MANIFEST_APPROVER_USER_IDS` env var holds a
comma-separated list of `users.id` values (Postgres cannot see
Firebase identity, so the gate lives in the API). The env var unset
or unparseable means NOBODY can approve (fail closed). Responses:
403 for a caller not on the allowlist, 400 for a malformed hash,
422 when the supplied hash differs from the manifest's stored hash,
409 when the manifest is not in draft status, 503 when the
discovery write path is not configured. On success the endpoint
writes `status`, `approved_by`, `approved_at`, and
`approved_sha256` atomically with an `approve` audit event. The
manifest detail response carries `can_approve`, computed
server-side from the allowlist for the signed-in account; the
client uses it only to show or hide the approve control. The API
enforces the gate regardless.

Void (POST /discovery/manifests/:id/void, optional `note`) moves a
draft or approved manifest to `void`, with an audit event. A voided
manifest can never be imported (the executor checks status).
Imported and void manifests are final.

### Export and offline verification

GET /discovery/manifests/:id/export downloads the canonical bytes
exactly as hashed (Content-Type application/json, Content-Disposition
attachment, `X-Manifest-Sha256` header). Verify offline:

```
sha256sum mf-<batch-slug>-<yyyymmdd>-<seq>.json
```

The digest must equal the manifest's recorded sha256 (shown in full
on the admin detail page) before the hash is approved or imported.

### The catalog fingerprint

Per catalog table, a row count plus an MD5 over content-bearing
columns in id order: beers (id, name, brewery_id, last_mod),
breweries (id, name, last_mod), beverage_images (id, beverage_id,
status, updated_at). Count-preserving edits move the MD5 and are
detected. DEVIATION from issues/001's wording: the issue names
`updated_at` for beers and breweries, but the catalog tables'
timestamp column is `last_mod`; the fingerprint uses `last_mod` for
those two tables. beverage_images does have `updated_at`.

### Import (operator executor)

`server/scripts/import-discovery-manifest.ts` is an operator tool,
never an API path. It runs ONLY under the operator/migration
identity (`DATABASE_URL_ADMIN_LOADER`); it refuses to start without
it. Arguments: `--manifest <id>` and `--sha256 <64 hex>`, both
required; `--dry-run` optional.

```
DATABASE_URL_ADMIN_LOADER=<operator url> \
  npx ts-node --transpile-only scripts/import-discovery-manifest.ts \
    --manifest mf-<batch-slug>-<yyyymmdd>-<seq> --sha256 <approved hash>
```

PRODUCTION RULE: a production import requires Frank's approval of
the exact manifest id + sha256, recorded out of band (for example
in the approval conversation or a signed note), and the operator
passes that recorded hash as `--sha256`. The executor refuses on
any mismatch between the supplied hash, the stored hash, the
approved hash, and the recomputed content hash. Approval of a plan
or of the manifest feature is NOT approval of an import; each
import needs its own id + hash approval.

The import runs as ONE transaction at REPEATABLE READ:

1. It takes a transaction-scoped advisory lock on the fixed
   catalog-import key (777001239). A concurrent import waits, then
   revalidates against the new baseline. Immediately afterwards it
   takes SHARE ROW EXCLUSIVE table locks on beers, breweries, and
   beverage_images, held until the transaction ends: the advisory
   lock alone only serializes imports against each other, while the
   table locks also hold off normal catalog writes (every INSERT,
   UPDATE, or DELETE takes a conflicting ROW EXCLUSIVE lock), so no
   catalog change can slip in between the checks below and the
   import's writes. Plain reads are unaffected.
2. It locks the manifest's candidate rows SELECT ... FOR UPDATE.
3. It runs all five checks INSIDE the transaction, in order:
   (1) the manifest is `approved` and its `approved_sha256` equals
   the stored hash, the recomputed content hash, and the
   operator-supplied `--sha256`;
   (2) every candidate is still in the recorded decided state:
   still `selected`, the selection decision still the latest and
   unchanged, the staged payload hash unchanged, and the image
   decision state (approved decision id, fetch id, hash) unchanged;
   (3) no candidate has gained an unresolved pair or a live-catalog
   collision (barcode, or normalized name + brewery);
   (4) referenced breweries, styles, and categories still resolve
   as recorded (an "existing" row still exists, a style's category
   still matches; a "new" brewery name still has no live namesake);
   (5) the live catalog fingerprint still equals the build-time
   fingerprint recorded in the manifest.
4. It re-fetches every attached image through the Phase 4
   restricted fetcher and re-hashes the bytes inside the
   transaction. On a match the beverage_images row is written
   directly as `approved` with `verified_at` set (the Phase 4
   decision IS the approval) and the candidate's image decision id
   named in the row's attribution provenance (the catalog schema
   has no dedicated provenance column; the attribution reads
   `Discovery hub import: manifest <id>, candidate <key>, image
   decision <id>`, appended after any staged attribution). On a
   mismatch the import ABORTS; nothing degrades to pending.
5. Before writing, it aligns the breweries, beers, and
   beverage_images id sequences with their tables' current maxima.
   Alignment never moves a sequence backwards: the target is the
   greater of the table maximum and the sequence's own last value,
   so a sequence already ahead of its table (ids reserved by
   another tool, a restored dump) keeps its position. An alignment
   failure aborts the import (`IMPORT REFUSED
   [sequence_alignment]`); it is never ignored.
6. It writes, still in the one transaction: new breweries the
   manifest marks as new (manifest order, deduplicated within the
   manifest), beers with NEW ids assigned above the current max
   beer id in manifest order, the beverage_images rows, candidates
   marked `imported` with their new beer id, and the manifest
   marked `imported` with `imported_at` and an `import` audit event
   carrying the report.

Any check failure aborts the whole transaction with a specific
error (`IMPORT REFUSED [<check>]: ...`, exit 1) and imports
nothing. Under REPEATABLE READ, a SELECT ... FOR UPDATE that hits a
row a concurrent import already updated raises a serialization
failure (SQLSTATE 40001 / Prisma P2034); the executor maps that to
a `stale` refusal, which is the same operational meaning: the
ground moved, nothing was written, retry deliberately after
re-checking state. `--dry-run` runs the lock, all five checks, the
image re-fetch and hash verification, and the full payload
validation, then rolls back and prints the would-be report
(including the ids that WOULD be assigned). A successful run prints
a JSON report: manifest id, sha256, beers / breweries / images
inserted, and the per-candidate id assignments.

### Manifest rollback

- Before import: void the manifest. A voided manifest can never be
  imported; build and approve a replacement instead. Manifests are
  immutable, so there is no edit path.
- After import: an executed import is a catalog data change. Its
  reversal is a separate, separately approved data operation
  (delete or retire the imported beers / images / created
  breweries by the ids in the import report and the `import` audit
  event, and return the candidates to a decided state). It is
  documented here and deliberately NOT built: no tool in this phase
  reverses an import.
- Schema teardown (full hub rollback only): drop
  `discovery_manifest_events` then `discovery_import_manifests`,
  in that order (events reference manifests). Recorded manifest
  history is audit data and is not reset by an API or client
  rollback.

### Rehearsal

`server/scripts/test-discovery-manifests.sh` is the phase's proof
harness: a disposable socket-only PG16 with the base schema,
migrations 001-005, both roles, the Phase 2 seed bundle (25
records) ingested, the executor CLI refusal checks, the full
manifest integration suite (build, approve, export, real import,
and the six negative scenarios), and an offline `sha256sum`
verification of the exported manifest. The manifest role grants are
also covered by `server/scripts/test-discovery-roles.sh`
(verify-discovery-reviewer.sql / verify-discovery.sql).

## Rollback

All schema is additive and confined to the discovery tables; the
catalog cannot be affected.

1. Revert the API and client deploys (the routes and pages are
   additive; nothing else references them).
2. For the decision phase, follow the decision-phase rollback above.
3. For the image phase, follow the image-phase rollback above.
4. For the manifest phase, follow the manifest rollback above (void
   before import; an executed import is reversed only as a separate
   approved data operation).
5. Optionally drop the staging data:
   `DROP TABLE discovery_manifest_events, discovery_import_manifests, discovery_image_decisions, discovery_image_fetches, discovery_decisions, discovery_candidate_pairs, discovery_candidates, discovery_batches;`
   (order matters: manifest events reference manifests, image
   decisions reference fetches and candidates, decisions, pairs,
   and candidates reference the tables after them). Dropping the
   tables also drops the viewer's grants on them.

## Follow-ups owned by later phases

- The verify-readonly-role.sql whitelist addition noted above.
- Batch 2's per-record image verification state lives in the POC
  manifest, not in batch-702.json; reproducing issue 001's "170
  verified images" staging state needs that manifest merged into the
  staged records before bundling (see PR_NOTES_PHASE2.md).
