-- Dedicated discovery-review role for the BeerPassport Admin catalog
-- discovery hub (hub decision 006, issues/001-catalog-discovery-hub.md
-- section 3). This is the write identity for the discovery review
-- endpoints (server/src/routes/discoveryDecisions.ts and, since the
-- image review phase, server/src/routes/discoveryImages.ts), and it
-- can write exactly these things: the decision columns of
-- discovery_candidates, the decision columns of
-- discovery_candidate_pairs, the discovery_decisions audit table
-- (migration server/db/migrations/003-discovery-decisions.sql), the
-- image fetch log and image decision audit tables, and the candidate
-- image-decision state columns (migration
-- server/db/migrations/004-discovery-image-review.sql), and - since
-- the manifest phase - INSERT and SELECT on the import manifest
-- tables plus UPDATE on exactly the four manifest approval columns
-- (status, approved_by, approved_at, approved_sha256; migration
-- server/db/migrations/005-discovery-manifests.sql). The role can
-- build, approve, and void manifests; it can NEVER mark one imported
-- (no UPDATE on imported_at, manifest, or sha256) and it has no
-- access to any catalog table beyond the SELECT grants below. The
-- viewer role (beerpassport_admin_viewer) stays SELECT-only and is
-- untouched by this script; the approver role
-- (beerpassport_admin_approver) is likewise untouched.
--
-- Run this ONCE, as a PostgreSQL superuser (for example the postgres
-- role), against the target database, with the role password supplied
-- out of band, never in the file. Migrations
-- server/db/migrations/002-discovery-staging.sql,
-- server/db/migrations/003-discovery-decisions.sql, and
-- server/db/migrations/004-discovery-image-review.sql must be applied
-- FIRST: the grants below name their tables and columns, and if they
-- are missing the script fails and rolls back (fail closed by
-- construction).
--
--   psql -d <database> -v reviewer_password='<set-at-deploy-time>' \
--        -f server/db/discovery-reviewer-role.sql
--
-- (Migration server/db/migrations/005-discovery-manifests.sql must
-- also be applied first, like 002 to 004 below.)
--
-- Properties enforced here, mirroring server/db/approval-role.sql:
--   LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT,
--   NOREPLICATION, NOBYPASSRLS, CONNECTION LIMIT 5. The role owns
--   nothing and is a member of no other role. It receives NO default
--   privileges: tables created later are invisible to it until a human
--   adds an explicit GRANT in a reviewed change.
--   Ownership: the script FAILS CLOSED if the role owns any database
--   objects, before any attribute or password change, leaving an
--   existing role completely untouched. Ownership is never reassigned
--   automatically; a superuser runs REASSIGN OWNED BY
--   beerpassport_discovery_reviewer TO <new_owner> in EVERY database
--   where the role owns objects, then re-runs this script.
--   Privilege audit: the script also FAILS CLOSED if the role holds
--   any DIRECT privilege beyond the intended grants below, in this
--   database (any schema; tables, columns, sequences, functions,
--   types, and default privileges) or at database level anywhere in
--   the cluster. Remediation is manual: revoke each listed privilege,
--   then re-run. Privileges granted to PUBLIC are platform defaults
--   shared by every role, not direct grants to this one, and are
--   outside the audit.
--
-- Why the grants are shaped this way (issues/001 section 3): the
-- decision endpoints pre-check each row through the read-only viewer
-- connection, then run ONE transaction as this role that (a) updates
-- the candidate or pair only where its status is still the expected
-- one (the status predicate is the concurrency guard; Prisma's
-- updateMany returns only a count, so nothing beyond the granted
-- columns is ever read back) and (b) inserts the audit row into
-- discovery_decisions. The SELECT grants on the discovery tables and
-- on beers and breweries let the write identity verify the rows it is
-- deciding about and render a pair's live-catalog rival; they confer
-- no write access to any catalog table. There is deliberately NO
-- grant touching discovery_batches (batches are ingest-owned), no
-- INSERT or DELETE on candidates or pairs, and no access to users
-- beyond the decided_by foreign key the API writes by id.
--
-- Atomicity: everything after the \gset runs in ONE transaction. Any
-- failure rolls back every change the run made. Run it as a plain
-- psql script exactly as documented above; do not wrap it in an outer
-- transaction or --single-transaction (the script manages its own).

\set ON_ERROR_STOP on
SELECT current_database() AS dbname \gset

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beerpassport_discovery_reviewer') THEN
    CREATE ROLE beerpassport_discovery_reviewer LOGIN;
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
    AND refobjid = (SELECT oid FROM pg_roles WHERE rolname = 'beerpassport_discovery_reviewer')
    AND deptype = 'o';
  IF owned_count > 0 THEN
    RAISE EXCEPTION 'beerpassport_discovery_reviewer owns % database object(s). Reassign them first (REASSIGN OWNED BY beerpassport_discovery_reviewer TO <owner>, in every database where it owns objects) and re-run this script. Refusing to continue; no attributes, password, memberships, or privileges were changed.', owned_count;
  END IF;
