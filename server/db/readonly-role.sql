-- Dedicated read-only runtime role for the BeerPassport Admin DB Viewer.
--
-- Run this ONCE, as a PostgreSQL superuser (for example the postgres
-- role), against the target database, with the role password supplied
-- out of band, never in the file. A superuser is required for this
-- one-time bootstrap: the script creates and alters a role, revokes
-- that role's memberships, audits cluster-wide database privileges and
-- default privileges, and sets grants across schemas. The superuser
-- requirement applies only to the operator running the bootstrap; the
-- viewer role it creates remains fully restricted at runtime:
--
--   psql -d <database> -v viewer_password='<set-at-deploy-time>' \
--        -f server/db/readonly-role.sql
--
-- Properties enforced here:
--   SELECT-only, on an explicit table list, with column-level exclusions
--   for the two sensitive columns (users.notification_token, api_keys.key).
--   The role owns nothing, inherits nothing (NOINHERIT), cannot create
--   roles or databases, is not a superuser, and receives NO default
--   privileges: tables created later are invisible to it until a human
--   adds an explicit GRANT in a reviewed change.
--   Memberships and ownership: NOINHERIT alone does not stop a member
--   role from being assumed with SET ROLE, so this script also revokes
--   every role membership the viewer role holds (each revocation is
--   reported with a NOTICE, never silent), and it FAILS CLOSED if the
--   role owns any database objects: ownership is never reassigned
--   automatically, because that is a destructive operator decision. The
--   ownership check runs before any attribute or password change, so a
--   failure leaves an existing role completely untouched. If the script
--   fails on ownership, reassign the objects first (REASSIGN OWNED BY
--   beerpassport_admin_viewer TO <new_owner>, executed in every
--   database where the role owns objects, by a superuser) and re-run
--   this script.
--   Privilege audit: the script also FAILS CLOSED if the role holds any
--   DIRECT privilege beyond the intended grants below, in this database
--   (any schema; tables, columns, sequences, functions, types, and
--   default privileges) or at database level anywhere in the cluster.
--   Grants are per database, so the audit covers the database the
--   script runs against, plus cluster-wide database privileges; run
--   the script in every database the role can connect to. Privileges
--   granted to PUBLIC are platform defaults, not direct grants to this
--   role, and are outside this audit.
-- Never run this with migration or application-owner credentials as the
-- viewer's runtime identity; this script is executed BY a superuser ONCE
-- to create the separate, weaker runtime role.
--
-- Image approval workflow addition: the viewer also gets SELECT on
-- image_review_events (the append-only decision audit trail written by
-- beerpassport_admin_approver), so the admin decisions list can read it
-- through the normal read-only connection. The table is created by
-- server/db/migrations/001-image-approval.sql, which must be applied
-- before this script's grant can succeed. EXISTING deployments that
-- already bootstrapped the viewer do not need a full re-run for this
-- addition; a superuser applies just the one grant:
--
--   GRANT SELECT ON image_review_events TO beerpassport_admin_viewer;
--
-- Atomicity: everything after the \gset runs in ONE transaction. Any
-- failure (a fail-closed check, a missing table in a GRANT, anything)
-- rolls back every change the run made: role creation, attributes,
-- password, membership revocations, and grants. Run it as a plain psql
-- script exactly as documented above; do not wrap it in an outer
-- transaction or --single-transaction (the script manages its own).

\set ON_ERROR_STOP on
SELECT current_database() AS dbname \gset

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beerpassport_admin_viewer') THEN
    CREATE ROLE beerpassport_admin_viewer LOGIN;
  END IF;
END
$$;

-- Fail closed on ownership, BEFORE any attribute or password change: the
-- viewer role must own no database objects (in this database or any
-- shared object such as a database itself). pg_shdepend records an owner
-- dependency (deptype 'o') for every object a role owns; DROP OWNED uses
-- the same catalog. Reassigning ownership is deliberately NOT done here.
-- REASSIGN OWNED works per database: run it in every database where the
-- role owns objects, as a superuser or other appropriately privileged
-- operator, then re-run this script.
DO $$
DECLARE
  owned_count int;
BEGIN
  SELECT count(*) INTO owned_count
  FROM pg_shdepend
  WHERE refclassid = 'pg_authid'::regclass
    AND refobjid = (SELECT oid FROM pg_roles WHERE rolname = 'beerpassport_admin_viewer')
    AND deptype = 'o';
  IF owned_count > 0 THEN
    RAISE EXCEPTION 'beerpassport_admin_viewer owns % database object(s). Reassign them first (REASSIGN OWNED BY beerpassport_admin_viewer TO <owner>, in every database where it owns objects) and re-run this script. Refusing to continue; no attributes, password, memberships, or privileges were changed.', owned_count;
  END IF;
