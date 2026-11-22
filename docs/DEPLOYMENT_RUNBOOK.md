# Admin DB Viewer: Deployment Runbook

Status: PREPARED, not deployed. Nothing in this document authorizes a
deployment. Production steps are gated on explicit CTO approval.
Last verified: 2026-11-21 against merged master (PR #7, merge commit
b4385de) plus the post-merge hardening branch.

## What the viewer is

Internal, read-only database viewer. React client (Create React App,
static build) plus a TypeScript/Express API (`server/`) that serves
GET-only routes under `/admin-api/v1`. Firebase Authentication sign-in on
the client; the API verifies the Firebase ID token server-side and
requires the `admin` custom claim (403 without it) plus a matching row in
the `users` table (401 without one). All list endpoints are paginated
(page_size 1 to 100, default 25) with per-resource sort allowlists.
Sensitive columns are never selected (`users.notification_token`,
`api_keys.key`, `beers.search_vector`); a source-level guard test fails
the suite if a Prisma mutation method is ever called.

## Completed and verified (2026-11-21, on merged master)

- Server tests 30 passed, 4 skipped by design (live-DB suite), 0 failed;
  client tests 7 of 7; both production builds clean.
- Merged tree is identical to the independently verified PR #7 tree
  except the known executable-bit difference on
  `server/scripts/check-schema-drift.sh` (cosmetic; invoked via bash).
- Schema drift check passes: the viewer's Prisma schema copy matches the
  BeerPassport server pilot schema.
- Database role package written and executed against the LOCAL
  development database only: `server/db/readonly-role.sql` (creates
  `beerpassport_admin_viewer`) and `server/db/verify-readonly-role.sql`
  (all checks PASS: approved reads succeed; the two sensitive columns
  are denied; INSERT, UPDATE, DELETE, TRUNCATE, and CREATE TABLE are all
  denied; role attributes are fully restricted; the role has no
  memberships, owns no objects, and cannot SET ROLE into a more
  privileged role). The live integration suite passes 4 of 4 with the
  API running as this role.
