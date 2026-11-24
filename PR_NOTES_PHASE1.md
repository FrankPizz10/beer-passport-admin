# Phase 1: image-queue deployment completion (local only, not pushed)

First phase of the catalog discovery hub program (decisions 005/006,
issues/001): finish the deployment package for the already-merged
image approval workflow (PR #11) so its production deployment is a
reviewed, rehearsed procedure instead of a manual one. No production
changes, no migrations run anywhere but a disposable instance, no
pushes.

## Deliverable A: automated role test (server/scripts/test-approval-role.sh)

New executable script that verifies both database roles end to end on
a throwaway PostgreSQL instance (socket-only, port 55439, scratch dir
deleted on exit):

- Generates the base schema DDL with `prisma migrate diff --from-empty
  --to-schema-datamodel server/prisma/schema.prisma --script`. This
  works in the sandbox with the documented engine workaround
  (PRISMA_MIGRATION_ENGINE_BINARY and PRISMA_QUERY_ENGINE_LIBRARY
  pointed at the locally cached engines; the script sets them only
  when those files exist).
- The Prisma schema already reflects migration 001, so the script
  rolls the generated DDL back to the pre-001 shape (drops
  image_review_events and the six beverage_images columns) and then
  applies server/db/migrations/001-image-approval.sql for real.
- Seeds one user, one beer, one pending beverage_images row; applies
  readonly-role.sql and approval-role.sql as superuser with test-only
  passwords; runs verify-readonly-role.sql AS the viewer and
  verify-approval-role.sql AS the approver; then runs seven explicit
  psql probes as the approver (decision-column UPDATE and audit INSERT
  must succeed; non-granted column UPDATE, INSERT/UPDATE/DELETE on
  beers, and SELECT of users.notification_token must fail).
- Prints PASS/FAIL per check and exits nonzero on any failure.
  Instance authentication is local-socket trust: the script tests
  authorization (grants), not passwords, and the instance listens on
  no network interface.

Environment deviations, recorded honestly: PostgreSQL refuses to run
as root, and in this VM uid 1000 has no /etc/passwd entry (initdb
looks the effective uid up and fails), so the script prefers uid 1000
where it resolves and otherwise falls back to 65534 (nobody) via
setpriv (override: BP_PG_RUN_UID/BP_PG_RUN_GID). The server also runs
from a scratch copy of the pgserver-packaged install with
LD_LIBRARY_PATH set, because the server uid cannot traverse
/home/hatch and the binaries' RPATH points at a pgserver.libs
directory that does not exist here.

## Deliverable B: loader dry-run + tests

- server/scripts/load-image-candidates.ts gains `--dry-run` (accepted
  before or after the file argument; usage comment updated). The
  loader was refactored around an exported runLoader with a dependency
  seam (findExisting / insertCandidate / checkImageUrl); every write
  goes through a single guarded write helper that returns without
  touching the database in dry-run mode, so a dry run performs the
  full fetch verification and dedupe classification, prints the same
  counts report, and provably inserts nothing. Runtime behavior of a
  real run is unchanged (same classification, same summary shape).
- New server/scripts/load-image-candidates.test.ts (8 tests, DB and
  fetch mocked): a real run inserts the classified rows with the
  expected counts; a dry run inserts nothing and reports identical
  counts; duplicate detection by beverage_id + storage_key;
  not_image classification (inserted pending with the recorded check
  fields); unreachable and invalid counting; checkImageUrl against a
  mocked global fetch (image / not_image / unreachable).
- server/jest.config.js: roots and testMatch extended to include
  scripts/**/*.test.ts so the loader tests run with the suite.

## Deliverable C: runbook completion (docs/DEPLOYMENT_RUNBOOK.md)

Image-workflow section only:

- New "Operator-reviewed candidate load" procedure: prepare
  candidates.json, run the loader with --dry-run, operator reviews
  the printed counts (inserted, skipped_duplicate, invalid,
  not_image, unreachable), an explicit approval is recorded, the real
  run uses the identical input file, and a queue spot-check confirms
  the pending count matches the inserted count.
- Deployment sequence tied to the current release path: the API is
  deployed by digest through the CI/CD pipeline (docs/ci-cd/RUNBOOK.md);
  DATABASE_URL_WRITE is set in /etc/beerpassport/secrets/admin-api.env;
  the client is published only after the unauthenticated probe
  GET /admin-api/v1/images/queue returns 401 (404 means the
  pre-workflow API is still live); the role step references
  server/scripts/test-approval-role.sh as its repeatable
  pre-deployment verification.

## Tests run (exact commands and results)

- `bash -n server/scripts/test-approval-role.sh` : clean.
- `bash server/scripts/test-approval-role.sh` : ALL ROLE TESTS
  PASSED. Instance up; base DDL generated; pre-001 rollback applied;
  migration 001 applies; seed ok; both role scripts apply;
  verify-readonly-role.sql as viewer: exit 0, 13 PASS notices;
  verify-approval-role.sql as approver: exit 0, 16 PASS notices;
  all 7 approver probes behaved as required.
- `npx jest scripts/load-image-candidates.test.ts` (in server/):
  8 passed, 0 failed.
- CLI checks: `load-image-candidates.ts --dry-run` with no file
  prints the usage line and exits 2 (the flag is not mistaken for the
  file); `<file> --dry-run` reaches the DATABASE_URL_ADMIN_LOADER
  guard, confirming the flag is accepted after the file argument too.
- `npm test` (server/): 10 suites passed, 1 skipped; 74 tests passed,
  4 skipped (the pre-existing live suite). The loader suite accounts
  for the +1 suite / +8 tests over the previous baseline.
- `npm run build` (server/, tsc): clean.

## Blockers and notes

- None for this phase. The role test's uid fallback and the scratch
  install copy are environment adaptations, documented above and in
  the script header; on a normal host the script uses PATH binaries
  and runs the server as the invoking user.
- Still operator/Codex work, unchanged by this phase: the production
  deployment itself (migration, role scripts, DATABASE_URL_WRITE, the
  digest deploy, and the 401 probe from Frank's network).
