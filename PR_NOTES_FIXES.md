# PR notes: production-readiness fixes (whitelist + full-set ingest timeout)

Branch: `discovery/production-readiness-fixes`, from `ce4946f` (the
discovery stack tip containing merged PRs #16-#23, including the S3
image-storage import). Two independent fixes, both proven on
disposable PostgreSQL in this repo's harnesses. No production
database, AWS, or deployment touched.

### Fix A: read-only grant whitelist covers the discovery tables

Migrations 002-005 grant `beerpassport_admin_viewer` table-level
SELECT on 8 discovery tables (`discovery_batches`,
`discovery_candidates`, `discovery_candidate_pairs`,
`discovery_decisions`, `discovery_image_fetches`,
`discovery_image_decisions`, `discovery_import_manifests`,
`discovery_manifest_events`). Neither privilege whitelist knew them,
so after migration 005 `verify-readonly-role.sql` failed with
"viewer role holds 8 unexpected direct privilege(s)" and
`readonly-role.sql` refused to re-run at its audit. The 8 names were
added in three places:

1. `server/db/verify-readonly-role.sql`: the `c.relname IN (...)`
   whitelist in the pg_class unexpected-privilege check.
2. `server/db/readonly-role.sql`: the identical whitelist in its
   pre-change audit.
3. `server/db/readonly-role.sql`: the re-grant step. The script
   revokes ALL on all public tables and re-grants only its own
   list; without this, a re-run would pass the fixed audit and then
   silently strip the discovery grants and break hub reads.

Deviation in place 3, with evidence: the names could NOT simply be
appended to the flat `GRANT SELECT ON ...` list. That list runs in
the documented application order (readonly-role.sql after migration
001, BEFORE migrations 002-005), where the discovery tables do not
exist yet; the flat form fails the script's first run with
`ERROR: relation "discovery_batches" does not exist` (reproduced in
this worktree's first harness run). The re-grant is therefore a
`DO` block immediately after the main GRANT that grants SELECT on
each of the 8 tables that exists and skips the rest with a notice
(their migrations grant SELECT, role-existence-guarded, when they
land). On a re-run against a migrated database all 8 exist and are
re-granted, which is exactly the scenario the third fix exists
for. No column-level whitelist (users / api_keys) changed.

Proof, wired into `server/scripts/test-discovery-roles.sh` (new
steps after the existing verifies): verify-readonly-role.sql runs
AS the viewer after migrations 001-005 and passes;
readonly-role.sql is then RE-RUN in full; an owner-side count of
the viewer's table-level SELECT grants on the 8 discovery tables
returns exactly 8; verify-readonly-role.sql passes again.
Result: `ALL DISCOVERY ROLE CHECKS PASSED`, integration 7/7.

### Fix B: full domestic ingest transaction timeout

`server/scripts/ingest-discovery-bundle.ts` loads a bundle in ONE
Prisma interactive transaction; with the default 5,000 ms timeout
the full domestic bundle (6,817 records) aborts with P2028
("Transaction already closed ... The timeout for this transaction
was 5000 ms") and rolls back cleanly, ingesting nothing. The
transaction now passes explicit options
`{ timeout: 900000, maxWait: 120000 }` (the values proven on this
exact set in the prerequisites analysis), with a comment naming
the full-set scale. The single-transaction, all-or-nothing
behavior and the same-hash no-op are unchanged; nothing is batched
or split.

Proof: new harness `server/scripts/test-full-domestic-ingest.sh`
(disposable PG16, default PGPORT 54411). It provisions base schema
+ migrations 001-005 + both roles, builds the FULL bundle from
`candidates-us.json` with no `--limit` (candidates_sha256
d9de3940d08b05f1afeb219ef2f54e8dd7c6ddf1c6a95549b193648cf3a39ed0),
then (1) reproduces the failure with the pre-fix ingest extracted
from the branch base commit `ce4946f` (env `INGEST_SCRIPT` can
point elsewhere): exit 1, timeout error in output, 0 batches and
0 candidates afterwards; (2) runs the fixed ingest: batch row
present, 6,817 candidates, batch candidates_sha256 matches the
bundle manifest, hold distribution image_unverified 6,685 /
missing_brewery 82 / metadata_incomplete 48 / no hold 2; (3)
re-ingests the same bundle: report status `noop`, count unchanged.
Result: `ALL FULL DOMESTIC INGEST CHECKS PASSED`.

### Files

- `server/db/verify-readonly-role.sql` (whitelist)
- `server/db/readonly-role.sql` (audit whitelist + guarded
  discovery re-grant)
- `server/scripts/test-discovery-roles.sh` (proof steps for A)
- `server/scripts/ingest-discovery-bundle.ts` (transaction options
  + comment)
- `server/scripts/test-full-domestic-ingest.sh` (new; proof for B)
- `docs/DISCOVERY_HUB_RUNBOOK.md` (viewer verification now
  describes the whitelisted state and the guarded re-grant; bundle
  ingest section documents the transaction timeout and the new
  harness)
- `PR_NOTES_FIXES.md` (this file)

### Verification (all on this tree, 2026-11-23)

- `bash server/scripts/test-discovery-roles.sh`: exit 0,
  `ALL DISCOVERY ROLE CHECKS PASSED`; new steps show
  verify-readonly-role.sql passing after migrations 002-005,
  "viewer discovery SELECT grants after role re-run: 8", verify
  passing again, integration 7/7.
- `bash server/scripts/test-full-domestic-ingest.sh`: exit 0,
  `ALL FULL DOMESTIC INGEST CHECKS PASSED` (reproduction exit 1
  with the 5000 ms timeout error and 0/0 rollback; fixed ingest
  6,817 records, hash and hold distribution exact; second ingest
  `noop`).
- Bare `npx jest` from `server/`: exit 0, 230 passed, 26 skipped,
  0 failed.
- `npx tsc --noEmit`: clean.
- `bash server/scripts/test-discovery-manifests.sh`: exit 0,
  `ALL DISCOVERY MANIFEST CHECKS PASSED`, suite 12/12, offline
  sha256sum match (this harness applies readonly-role.sql in the
  documented pre-002 order, confirming the guarded re-grant keeps
  first-run provisioning working).

### Blockers / notes

- None for these two fixes. The companion server-repo schema
  mirror PR (beer-passport-server) and the promotion of this work
  into PR #22's branch are separate tasks. Production migration
  order stays: server mirror merged, migrations 001-005 applied by
  the operator, then this whitelist state is what makes role
  verification pass on the migrated database, then the full-set
  ingest can run with the fixed timeout.