- Existing-role behavior (the script is safe to re-run): the ownership
  check runs FIRST, before any attribute or password change. If
  `beerpassport_admin_viewer` owns any database objects, the script
  fails closed with a clear error and leaves an existing role
  completely untouched: no attributes or password altered, no
  memberships revoked, no privileges changed. Ownership is never
  reassigned automatically, because that is a destructive operator
  decision. To remediate, an appropriately privileged operator
  (superuser or the objects' owner) runs `REASSIGN OWNED BY
  beerpassport_admin_viewer TO <owner>` in EVERY database where the
  role owns objects (REASSIGN OWNED works one database at a time), and
  then re-runs the role setup script. The script also audits DIRECT
  privileges before changing anything, and fails closed, listing every
  finding, if the role holds anything beyond the intended grants:
  database-level privileges anywhere in the cluster (only CONNECT on
  the target database is intended), schema privileges in any schema
  (only USAGE on public), table, view, sequence, or column privileges
  beyond the documented SELECT lists, any function or type grants, and
  any default privileges granted to the role. Remediation is manual:
  revoke each listed privilege (for example `REVOKE CREATE ON SCHEMA
  analytics FROM beerpassport_admin_viewer`, or `ALTER DEFAULT
  PRIVILEGES FOR ROLE <owner> REVOKE ALL ON TABLES FROM
  beerpassport_admin_viewer`), then re-run. Scope limits, stated
  plainly: object grants are per database, so the audit covers the
  database the script runs against (run it in every database the role
  can connect to); database-level privileges are the one cluster-wide
  check. Privileges granted to PUBLIC are platform defaults shared by
  every role, not direct grants to this one, and are outside the audit.
  On a clean role, the script forces the restricted attributes,
  revokes every role membership it finds (each revocation is printed
  as a NOTICE, never silent; a membership would otherwise let the
  viewer assume that role with SET ROLE despite NOINHERIT), and then
  applies exactly the documented grants. With the audit passing, a
  re-run converges the role's direct privileges in that database to
  exactly the documented set.
- Image handling fixed: only http(s) URLs are emitted as `image_url`. A
  bare `storage_key` (private storage object) is never emitted; the API
  reports kind `product` with provenance and a null URL instead of a
  broken link. Buckets stay private.

## Runtime configuration

Environment variables (see `server/.env.example` and `.env.example`):

- `DATABASE_URL`: PostgreSQL URL for the `beerpassport_admin_viewer`
  role. Never the migration or application-owner credentials.
- `PORT` (default 4100), `ADMIN_ORIGIN` (CORS origin of the client).
- Firebase Admin, one of: the `FIREBASE_*` service-account variables, or
  `GOOGLE_APPLICATION_CREDENTIALS`, or (local only)
  `FIREBASE_AUTH_EMULATOR_HOST`. If unset, the API still boots; token
  verification reports a distinct not-configured error and
  `/admin/accounts` degrades gracefully.
- Client build-time `REACT_APP_*`: Firebase web config (public values)
  and `REACT_APP_ADMIN_API_URL`.

Build and startup:

- Client: `npm ci && npm run build` (static output in `build/`).
- API: `cd server && npm ci && npm run build && npm start`
  (prisma generate runs as part of install/build per package scripts).
- Health check: `GET /admin-api/v1/health` (no auth; reports liveness
  only). Database target indicator: `GET /admin-api/v1/admin/target`
  (admin auth; host, port, database name only, never credentials).
- Logging: the API logs request errors to stdout/stderr via the shared
  error handler; no request bodies or tokens are logged. Run under a
  supervisor that captures stdout (systemd, Docker, or the host's
  equivalent) for the internal deployment.

## Hosting shape (fits the approved BeerPassport 2.0 architecture)

The current production admin deploy is a static S3/CloudFront site,
which cannot host the new API component. The smallest fit with approved
decisions (TD-9/TD-10, Lightsail) is: serve the static client from the
existing static hosting, and run the API as a small container or Node
process alongside the backend on the Lightsail instance once it exists,
behind the same TLS terminator, on an internal hostname or a restricted
path. No new paid services, no Kubernetes. The API must not be exposed
publicly without the Firebase admin-claim check in front of every route,
which is already enforced in code, plus network-level restriction to
trusted sources as defense in depth.

## Image storage: open item, design only

Approved product images whose only locator is a private `storage_key`
currently render as kind `product` with no image (see above). To display
them later, the approved design is a backend endpoint
`GET /admin-api/v1/images/:beverageId` that, after the normal admin auth,
returns a short-lived (minutes) presigned GET URL for the approved
image's object, generated server-side with an identity holding
`s3:GetObject` on the image prefix only. That identity and any bucket
policy change are AWS infrastructure changes and require separate CTO
approval before implementation. Do not make any bucket public.

## Steps requiring CTO approval (none performed)

1. Create the `beerpassport_admin_viewer` role in the production
   database (run `server/db/readonly-role.sql` as the owner with the
   password set out of band), then run the verification script as the
   role and record the output.
2. Provision a Firebase service account (or equivalent) for the API's
   token verification in production, stored as deployment secrets.
3. Choose and provision the API's production host (Lightsail alongside
   the backend, per above), DNS name, and TLS.
4. Set production environment variables and secrets on that host.
5. Deploy the client build and the API; smoke test `/admin-api/v1/health`
   and one admin-claim sign-in end to end.
6. Separately, if private-storage images are wanted in the viewer:
   approve the presigned-URL endpoint and its read-only S3 identity.

## Rollback

The viewer is additive and read-only. Rollback is: stop the API process,
revert the client static deploy to the previous build, and (if created)
`DROP ROLE beerpassport_admin_viewer` after revoking its grants. No data
migration is involved at any point.
