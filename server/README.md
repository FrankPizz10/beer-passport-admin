# BeerPassport Admin Server

Read only backend for frontend for the BeerPassport admin viewer. It serves
catalog, user, and admin metadata from PostgreSQL through Prisma, verifies
Firebase admin tokens on every request, and registers GET routes only.
There is no mutation surface in this server.

## Read only rules

- Only GET routes exist, mounted under /admin-api/v1 behind the admin auth
  middleware (the one public exception is GET /admin-api/v1/health).
- Server source under src/ uses only Prisma read methods: findMany,
  findUnique, findFirst, count, and groupBy. A test
  (src/readOnlyGuard.test.ts) scans the source and fails on any mutation
  call. The seed script under scripts/ is the single exception and is not
  part of the server runtime.
- Projections live in one file, src/projections.ts. Forbidden in every
  projection: the users notification token, the api_keys key column, and
  the beers search vector.
- Use a SELECT only Postgres role in DATABASE_URL where possible, as
  defense in depth.

## Environment variables

See .env.example. Summary:

- DATABASE_URL: PostgreSQL connection string. Local value:
  postgresql://postgres@127.0.0.1:54329/beerpassport_dev (the local psql
  helper connects as user postgres with no password).
- PORT: listen port, default 4100.
- ADMIN_ORIGIN: the single CORS origin allowed, default
  http://localhost:3000.
- FIREBASE_* service account variables: used to build the firebase-admin
  cert exactly as the pilot server does. Server only, never committed.
- FIREBASE_AUTH_EMULATOR_HOST: when set, firebase-admin initializes with
  only a project id (FIREBASE_PROJECT_ID, default beerpassport-local) and
  no credential.
- When Firebase is not configured the server still boots. Token
  verification raises a distinct not configured error, and
  GET /admin/accounts returns an empty list with firebase_configured false
  so the UI degrades gracefully.

## How to run

    npm install
    npm run prisma:generate
    npm run build
    npm start

For development: npm run dev. For tests: npm test. Database integration
tests are opt in: RUN_DB_TESTS=1 npm test with DATABASE_URL set.

## How auth works

Every /admin-api/v1 route except health sits behind decodeAdminToken, a
port of the pilot server middleware (src/Middleware/authUsers.ts in the
pilot repo, Phase 0 findings F-8 and F-10). It reads the Bearer token,
verifies it with firebase-admin, returns 401 for a missing or invalid
token, 403 when the admin custom claim is absent, 500 for non auth
verification failures, and 401 when no users row matches the token uid.
On success it sets res.locals.firebaseUid and res.locals.user.

## Routes (all GET, base /admin-api/v1)

- GET /health (public): { ok: true }
- GET /catalog/beers, GET /catalog/beers/:id
- GET /catalog/breweries, GET /catalog/breweries/:id
- GET /catalog/categories, GET /catalog/categories/:id
- GET /catalog/styles, GET /catalog/styles/:id
- GET /catalog/collections, GET /catalog/collections/:id
- GET /catalog/collection-beers
- GET /catalog/beverage-images
- GET /users, GET /users/:id
- GET /users/:id/beers, GET /users/:id/badges, GET /users/:id/friends,
  GET /users/:id/notifications
- GET /admin/overview, GET /admin/target, GET /admin/api-keys,
  GET /admin/accounts

Lists return { results, pagination: { page, page_size, total_results,
total_pages } }. Sorting uses ?sort=<field>&direction=<asc|desc> with a
per resource allowlist (see src/pagination.ts).

## Database runtime role (read only at the database layer)

The viewer must not run on migration or application-owner credentials.
`db/readonly-role.sql` creates the dedicated `beerpassport_admin_viewer`
role: LOGIN, NOINHERIT, NOREPLICATION, NOBYPASSRLS, SELECT-only on an
explicit table list, with
column-level exclusions for `users.notification_token` and `api_keys.key`,
no default privileges (future tables are never auto-granted), and a
connection limit of 20 (Prisma pools; the overview endpoint fans out).
The script runs as a single transaction: any failure rolls back every
change it made (attributes, password, membership revocations, grants).
Run it as a plain `psql -f` script; do not wrap it in an outer
transaction. Run it once as a PostgreSQL superuser: the one-time
bootstrap creates and alters the role, revokes its memberships, and
audits cluster-wide privileges, which requires a superuser. The viewer
role itself remains fully restricted at runtime.
Point `DATABASE_URL` at this role outside local development.
`db/verify-readonly-role.sql` is the self-checking verification: run it
connected as the role; every check prints PASS and any unexpected success
fails the script. Both were executed against the local development
database on 2026-11-21 (all checks PASS, and the live integration suite
passes 4/4 running as this role). Production execution requires CTO
approval; see `docs/DEPLOYMENT_RUNBOOK.md`.

## Schema drift check

prisma/schema.prisma is a verbatim read copy of the pilot server schema
plus a header comment. Run:

    bash scripts/check-schema-drift.sh

It compares both files from the generator client line onward and exits
non-zero on any drift.

## Seed

    npm run seed

scripts/seed-local.ts inserts synthetic local data (example.com users, a
Local Test Collection, placeholder API keys, placeholder beverage images)
so empty tables can be exercised. It hard refuses to run unless the
DATABASE_URL hostname is localhost or 127.0.0.1, and it is idempotent: it
deletes the rows it owns before inserting fresh ones. Never run it against
a remote database.
