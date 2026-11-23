# Proposed PR

**Title:** Image approval workflow: review queue, scoped approver role, candidate loader

**Branch:** `image/approval-workflow` (local only, not pushed)

## PR description (proposed)

### Summary

Adds the image approval workflow so catalog image candidates can be
reviewed by a human before they render. Nothing in this PR is deployed;
the migration and role scripts are review-only until separately
approved (see the new "Image approval workflow" section in
docs/DEPLOYMENT_RUNBOOK.md).

- **Migration** `server/db/migrations/001-image-approval.sql`
  (additive): six review/check columns on `beverage_images`
  (`reviewed_by`, `reviewed_by_uid`, `reviewed_at`,
  `source_content_type`, `source_checked_at`, `source_check_status`)
  and a new append-only `image_review_events` audit table.
- **Queue reads** (existing read client + viewer role): GET
  `/admin-api/v1/images/queue` (pending candidates with beverage and
  brewery names, provenance, license/attribution, check status;
  `image_url` only when the direct locator is a public http(s) URL,
  `has_private_image` for private objects; the raw storage key is
  never serialized, and `source_url`, a provenance PAGE, is never used
  as an image URL), GET `/admin-api/v1/images/decisions` (audit list,
  newest first, decider shown as users id + user_name, never a
  Firebase UID), GET `/admin-api/v1/images/:id/preview-url` (presigned
  preview of a PENDING private image, 900s cap; 404 for non-pending
  rows and for rows without a private key).
