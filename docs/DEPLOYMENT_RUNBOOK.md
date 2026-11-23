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
  decision. To remediate, a superuser runs `REASSIGN OWNED BY
  beerpassport_admin_viewer TO <new_owner>` in EVERY database where the
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

## Image storage

Approved product images whose only locator is a private `storage_key`
render as kind `product` with no image URL in list and detail payloads;
the raw key is never emitted. Release 1.0 implements the display path:
the backend endpoint `GET /admin-api/v1/images/:beverageId`, behind the
normal admin auth, returns a short-lived presigned GET URL for the
approved image's object, generated server-side (see "Viewer release
1.0" below). The signing identity and any bucket policy change are AWS
infrastructure changes and require separate CTO approval before
provisioning. Do not make any bucket public.

## Viewer release 1.0

Release contents (branch `release/viewer-1.0`, built on the
post-merge hardening branch):

- Everything in the merged viewer (PR #7) and the hardening branch
  (PR #8): the read-only catalog, user data, and admin account sections;
  the dedicated `beerpassport_admin_viewer` database role package; and
  the rule that a bare `storage_key` is never emitted as an image URL.
- New: the authenticated private-image path described below. Nothing in
  this release deploys itself; every production step remains in
  "Steps requiring CTO approval".

### Private images: presigned URL endpoint

- Endpoint: `GET /admin-api/v1/images/:beverageId`, behind the same
  `decodeAdminToken` middleware as every other route (401 without a
  token, 403 without the admin claim, 401 when the verified identity
  has no database user row).
- Behavior: finds the beverage's approved `beverage_images` rows in
  lowest-id-first order (the resolver's order) and signs the first one
  whose `storage_key` is a bare private object key. Responds 404 when
  no such row exists. The response is `{ url, expires_at }` with a
  presigned GET URL whose lifetime is at most 900 seconds. The raw
  `storage_key` never appears in the response.
- Signing: AWS SDK for JavaScript v3 (`@aws-sdk/client-s3`,
  `@aws-sdk/s3-request-presigner`), server-side only. Configuration is
  by environment variable name (see `server/.env.example`):
  `ADMIN_IMAGE_BUCKET`, `ADMIN_IMAGE_REGION` (`AWS_REGION` fallback),
  with credentials resolved through the SDK default chain. When the
  bucket or region is unset, the endpoint answers 500 and the rest of
  the viewer is unaffected.
- Client: the beverage detail view requests this endpoint when the
  detail payload reports kind `product` with no `image_url`, renders
  the returned URL, and keeps the initials fallback on any failure.
  Public http(s) image URLs behave exactly as before.
- Identity requirement (CTO-approval provisioning step, NOT done): the
  signing identity must hold `s3:GetObject` only, scoped to the image
  objects in `ADMIN_IMAGE_BUCKET`. No other S3 action, no bucket policy
  change, and the bucket stays private. Provisioning this identity is
  step 6 of "Steps requiring CTO approval" below.

### Pre-release checklist

- [ ] Server suite, client suite, `tsc`, and the client production
      build all pass on the release branch (recorded in the release
      commit message).
- [ ] Read-only role package applied in production by a superuser and
      verified 13 of 13 (CTO step 1), with `DATABASE_URL` pointed at
      `beerpassport_admin_viewer`.
- [ ] Firebase service account for token verification provisioned as
      deployment secrets (CTO step 2); one admin-claim sign-in verified
      end to end.
- [ ] API host, DNS, and TLS decided and provisioned (CTO step 3);
      `/admin-api/v1/health` answers on the production hostname.
- [ ] If private images are in scope for this release: the
      `s3:GetObject`-only signing identity provisioned (CTO step 6),
      `ADMIN_IMAGE_BUCKET` and `ADMIN_IMAGE_REGION` set in the API's
      environment, and one approved private image verified end to end
      in the beverage detail view.
- [ ] Rollback path confirmed (see "Rollback"): stop the API process,
      revert the client static deploy, drop the viewer role if created.

## Steps requiring CTO approval (none performed)

1. Create the `beerpassport_admin_viewer` role in the production
   database (run `server/db/readonly-role.sql` once as a PostgreSQL
   superuser, the one-time bootstrap, with the password set out of
   band, as a plain `psql -f` invocation; the script is a single
   transaction, so a failed run changes nothing and must not be
   wrapped in an outer transaction; the viewer role itself stays
   restricted at runtime), then run the
   verification script as the role and record the output.
2. Provision a Firebase service account (or equivalent) for the API's
   token verification in production, stored as deployment secrets.
3. Choose and provision the API's production host (Lightsail alongside
   the backend, per above), DNS name, and TLS.
4. Set production environment variables and secrets on that host.
5. Deploy the client build and the API; smoke test `/admin-api/v1/health`
   and one admin-claim sign-in end to end.
6. Separately, if private-storage images are wanted in the viewer:
   provision the read-only S3 signing identity for the presigned-URL
   endpoint implemented in release 1.0 (`s3:GetObject` only, scoped to
   the image objects; see "Viewer release 1.0"). The endpoint code is
   implemented; only the AWS identity is outstanding.

## Rollback

The viewer is additive and read-only. Rollback is: stop the API process,
revert the client static deploy to the previous build, and (if created)
`DROP ROLE beerpassport_admin_viewer` after revoking its grants. No data
migration is involved at any point.
