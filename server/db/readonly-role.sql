-- Dedicated read-only runtime role for the BeerPassport Admin DB Viewer.
--
-- Run this as the database owner (or a superuser) against the target
-- database, with the role password supplied out of band, never in the file:
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
--   automatically, because that is a destructive operator decision. If
--   the script fails on ownership, reassign the objects first
--   (REASSIGN OWNED BY beerpassport_admin_viewer TO <owner>) and re-run.
-- Never run this with migration or application-owner credentials as the
-- viewer's runtime identity; this script is executed BY an owner ONCE to
-- create the separate, weaker runtime role.

\set ON_ERROR_STOP on
SELECT current_database() AS dbname \gset

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beerpassport_admin_viewer') THEN
    CREATE ROLE beerpassport_admin_viewer LOGIN;
  END IF;
END
$$;

-- CONNECTION LIMIT 20: the viewer's Prisma client pools connections and
-- the overview endpoint counts 14 tables concurrently; a limit of 5 was
-- tested locally and produced connection refusals under that fan-out.
-- 20 is still a hard bound, far below any operational risk.
ALTER ROLE beerpassport_admin_viewer
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  CONNECTION LIMIT 20
  PASSWORD :'viewer_password';

-- Fail closed on ownership: the viewer role must own no database objects
-- (in this database or any shared object such as a database itself).
-- pg_shdepend records an owner dependency (deptype 'o') for every object
-- a role owns; DROP OWNED uses the same catalog. Reassigning ownership is
-- deliberately NOT done here.
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
    RAISE EXCEPTION 'beerpassport_admin_viewer owns % database object(s). Reassign them first (REASSIGN OWNED BY beerpassport_admin_viewer TO <owner>) and re-run this script. Refusing to continue.', owned_count;
  END IF;
END
$$;

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

-- Clean slate, so re-running this file converges to exactly the grants below.
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
  notifications
TO beerpassport_admin_viewer;

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

-- Belt and braces: if the executing owner has default privileges defined,
-- make sure none of them auto-grant anything to the viewer role. Run the
-- equivalent as every role that creates tables in this schema (in practice
-- the migration owner) so future tables never reach the viewer by default.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  REVOKE ALL ON TABLES FROM beerpassport_admin_viewer;