- **Decisions** (the API's only writes): POST
  `/admin-api/v1/images/:id/approve` and `/reject` behind the same
  admin auth, optional JSON `{note}`. 404 unknown id, 409
  already-decided, 422 when approving a candidate whose source check
  is 'not_image' or 'unreachable'. One transaction on the write client
  updates the row (status; `verified_at` set on approve, NULL on
  reject; reviewer id + uid; `reviewed_at`) and inserts the audit
  event; the status predicate in the update is the concurrency guard,
  so a racing second decision gets 409 and writes no event. 503 when
  the write path is not configured.
- **Candidate loader** `server/scripts/load-image-candidates.ts`
  (operator-run, never run against production here): inserts pending
  candidates for beverages that already exist, verifying hosted URLs
  (HEAD with ranged-GET fallback, redirects followed) and recording
  the check result; skips duplicates (same beverage + locator in any
  status); reports inserted / skipped_duplicate / invalid / not_image
  / unreachable counts. Batch-linked candidates arrive with their
  batch import, not through this loader.
- **Client**: new Image Queue page + sidebar entry. The preview is the
  quality gate: Approve stays disabled until the candidate's image has
  fired a successful load in the reviewer's browser; a failed load
  shows a clear failure state and Approve stays disabled (Reject stays
  available). Decisions remove the row and refresh the Recent
  decisions list. Adds `apiPost` to the API client (same auth and
  error handling as `apiGet`).

### Permission model

- `beerpassport_admin_viewer` stays SELECT-only and unchanged in
  scope; its bootstrap script gains SELECT on `image_review_events`
  for the decisions list (existing deployments: apply just that one
  GRANT after the migration).
- New `beerpassport_admin_approver` role
  (`server/db/approval-role.sql`, same fail-closed discipline and
  restricted attributes as the viewer pair, CONNECTION LIMIT 5):
  SELECT (id, beverage_id, status) and UPDATE (status, verified_at,
  reviewed_by, reviewed_by_uid, reviewed_at, updated_at) on
  `beverage_images`; INSERT + SELECT on `image_review_events`; USAGE
  on the events id sequence. Nothing else: no INSERT/DELETE on
  `beverage_images`, no access to any other table.
  `server/db/verify-approval-role.sql` proves the allowed operations
  and the denials as the role.
- The API uses the approver only through `DATABASE_URL_WRITE`
  (`src/writeDb.ts`); unset disables the decision endpoints (503) and
  leaves the viewer untouched. The loader uses a separate operator
  identity (`DATABASE_URL_ADMIN_LOADER`), never an API role.
- The read-only guard test is restructured, not removed: Prisma
  mutation calls are now forbidden everywhere under `server/src/`
  EXCEPT `src/writeDb.ts` and `src/routes/imageApprovals.ts`, and the
  test asserts exactly that scoping.

### Deployment sequence (each step separately CTO-approved)

1. Apply migration 001. 2. Viewer grant update (or full bootstrap on
fresh setups), then `approval-role.sql` as superuser with the password
set out of band; run `verify-approval-role.sql` as the approver.
3. Set `DATABASE_URL_WRITE`, deploy the API. 4. Deploy the client.
5. Load candidates with the loader against an approved target only.

### Rollback

Revert the API and client deploys; unset `DATABASE_URL_WRITE` to
disable approvals instantly; `DROP ROLE beerpassport_admin_approver`
after revoking grants; migration down steps: drop
`image_review_events` and the six added columns. `beverage_images`
itself is untouched and empty in production today.

### Schema drift note

The canonical schema change must be mirrored in beer-passport-server.
Until that mirror lands, `scripts/check-schema-drift.sh` will report
drift between this repo's schema copy and the pilot schema; that is
expected and is the signal to do the mirror, not an error in this PR.

### Test report

Local only (unit suites are the recurring kind and already run in the
repo's normal jest invocations; the live checks below are one-off
verifications against a disposable copy of the local database).

- Server unit: `npx jest` in server/: 9 of 10 suites passed, 1 skipped
  (the live DB suite); 66 tests passed, 4 skipped, 0 failed. Includes
  new suites for the approval endpoints (401/403/404/409/422/503,
  happy paths asserting the row update and the audit event in one
  transaction, storage_key absent from every response), for the
  queue/decisions/preview endpoints, and the restructured read-only
  guard.
- Server typecheck: `npm run build` (tsc): clean.
- Server live integration: `RUN_DB_TESTS=1 DATABASE_URL=<viewer URL>
  npx jest test/integration.test.ts` against a disposable PostgreSQL
  16 copy with migration 001 and both role scripts applied: 4 passed,
  0 failed.
- Role verification on that copy: `verify-readonly-role.sql` as the
  viewer: 13/13 PASS. `verify-approval-role.sql` as the approver: all
  checks PASS (allowed SELECT/UPDATE/INSERT succeed; UPDATE of any
  other column, SELECT of storage_key, INSERT/DELETE on
  beverage_images, access to users/beers, DELETE on events, and CREATE
  TABLE all denied).
- End-to-end smoke (same disposable copy, real app + real Prisma
  clients, viewer reads + approver writes, stubbed Firebase auth):
  18/18 checks PASS (queue serialization, 422 on not_image, reject and
  approve happy paths with DB state and audit rows verified, 409 on
  re-decision, decisions ordering and uid non-exposure).
- Loader smoke (same copy, local HTTP stand-in): 6 candidates ->
  inserted 4, skipped_duplicate 1, invalid 1, not_image 1,
  unreachable 1; inserted rows verified (image/image/jpeg,
  not_image/text/html, private unchecked, unreachable), all pending.
- Client: `CI=true npx react-scripts test --watchAll=false`: 5 suites
  passed, 13 tests passed, 0 failed (4 new queue-page tests: approve
  disabled before load, enabled after load, disabled on load error
  with the failure state shown and Reject working, private preview via
  preview-url, decisions list). `npm run build`: compiled (warnings
  only, pre-existing CRA lint warnings).
- `package.json` and both `package-lock.json` files are unchanged; no
  new dependencies.

## Design decisions made beyond the brief

1. **Branch base is master 2d06689, not c224081.** By the time the
   clone was made, master had advanced: PR #10 (firebase-admin 13) had
   merged. The branch was created off the current master tip; the
   brief's c224081 pin predated that merge.
2. **Pre-checks run on the read client; the write transaction is
   update + event insert only.** The approver role deliberately has no
   SELECT on the written columns (only id, beverage_id, status), so
   the decision flow loads the row through the viewer client for the
   404/409/422 checks, then performs ONE write transaction:
   `updateMany` with the `status='pending'` predicate (count must be
   1, else the transaction throws and rolls back with 409) plus the
   audit insert. This keeps the brief's atomicity guarantee while
   respecting the column-level grant; the response is the read-side
   projection merged with the decision just written.
3. **UIDs stay server-side in API responses.** Decision and queue
   serializers expose the decider as users id + user_name and never
   emit `admin_uid` / `reviewed_by_uid`, matching the existing
   convention that the users list projection excludes Firebase UIDs.
   The UIDs are still recorded in the database audit columns.
4. **Preview-url is restricted to pending rows** (404 otherwise): the
   approved-image presigned endpoint already covers approved private
   images, and rejected rows should not be signable.
5. **Error codes extended.** `src/errors.ts` gains 'conflict' (409),
   'unprocessable_entity' (422), and 'service_unavailable' (503)
   helpers; the existing union had no codes for the new statuses.
6. **`verify-readonly-role.sql` whitelist updated** alongside
   `readonly-role.sql`: without adding `image_review_events` to its
   privilege-audit whitelist, the viewer verification would fail after
   the new grant lands.
7. **One comment corrected in `scripts/seed-local.ts`**: it claimed to
   be the only file allowed Prisma mutations; the guard's scope note
   now lives in the guard test itself.
