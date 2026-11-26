# Owner-managed admin access rollout

This release changes the authorization source for the admin API. Firebase
authenticates the person; the API verifies the ID token and Firebase revocation
state, requires a matching `users.uid`, and checks `admin_access_grants` on every
request. `ADMIN_OWNER_UID` names the single owner by immutable Firebase UID.
Only the owner can manage grants, view access events, or access the overview
and API-key metadata. Other admins can view profiles and use catalog review.
Catalog user activity aggregates are withheld from other admins. Firebase
custom claims are not used for the new API's authorization; other Firebase
claims are not changed.

## Release dependency and order

The admin API auto-deploys on master and the frontend can publish independently.
**Do not merge this admin PR until the database migration, role, owner UID,
and deployment coordination below are ready.** Without `ADMIN_OWNER_UID` or
the new tables/grants, admin access fails closed. The new frontend needs the
new `/admin/session` endpoint; publish the API first. A PR merge is not an
authorization to apply the migration or change server configuration.

1. Verify the legacy `addAdminRole` callable is disabled in production and
   that the legacy server's admin write block is deployed or that server is
   inaccessible. A revoked user's old Firebase admin claim can otherwise
   still authorize legacy paths. Record the observed deployment state.
2. Review and merge the canonical `beer-passport-server` schema PR, take a
   verified production snapshot, then separately approve and apply its Prisma
   migration exactly once. `server/db/migrations/006-admin-access.sql` is a
   disposable-database mirror, not an additional production migration.
3. As an approved operator step, apply `server/db/admin-access-role.sql` and
   set a unique role password out of band (for example, psql's interactive
   `\password beerpassport_admin_access_writer`). The script fails on unsafe
   ownership, memberships, and unexpected direct privileges. Confirm the viewer
   can SELECT the two admin access tables and the writer cannot modify users,
   catalog, or audit events. Rerunning `readonly-role.sql` preserves the new
   viewer grants.
4. Resolve Frank's Firebase UID from the trusted Firebase console, independently
   verify it matches the existing PostgreSQL profile, and provision
   `ADMIN_OWNER_UID` and `DATABASE_URL_ADMIN_ACCESS_WRITE` in the existing
   root-only API environment file. Point the latter only to the dedicated
   writer role. Do not put credentials or UIDs in Git, chat, or shell history.
   The owner is configured separately and cannot be revoked in the UI.
5. Hold Netlify publication while the API release is deployed. Deploy the
   reviewed API digest through the existing CI/SSM path; then publish the
   matching frontend. Check owner sign-in, `/admin/session`, owner-only account
   and overview routes, and a non-owner's 403 on those routes. Grant/revoke a
   disposable verified Firebase account with an existing app profile only
   after an explicitly approved test; confirm the audit event and immediate
   denial on the next API request. The API checks Firebase token revocation.

Grant requires an enabled Firebase account with a verified email and a matching
app profile. It grants access to the existing account rather than creating an
account or sending an invitation. Each change and its audit event commit in
one PostgreSQL transaction; a failed audit rolls back the change. Removing
`DATABASE_URL_ADMIN_ACCESS_WRITE` disables changes but keeps access checks on.
The `users.uid` foreign key prevents deleting a profile while its admin grant
exists; revoke it first. Already-running requests may finish after a revoke.

Rollback requires a coordinated API and frontend rollback, restoring the prior
claim-based authorization behavior; that older behavior does not enforce these
database revocations. Confirm the legacy callable and legacy server remain
protected before rollback. The database migration is additive and may remain
in place; do not drop audit data as part of rollback.

Local verification: `sh server/scripts/test-admin-access-postgres.sh` starts
an isolated PostgreSQL 16 container, tests privileges and actual Prisma
transactions, and removes the container. The script uses a temporary loopback
port and disposable credentials.
