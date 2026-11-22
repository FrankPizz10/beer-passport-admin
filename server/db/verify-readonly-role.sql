-- Verification for the beerpassport_admin_viewer role.
--
-- Run CONNECTED AS the viewer role:
--
--   PGPASSWORD='<viewer password>' psql -h <host> -U beerpassport_admin_viewer \
--        -d <database> -f server/db/verify-readonly-role.sql
--
-- Expected: every check prints PASS and the script exits 0. Any unexpected
-- success raises an exception and psql exits non-zero. Everything runs in
-- one transaction that is rolled back, so even a (failing) successful write
-- leaves no trace.
\set ON_ERROR_STOP on
BEGIN;

-- Reads that must work.
SELECT count(*) AS beers_readable FROM beers;
SELECT count(*) AS breweries_readable FROM breweries;
SELECT id, user_name FROM users LIMIT 1;
SELECT id, name, revoked FROM api_keys LIMIT 1;
DO $$ BEGIN RAISE NOTICE 'PASS: approved reads succeed'; END $$;

-- Role attributes, memberships, and ownership. NOINHERIT alone would not
-- stop SET ROLE into a role the viewer belongs to, so membership must be
-- exactly zero; the SET ROLE attempt below is the behavioral proof (the
-- membership count is the general guarantee for every other role name).
DO $$
DECLARE
  attrs record;
  memberships int;
  owned int;
BEGIN
  SELECT rolsuper, rolcreaterole, rolcreatedb, rolinherit, rolcanlogin,
         rolreplication, rolbypassrls
    INTO attrs FROM pg_roles WHERE rolname = current_user;
  IF attrs.rolsuper OR attrs.rolcreaterole OR attrs.rolcreatedb OR attrs.rolinherit
     OR attrs.rolreplication OR attrs.rolbypassrls THEN
    RAISE EXCEPTION 'FAIL: role attributes are not fully restricted (super %, createrole %, createdb %, inherit %, replication %, bypassrls %)',
      attrs.rolsuper, attrs.rolcreaterole, attrs.rolcreatedb, attrs.rolinherit,
      attrs.rolreplication, attrs.rolbypassrls;
  END IF;
  IF NOT attrs.rolcanlogin THEN
    RAISE EXCEPTION 'FAIL: viewer role cannot log in';
  END IF;
  RAISE NOTICE 'PASS: role attributes restricted (NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOINHERIT, NOREPLICATION, NOBYPASSRLS, LOGIN)';

  SELECT count(*) INTO memberships
  FROM pg_auth_members
  WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user);
  IF memberships > 0 THEN
    RAISE EXCEPTION 'FAIL: viewer role is a member of % other role(s)', memberships;
  END IF;
  RAISE NOTICE 'PASS: viewer role has no role memberships';

  SELECT count(*) INTO owned
  FROM pg_shdepend
  WHERE refclassid = 'pg_authid'::regclass
    AND refobjid = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    AND deptype = 'o';
  IF owned > 0 THEN
    RAISE EXCEPTION 'FAIL: viewer role owns % database object(s)', owned;
  END IF;
  RAISE NOTICE 'PASS: viewer role owns no database objects';

  BEGIN
    EXECUTE 'SET ROLE postgres';
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'FAIL: SET ROLE postgres succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: SET ROLE into a more privileged role denied';
  END;
END
$$;

-- No unexpected DIRECT privileges: beyond the intended grants (CONNECT
-- on this database, USAGE on public, SELECT on the intended tables and
-- columns), the role must hold nothing, in any schema of this database,
-- on functions or types, via default privileges, or at database level
-- anywhere in the cluster. This mirrors the setup script's audit.
DO $$
DECLARE
  me oid := (SELECT oid FROM pg_roles WHERE rolname = current_user);
  unexpected int := 0;
BEGIN
  SELECT unexpected + count(*) INTO unexpected
  FROM pg_database d, aclexplode(d.datacl) a
  WHERE a.grantee = me
    AND NOT (d.datname = current_database() AND a.privilege_type = 'CONNECT');
  SELECT unexpected + count(*) INTO unexpected
  FROM pg_namespace n, aclexplode(n.nspacl) a
  WHERE a.grantee = me
    AND NOT (n.nspname = 'public' AND a.privilege_type = 'USAGE');
  SELECT unexpected + count(*) INTO unexpected
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
  WHERE a.grantee = me AND c.relkind IN ('r', 'v', 'm', 'p', 'f', 'S')
    AND NOT (n.nspname = 'public' AND a.privilege_type = 'SELECT'
      AND c.relname IN ('beers', 'beverage_images', 'breweries',
        'breweries_geocode', 'categories', 'styles', 'collections',
        'collection_beers', 'user_beers', 'user_badges', 'friends',
        'notifications', 'users', 'api_keys'));
  SELECT unexpected + count(*) INTO unexpected
  FROM pg_attribute att
  JOIN pg_class c ON c.oid = att.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(att.attacl) a
  WHERE a.grantee = me AND att.attnum > 0 AND NOT att.attisdropped
    AND NOT (n.nspname = 'public' AND a.privilege_type = 'SELECT'
      AND ((c.relname = 'users' AND att.attname IN
             ('id', 'uid', 'age', 'email', 'user_name', 'private',
              'created_at', 'updated_at'))
        OR (c.relname = 'api_keys' AND att.attname IN
             ('id', 'name', 'revoked', 'created_at', 'last_used_at',
              'last_mod'))));
  SELECT unexpected + count(*) INTO unexpected
  FROM pg_proc p, aclexplode(p.proacl) a
  WHERE a.grantee = me;
  SELECT unexpected + count(*) INTO unexpected
  FROM pg_type t, aclexplode(t.typacl) a
  WHERE a.grantee = me;
  SELECT unexpected + count(*) INTO unexpected
  FROM pg_default_acl d, aclexplode(d.defaclacl) a
  WHERE a.grantee = me;
  IF unexpected > 0 THEN
    RAISE EXCEPTION 'FAIL: viewer role holds % unexpected direct privilege(s)', unexpected;
  END IF;
  RAISE NOTICE 'PASS: no unexpected direct privileges in this database or at database level';
END
$$;

-- Sensitive columns that must be denied at the database layer.
DO $$
BEGIN
  BEGIN
    PERFORM notification_token FROM users LIMIT 1;
    RAISE EXCEPTION 'FAIL: users.notification_token is readable';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: users.notification_token denied';
  END;
  BEGIN
    PERFORM key FROM api_keys LIMIT 1;
    RAISE EXCEPTION 'FAIL: api_keys.key is readable';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: api_keys.key denied';
  END;
END
$$;

-- Writes that must all be denied.
DO $$
BEGIN
  BEGIN
    INSERT INTO categories (id) VALUES (-1);
    RAISE EXCEPTION 'FAIL: INSERT into categories succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: INSERT denied';
  END;
  BEGIN
    UPDATE beers SET name = name WHERE id = -1;
    RAISE EXCEPTION 'FAIL: UPDATE on beers succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE denied';
  END;
  BEGIN
    DELETE FROM beers WHERE id = -1;
    RAISE EXCEPTION 'FAIL: DELETE on beers succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: DELETE denied';
  END;
  BEGIN
    TRUNCATE categories;
    RAISE EXCEPTION 'FAIL: TRUNCATE succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: TRUNCATE denied';
  END;
  BEGIN
    CREATE TABLE viewer_escape_test (id int);
    RAISE EXCEPTION 'FAIL: CREATE TABLE succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: CREATE TABLE denied';
  END;
END
$$;

ROLLBACK;