END
$$;

-- Fail closed on unexpected DIRECT privileges, also before any change.
-- The whitelist is exactly the intended grants: CONNECT on this
-- database, USAGE on public, table-level SELECT on discovery_batches,
-- discovery_candidates, discovery_candidate_pairs, beers, and
-- breweries, INSERT and SELECT on discovery_decisions,
-- discovery_image_fetches, discovery_image_decisions,
-- discovery_import_manifests, and discovery_manifest_events, USAGE
-- on their id sequences, and the column-level UPDATE sets on
-- candidates (decision columns plus image-decision state columns),
-- pairs, and import manifests (the four approval columns only).
-- Anything else is listed and the run refuses to continue.
DO $$
DECLARE
  reviewer_oid oid := (SELECT oid FROM pg_roles WHERE rolname = 'beerpassport_discovery_reviewer');
  findings text[] := '{}';
  r record;
BEGIN
  FOR r IN
    SELECT d.datname AS obj, a.privilege_type AS priv
    FROM pg_database d, aclexplode(d.datacl) a
    WHERE a.grantee = reviewer_oid
      AND NOT (d.datname = current_database() AND a.privilege_type = 'CONNECT')
  LOOP
    findings := findings || format('database %s: %s', r.obj, r.priv);
  END LOOP;

  FOR r IN
    SELECT n.nspname AS obj, a.privilege_type AS priv
    FROM pg_namespace n, aclexplode(n.nspacl) a
    WHERE a.grantee = reviewer_oid
      AND NOT (n.nspname = 'public' AND a.privilege_type = 'USAGE')
  LOOP
    findings := findings || format('schema %s: %s', r.obj, r.priv);
  END LOOP;

  FOR r IN
    SELECT n.nspname || '.' || c.relname AS obj, a.privilege_type AS priv
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
    WHERE a.grantee = reviewer_oid
      AND c.relkind IN ('r', 'v', 'm', 'p', 'f', 'S')
      AND NOT (n.nspname = 'public'
        AND ((c.relname IN ('discovery_batches', 'discovery_candidates',
              'discovery_candidate_pairs', 'beers', 'breweries')
              AND c.relkind = 'r' AND a.privilege_type = 'SELECT')
          OR (c.relname IN ('discovery_decisions', 'discovery_image_fetches',
              'discovery_image_decisions', 'discovery_import_manifests',
              'discovery_manifest_events') AND c.relkind = 'r'
              AND a.privilege_type IN ('INSERT', 'SELECT'))
          OR (c.relname IN ('discovery_decisions_id_seq',
              'discovery_image_fetches_id_seq',
              'discovery_image_decisions_id_seq',
              'discovery_manifest_events_id_seq') AND c.relkind = 'S'
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
    WHERE a.grantee = reviewer_oid
      AND att.attnum > 0 AND NOT att.attisdropped
      AND NOT (n.nspname = 'public'
        AND ((c.relname = 'discovery_candidates'
              AND a.privilege_type = 'UPDATE'
              AND att.attname IN ('review_status', 'hold_reason',
                'duplicate_of_candidate_id', 'updated_at',
                'image_decision', 'image_decision_fetch_id',
                'image_decision_at'))
          OR (c.relname = 'discovery_candidate_pairs'
              AND a.privilege_type = 'UPDATE'
              AND att.attname IN ('status', 'decided_by', 'decided_at'))
          OR (c.relname = 'discovery_import_manifests'
              AND a.privilege_type = 'UPDATE'
              AND att.attname IN ('status', 'approved_by', 'approved_at',
                'approved_sha256'))))
  LOOP
    findings := findings || format('column %s: %s', r.obj, r.priv);
  END LOOP;

  FOR r IN
    SELECT n.nspname || '.' || p.proname AS obj, a.privilege_type AS priv
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(p.proacl) a
    WHERE a.grantee = reviewer_oid
  LOOP
    findings := findings || format('function %s: %s', r.obj, r.priv);
  END LOOP;

  FOR r IN
    SELECT n.nspname || '.' || t.typname AS obj, a.privilege_type AS priv
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace, aclexplode(t.typacl) a
    WHERE a.grantee = reviewer_oid
  LOOP
    findings := findings || format('type %s: %s', r.obj, r.priv);
  END LOOP;

  FOR r IN
    SELECT a.privilege_type AS priv
    FROM pg_default_acl d, aclexplode(d.defaclacl) a
    WHERE a.grantee = reviewer_oid
  LOOP
    findings := findings || format('default privileges: %s granted to reviewer', r.priv);
  END LOOP;

  IF coalesce(array_length(findings, 1), 0) > 0 THEN
    RAISE EXCEPTION 'beerpassport_discovery_reviewer holds % unexpected direct privilege(s): %. Revoke each manually (database-level findings in the named database; object findings in this database) and re-run. Refusing to continue; nothing was changed.',
      array_length(findings, 1), array_to_string(findings[1:20], '; ');
  END IF;
END
$$;

-- CONNECTION LIMIT 5: the write path is one Prisma client used only by
-- the decision endpoints, at human click rate. 5 is a hard bound, far
-- below any operational risk.
ALTER ROLE beerpassport_discovery_reviewer
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 5
  PASSWORD :'reviewer_password';

-- Remediate memberships: the reviewer role must be a member of no other
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
    WHERE member.rolname = 'beerpassport_discovery_reviewer'
  LOOP
    EXECUTE format('REVOKE %I FROM beerpassport_discovery_reviewer', membership.granted_role);
    RAISE NOTICE 'Revoked unexpected role membership: beerpassport_discovery_reviewer was a member of %', membership.granted_role;
  END LOOP;
END
$$;

-- Clean slate, then exactly the intended grants. Together with the
-- privilege audit above, re-running this file converges the role's
-- direct privileges in THIS database to exactly the grants below.
REVOKE ALL ON DATABASE :"dbname" FROM beerpassport_discovery_reviewer;
REVOKE ALL ON SCHEMA public FROM beerpassport_discovery_reviewer;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM beerpassport_discovery_reviewer;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM beerpassport_discovery_reviewer;

GRANT CONNECT ON DATABASE :"dbname" TO beerpassport_discovery_reviewer;
GRANT USAGE ON SCHEMA public TO beerpassport_discovery_reviewer;

-- Read access: the discovery tables (batches read-only in practice;
-- the write surface below is column-scoped) and the two catalog tables
-- a pair decision may need to render (a rival that is a live beer).
-- No write verb on any of these beyond the column grants.
GRANT SELECT ON discovery_batches, discovery_candidates,
  discovery_candidate_pairs, beers, breweries
  TO beerpassport_discovery_reviewer;

-- Candidate decision columns only (issues/001 section 3): the review
-- status, its hold reason, the duplicate pointer a pair decision sets,
-- the image-decision state a hash-bound image decision projects
-- (migration 004), and the row timestamp. No INSERT, no DELETE, no
-- other column.
GRANT UPDATE (review_status, hold_reason, duplicate_of_candidate_id, updated_at,
  image_decision, image_decision_fetch_id, image_decision_at)
  ON discovery_candidates TO beerpassport_discovery_reviewer;

-- Pair decision columns only: the pair status and its decider stamp.
GRANT UPDATE (status, decided_by, decided_at)
  ON discovery_candidate_pairs TO beerpassport_discovery_reviewer;

-- The audit trail: append (INSERT) and read back (SELECT), nothing else.
GRANT INSERT, SELECT ON discovery_decisions TO beerpassport_discovery_reviewer;
GRANT USAGE ON SEQUENCE discovery_decisions_id_seq TO beerpassport_discovery_reviewer;

-- Image review (migration 004): the fetch log and the image decision
-- audit are append-and-read for this role, exactly like
-- discovery_decisions. The fetcher writes one fetches row per attempt;
-- the decision endpoint inserts the decision row and projects the
-- candidate state columns above. No UPDATE or DELETE on either table.
GRANT INSERT, SELECT ON discovery_image_fetches, discovery_image_decisions
  TO beerpassport_discovery_reviewer;
GRANT USAGE ON SEQUENCE discovery_image_fetches_id_seq,
  discovery_image_decisions_id_seq TO beerpassport_discovery_reviewer;

-- Import manifests (migration 005): build (INSERT), read back
-- (SELECT), the lifecycle audit (INSERT and SELECT on the events
-- table), and UPDATE on exactly the four approval columns the
-- approval and void endpoints write. There is deliberately NO grant
-- on imported_at, manifest, sha256, record_count, or
-- catalog_fingerprint: manifest content is immutable for this role
-- and marking a manifest imported is the operator executor's act.
GRANT INSERT, SELECT ON discovery_import_manifests, discovery_manifest_events
  TO beerpassport_discovery_reviewer;
GRANT UPDATE (status, approved_by, approved_at, approved_sha256)
  ON discovery_import_manifests TO beerpassport_discovery_reviewer;
GRANT USAGE ON SEQUENCE discovery_manifest_events_id_seq
  TO beerpassport_discovery_reviewer;

-- Belt and braces: no default privileges may auto-grant this role
-- anything on future tables.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  REVOKE ALL ON TABLES FROM beerpassport_discovery_reviewer;

COMMIT;
