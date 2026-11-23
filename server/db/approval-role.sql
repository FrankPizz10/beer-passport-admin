-- Dedicated approval-write role for the BeerPassport Admin image
-- approval workflow. This is the ONLY write identity the admin API ever
-- uses, and it can write exactly two things: the decision columns of
-- beverage_images, and the image_review_events audit table (see
-- docs/DEPLOYMENT_RUNBOOK.md, "Image approval workflow"). The viewer
-- role (beerpassport_admin_viewer) stays SELECT-only and is untouched
-- by this script.
--
-- Run this ONCE, as a PostgreSQL superuser (for example the postgres
-- role), against the target database, with the role password supplied
-- out of band, never in the file. Migration
-- server/db/migrations/001-image-approval.sql must be applied FIRST:
-- the grants below name its table and columns, and if they are missing
-- the script fails and rolls back (fail closed by construction).
--
--   psql -d <database> -v approver_password='<set-at-deploy-time>' \
--        -f server/db/approval-role.sql
--
-- Properties enforced here, mirroring server/db/readonly-role.sql:
--   LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT,
--   NOREPLICATION, NOBYPASSRLS, CONNECTION LIMIT 5. The role owns
--   nothing and is a member of no other role. It receives NO default
--   privileges: tables created later are invisible to it until a human
--   adds an explicit GRANT in a reviewed change.
--   Ownership: the script FAILS CLOSED if the role owns any database
--   objects, before any attribute or password change, leaving an
--   existing role completely untouched. Ownership is never reassigned
--   automatically; a superuser runs REASSIGN OWNED BY
--   beerpassport_admin_approver TO <new_owner> in EVERY database where
--   the role owns objects, then re-runs this script.
--   Privilege audit: the script also FAILS CLOSED if the role holds any
--   DIRECT privilege beyond the intended grants below, in this database
--   (any schema; tables, columns, sequences, functions, types, and
--   default privileges) or at database level anywhere in the cluster.
--   Remediation is manual: revoke each listed privilege, then re-run.
--   Privileges granted to PUBLIC are platform defaults shared by every
--   role, not direct grants to this one, and are outside the audit.
--
-- Why the grants are shaped this way: the approval endpoints pre-check
-- each row through the read-only viewer connection, then run ONE
-- transaction as this role that (a) updates the row only where its
-- status is still 'pending' (the status predicate is the concurrency
-- guard, and it needs SELECT on id and status only) and (b) inserts
-- the audit event. Prisma's updateMany returns only a count, so the
-- transaction never needs to read back columns this role cannot see:
-- it deliberately has NO SELECT on storage_key, source_url, or any
-- other beverage_images column beyond (id, beverage_id, status).
--
-- Atomicity: everything after the \gset runs in ONE transaction. Any
-- failure rolls back every change the run made. Run it as a plain psql
-- script exactly as documented above; do not wrap it in an outer
-- transaction or --single-transaction (the script manages its own).

\set ON_ERROR_STOP on
SELECT current_database() AS dbname \gset

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beerpassport_admin_approver') THEN
    CREATE ROLE beerpassport_admin_approver LOGIN;
  END IF;
END
$$;

-- Fail closed on ownership, BEFORE any attribute or password change.
DO $$
DECLARE
  owned_count int;
BEGIN
  SELECT count(*) INTO owned_count
  FROM pg_shdepend
  WHERE refclassid = 'pg_authid'::regclass
    AND refobjid = (SELECT oid FROM pg_roles WHERE rolname = 'beerpassport_admin_approver')
    AND deptype = 'o';
  IF owned_count > 0 THEN
    RAISE EXCEPTION 'beerpassport_admin_approver owns % database object(s). Reassign them first (REASSIGN OWNED BY beerpassport_admin_approver TO <owner>, in every database where it owns objects) and re-run this script. Refusing to continue; no attributes, password, memberships, or privileges were changed.', owned_count;
  END IF;
END
$$;

-- Fail closed on unexpected DIRECT privileges, also before any change.
-- The whitelist is exactly the intended grants: CONNECT on this
-- database, USAGE on public, table-level INSERT and SELECT on
-- image_review_events, USAGE on its id sequence, and the two
-- column-level grant sets on beverage_images. Anything else is listed
-- and the run refuses to continue.
DO $$
DECLARE
  approver_oid oid := (SELECT oid FROM pg_roles WHERE rolname = 'beerpassport_admin_approver');
  findings text[] := '{}';
  r record;