END
$$;

-- Fail closed on unexpected DIRECT privileges, also before any change.
-- The clean-slate revokes further down only cover public-schema tables
-- and sequences, so without this audit a re-run could silently leave
-- privileges in other schemas, on functions or types, granted by
-- default privileges, or on other databases. The audit whitelists
-- exactly the intended grants (CONNECT on this database, USAGE on
-- public, SELECT on the intended tables and columns, nothing else) and
-- fails with the findings listed if anything else exists. Remediation
-- is manual and deliberate: REVOKE each listed privilege (in the
-- database named, for database-level findings), then re-run.
DO $$
DECLARE
  viewer_oid oid := (SELECT oid FROM pg_roles WHERE rolname = 'beerpassport_admin_viewer');
  findings text[] := '{}';
  r record;
BEGIN
  FOR r IN
    SELECT d.datname AS obj, a.privilege_type AS priv
    FROM pg_database d, aclexplode(d.datacl) a
    WHERE a.grantee = viewer_oid
      AND NOT (d.datname = current_database() AND a.privilege_type = 'CONNECT')
  LOOP
    findings := findings || format('database %s: %s', r.obj, r.priv);
  END LOOP;

  FOR r IN
    SELECT n.nspname AS obj, a.privilege_type AS priv
    FROM pg_namespace n, aclexplode(n.nspacl) a
    WHERE a.grantee = viewer_oid
      AND NOT (n.nspname = 'public' AND a.privilege_type = 'USAGE')
  LOOP
    findings := findings || format('schema %s: %s', r.obj, r.priv);
  END LOOP;

  FOR r IN
    SELECT n.nspname || '.' || c.relname AS obj, a.privilege_type AS priv
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
    WHERE a.grantee = viewer_oid
      AND c.relkind IN ('r', 'v', 'm', 'p', 'f', 'S')
      AND NOT (n.nspname = 'public' AND a.privilege_type = 'SELECT'
        AND c.relname IN ('beers', 'beverage_images', 'breweries',
          'breweries_geocode', 'categories', 'styles', 'collections',
          'collection_beers', 'user_beers', 'user_badges', 'friends',
          'notifications', 'users', 'api_keys', 'image_review_events',
          'discovery_batches', 'discovery_candidates',
          'discovery_candidate_pairs', 'discovery_decisions',
          'discovery_image_fetches', 'discovery_image_decisions',
          'discovery_import_manifests', 'discovery_manifest_events'))
  LOOP
    findings := findings || format('table %s: %s', r.obj, r.priv);
  END LOOP;

  FOR r IN
    SELECT n.nspname || '.' || c.relname || '.' || att.attname AS obj,
           a.privilege_type AS priv
    FROM pg_attribute att
    JOIN pg_class c ON c.oid = att.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(att.attacl) a
    WHERE a.grantee = viewer_oid
      AND att.attnum > 0 AND NOT att.attisdropped
      AND NOT (n.nspname = 'public' AND a.privilege_type = 'SELECT'
        AND ((c.relname = 'users' AND att.attname IN
               ('id', 'uid', 'age', 'email', 'user_name', 'private',
                'created_at', 'updated_at'))
          OR (c.relname = 'api_keys' AND att.attname IN
               ('id', 'name', 'revoked', 'created_at', 'last_used_at',
                'last_mod'))))
  LOOP
    findings := findings || format('column %s: %s', r.obj, r.priv);
  END LOOP;

  FOR r IN
    SELECT n.nspname || '.' || p.proname AS obj, a.privilege_type AS priv
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(p.proacl) a
    WHERE a.grantee = viewer_oid
  LOOP
    findings := findings || format('function %s: %s', r.obj, r.priv);
  END LOOP;

  FOR r IN
    SELECT n.nspname || '.' || t.typname AS obj, a.privilege_type AS priv
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace, aclexplode(t.typacl) a
    WHERE a.grantee = viewer_oid
  LOOP
    findings := findings || format('type %s: %s', r.obj, r.priv);
  END LOOP;

  FOR r IN
    SELECT a.privilege_type AS priv
    FROM pg_default_acl d, aclexplode(d.defaclacl) a
    WHERE a.grantee = viewer_oid
  LOOP
    findings := findings || format('default privileges: %s granted to viewer', r.priv);
  END LOOP;

  IF coalesce(array_length(findings, 1), 0) > 0 THEN
    RAISE EXCEPTION 'beerpassport_admin_viewer holds % unexpected direct privilege(s): %. Revoke each manually (database-level findings in the named database; object findings in this database) and re-run. Refusing to continue; nothing was changed.',
      array_length(findings, 1), array_to_string(findings[1:20], '; ');
  END IF;
