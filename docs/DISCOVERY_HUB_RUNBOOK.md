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

## Rollback

All schema is additive and confined to the discovery tables; the
catalog cannot be affected.

1. Revert the API and client deploys (the routes and pages are
   additive; nothing else references them).
2. For the decision phase, follow the decision-phase rollback above.
3. For the image phase, follow the image-phase rollback above.
4. Optionally drop the staging data:
   `DROP TABLE discovery_image_decisions, discovery_image_fetches, discovery_decisions, discovery_candidate_pairs, discovery_candidates, discovery_batches;`
   (order matters: image decisions reference fetches and
   candidates, decisions, pairs, and candidates reference the
   tables after them). Dropping the tables also drops the viewer's
   grants on them.

## Follow-ups owned by later phases

- Immutable import manifests and revalidation gates (issues/001
  section 6). Image fetch/preview with hash-bound decisions landed
  in Phase 4 (see the image review section above).
- The verify-readonly-role.sql whitelist addition noted above.
- Batch 2's per-record image verification state lives in the POC
  manifest, not in batch-702.json; reproducing issue 001's "170
  verified images" staging state needs that manifest merged into the
  staged records before bundling (see PR_NOTES_PHASE2.md).