BEGIN
  FOR r IN
    SELECT d.datname AS obj, a.privilege_type AS priv
    FROM pg_database d, aclexplode(d.datacl) a
    WHERE a.grantee = approver_oid
      AND NOT (d.datname = current_database() AND a.privilege_type = 'CONNECT')
  LOOP
    findings := findings || format('database %s: %s', r.obj, r.priv);
  END LOOP;

  FOR r IN
    SELECT n.nspname AS obj, a.privilege_type AS priv
    FROM pg_namespace n, aclexplode(n.nspacl) a
    WHERE a.grantee = approver_oid
      AND NOT (n.nspname = 'public' AND a.privilege_type = 'USAGE')
  LOOP
    findings := findings || format('schema %s: %s', r.obj, r.priv);
  END LOOP;

  FOR r IN
    SELECT n.nspname || '.' || c.relname AS obj, a.privilege_type AS priv
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
    WHERE a.grantee = approver_oid
      AND c.relkind IN ('r', 'v', 'm', 'p', 'f', 'S')
      AND NOT (n.nspname = 'public'
        AND ((c.relname = 'image_review_events' AND c.relkind = 'r'
              AND a.privilege_type IN ('INSERT', 'SELECT'))
          OR (c.relname = 'image_review_events_id_seq' AND c.relkind = 'S'
              AND a.privilege_type = 'USAGE')))
  LOOP
    findings := findings || format('table %s: %s', r.obj, r.priv);
  END LOOP;

  FOR r IN
    SELECT n.nspname || '.' || c.relname || '.' || att.attname AS obj,
           a.privilege_type AS priv
    FROM pg_attribute att
    JOIN pg_class c ON c.oid = att.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(att.attacl) a
    WHERE a.grantee = approver_oid
      AND att.attnum > 0 AND NOT att.attisdropped
      AND NOT (n.nspname = 'public' AND c.relname = 'beverage_images'
        AND ((a.privilege_type = 'SELECT'
              AND att.attname IN ('id', 'beverage_id', 'status'))
          OR (a.privilege_type = 'UPDATE'
              AND att.attname IN ('status', 'verified_at', 'reviewed_by',
                'reviewed_by_uid', 'reviewed_at', 'updated_at'))))
  LOOP
    findings := findings || format('column %s: %s', r.obj, r.priv);
  END LOOP;

  FOR r IN
    SELECT n.nspname || '.' || p.proname AS obj, a.privilege_type AS priv
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(p.proacl) a
    WHERE a.grantee = approver_oid
  LOOP
    findings := findings || format('function %s: %s', r.obj, r.priv);
  END LOOP;

  FOR r IN
    SELECT n.nspname || '.' || t.typname AS obj, a.privilege_type AS priv
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace, aclexplode(t.typacl) a
    WHERE a.grantee = approver_oid
  LOOP
    findings := findings || format('type %s: %s', r.obj, r.priv);
  END LOOP;

  FOR r IN
    SELECT a.privilege_type AS priv
    FROM pg_default_acl d, aclexplode(d.defaclacl) a
    WHERE a.grantee = approver_oid
  LOOP
    findings := findings || format('default privileges: %s granted to approver', r.priv);
  END LOOP;

  IF coalesce(array_length(findings, 1), 0) > 0 THEN
    RAISE EXCEPTION 'beerpassport_admin_approver holds % unexpected direct privilege(s): %. Revoke each manually (database-level findings in the named database; object findings in this database) and re-run. Refusing to continue; nothing was changed.',
      array_length(findings, 1), array_to_string(findings[1:20], '; ');
  END IF;
END
$$;

-- CONNECTION LIMIT 5: the write path is one Prisma client used only by
-- the two approval endpoints, at human click rate. 5 is a hard bound,
-- far below any operational risk.
ALTER ROLE beerpassport_admin_approver
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 5
  PASSWORD :'approver_password';

-- Remediate memberships: the approver role must be a member of no other
-- role, otherwise SET ROLE could assume that role's privileges despite
-- NOINHERIT. Every membership found is revoked and reported by NOTICE.
DO $$
DECLARE
  membership record;
BEGIN
  FOR membership IN
    SELECT granted.rolname AS granted_role
    FROM pg_auth_members m
    JOIN pg_roles granted ON granted.oid = m.roleid
    JOIN pg_roles member ON member.oid = m.member
    WHERE member.rolname = 'beerpassport_admin_approver'
  LOOP
    EXECUTE format('REVOKE %I FROM beerpassport_admin_approver', membership.granted_role);
    RAISE NOTICE 'Revoked unexpected role membership: beerpassport_admin_approver was a member of %', membership.granted_role;
  END LOOP;
END
$$;

-- Clean slate, then exactly the intended grants. Together with the
-- privilege audit above, re-running this file converges the role's
-- direct privileges in THIS database to exactly the grants below.
REVOKE ALL ON DATABASE :"dbname" FROM beerpassport_admin_approver;
REVOKE ALL ON SCHEMA public FROM beerpassport_admin_approver;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM beerpassport_admin_approver;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM beerpassport_admin_approver;

GRANT CONNECT ON DATABASE :"dbname" TO beerpassport_admin_approver;
GRANT USAGE ON SCHEMA public TO beerpassport_admin_approver;

-- beverage_images: read only the identity and state columns; write only
-- the decision columns. No INSERT, no DELETE, no other column.
GRANT SELECT (id, beverage_id, status) ON beverage_images
  TO beerpassport_admin_approver;
GRANT UPDATE (status, verified_at, reviewed_by, reviewed_by_uid, reviewed_at, updated_at)
  ON beverage_images TO beerpassport_admin_approver;

-- The audit trail: append (INSERT) and read back (SELECT), nothing else.
GRANT INSERT, SELECT ON image_review_events TO beerpassport_admin_approver;
GRANT USAGE ON SEQUENCE image_review_events_id_seq TO beerpassport_admin_approver;

-- Belt and braces: no default privileges may auto-grant this role
-- anything on future tables.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  REVOKE ALL ON TABLES FROM beerpassport_admin_approver;

COMMIT;