END
$$;

-- CONNECTION LIMIT 20: the viewer's Prisma client pools connections and
-- the overview endpoint counts 14 tables concurrently; a limit of 5 was
-- tested locally and produced connection refusals under that fan-out.
-- 20 is still a hard bound, far below any operational risk.
ALTER ROLE beerpassport_admin_viewer
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 20
  PASSWORD :'viewer_password';

-- Remediate memberships: the viewer role must be a member of no other
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
    WHERE member.rolname = 'beerpassport_admin_viewer'
  LOOP
    EXECUTE format('REVOKE %I FROM beerpassport_admin_viewer', membership.granted_role);
    RAISE NOTICE 'Revoked unexpected role membership: beerpassport_admin_viewer was a member of %', membership.granted_role;
  END LOOP;
END
$$;

-- Clean slate for public-schema tables and sequences. Together with the
-- privilege audit above (which fails closed on anything beyond the
-- intended set, in any schema, in this database), re-running this file
-- converges the role's direct privileges in THIS database to exactly
-- the grants below. Database-level privileges are audited cluster-wide;
-- object grants in other databases are not visible from here and are
-- covered by running this script in each database (see runbook).
REVOKE ALL ON DATABASE :"dbname" FROM beerpassport_admin_viewer;
REVOKE ALL ON SCHEMA public FROM beerpassport_admin_viewer;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM beerpassport_admin_viewer;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM beerpassport_admin_viewer;

GRANT CONNECT ON DATABASE :"dbname" TO beerpassport_admin_viewer;
GRANT USAGE ON SCHEMA public TO beerpassport_admin_viewer;

-- Table-level SELECT on the tables with no sensitive columns.
GRANT SELECT ON
  beers,
  beverage_images,
  breweries,
  breweries_geocode,
  categories,
  styles,
  collections,
  collection_beers,
  user_beers,
  user_badges,
  friends,
  notifications,
  image_review_events
TO beerpassport_admin_viewer;

-- Discovery staging tables (migrations 002-005). This script runs
-- after migration 001 and BEFORE migrations 002-005 in the
-- documented application order, so the tables may not exist yet:
-- grant SELECT on each one that does exist, and skip (with a
-- notice) the ones still to come; their migrations grant SELECT to
-- this role, role-existence-guarded, when they land. On a re-run
-- against a migrated database every table exists, so this restores
-- all 8 discovery grants after the clean-slate revoke above; the
-- unguarded form (adding the tables to the GRANT list above) would
-- fail outright on a pre-002 database with "relation does not
-- exist".
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'discovery_batches', 'discovery_candidates',
    'discovery_candidate_pairs', 'discovery_decisions',
    'discovery_image_fetches', 'discovery_image_decisions',
    'discovery_import_manifests', 'discovery_manifest_events'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relname = t
                 AND c.relkind IN ('r', 'p')) THEN
      EXECUTE format('GRANT SELECT ON %I TO beerpassport_admin_viewer', t);
    ELSE
      RAISE NOTICE 'discovery table % not present yet; skipping its SELECT grant', t;
    END IF;
  END LOOP;
END
$$;

-- Column-level SELECT where a column must stay unreadable even at the
-- database layer: users.notification_token (push token) is excluded.
GRANT SELECT (
  id, uid, age, email, user_name, private, created_at, updated_at
) ON users TO beerpassport_admin_viewer;

-- api_keys.key (the credential itself) is excluded; metadata stays readable
-- so the Admin Accounts section can list keys without ever exposing one.
GRANT SELECT (
  id, name, revoked, created_at, last_used_at, last_mod
) ON api_keys TO beerpassport_admin_viewer;

-- Belt and braces: if the executing superuser has default privileges
-- defined, make sure none of them auto-grant anything to the viewer role.
-- Run the equivalent as every role that creates tables in this schema (in
-- practice the migration owner) so future tables never reach the viewer
-- by default.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  REVOKE ALL ON TABLES FROM beerpassport_admin_viewer;

COMMIT;
