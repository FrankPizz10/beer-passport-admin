-- Verification for the beerpassport_admin_approver role.
--
-- Run CONNECTED AS the approver role, AFTER server/db/approval-role.sql
-- and migration server/db/migrations/001-image-approval.sql:
--
--   PGPASSWORD='<approver password>' psql -h <host> -U beerpassport_admin_approver \
--        -d <database> -f server/db/verify-approval-role.sql
--
-- Expected: every check prints PASS and the script exits 0. Any
-- unexpected success raises an exception and psql exits non-zero.
-- Everything runs in one transaction that is rolled back, so the
-- (successful) allowed writes below leave no trace.
\set ON_ERROR_STOP on
BEGIN;

-- Role attributes, connection limit, memberships, and ownership.
DO $$
DECLARE
  attrs record;
  memberships int;
  owned int;
BEGIN
  SELECT rolsuper, rolcreaterole, rolcreatedb, rolinherit, rolcanlogin,
         rolreplication, rolbypassrls, rolconnlimit
    INTO attrs FROM pg_roles WHERE rolname = current_user;
  IF attrs.rolsuper OR attrs.rolcreaterole OR attrs.rolcreatedb OR attrs.rolinherit
     OR attrs.rolreplication OR attrs.rolbypassrls THEN
    RAISE EXCEPTION 'FAIL: role attributes are not fully restricted (super %, createrole %, createdb %, inherit %, replication %, bypassrls %)',
      attrs.rolsuper, attrs.rolcreaterole, attrs.rolcreatedb, attrs.rolinherit,
      attrs.rolreplication, attrs.rolbypassrls;
  END IF;
  IF NOT attrs.rolcanlogin THEN
    RAISE EXCEPTION 'FAIL: approver role cannot log in';
  END IF;
  IF attrs.rolconnlimit <> 5 THEN
    RAISE EXCEPTION 'FAIL: connection limit is %, expected 5', attrs.rolconnlimit;
  END IF;
  RAISE NOTICE 'PASS: role attributes restricted (NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOINHERIT, NOREPLICATION, NOBYPASSRLS, LOGIN, CONNECTION LIMIT 5)';

  SELECT count(*) INTO memberships
  FROM pg_auth_members
  WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user);
  IF memberships > 0 THEN
    RAISE EXCEPTION 'FAIL: approver role is a member of % other role(s)', memberships;
  END IF;
  RAISE NOTICE 'PASS: approver role has no role memberships';

  SELECT count(*) INTO owned
  FROM pg_shdepend
  WHERE refclassid = 'pg_authid'::regclass
    AND refobjid = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    AND deptype = 'o';
  IF owned > 0 THEN
    RAISE EXCEPTION 'FAIL: approver role owns % database object(s)', owned;
  END IF;
  RAISE NOTICE 'PASS: approver role owns no database objects';

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
-- on this database, USAGE on public, the two column-level sets on
-- beverage_images, INSERT and SELECT on image_review_events, USAGE on
-- its sequence), the role must hold nothing. Mirrors the setup audit.
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
    AND NOT (n.nspname = 'public'
      AND ((c.relname = 'image_review_events' AND c.relkind = 'r'
            AND a.privilege_type IN ('INSERT', 'SELECT'))
        OR (c.relname = 'image_review_events_id_seq' AND c.relkind = 'S'
            AND a.privilege_type = 'USAGE')));
  SELECT unexpected + count(*) INTO unexpected
  FROM pg_attribute att
  JOIN pg_class c ON c.oid = att.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(att.attacl) a
  WHERE a.grantee = me AND att.attnum > 0 AND NOT att.attisdropped
    AND NOT (n.nspname = 'public' AND c.relname = 'beverage_images'
      AND ((a.privilege_type = 'SELECT'
            AND att.attname IN ('id', 'beverage_id', 'status'))
        OR (a.privilege_type = 'UPDATE'
            AND att.attname IN ('status', 'verified_at', 'reviewed_by',
              'reviewed_by_uid', 'reviewed_at', 'updated_at'))));
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
    RAISE EXCEPTION 'FAIL: approver role holds % unexpected direct privilege(s)', unexpected;
  END IF;
  RAISE NOTICE 'PASS: no unexpected direct privileges in this database or at database level';
END
$$;

-- Operations that must WORK (all rolled back at the end).
DO $$
DECLARE
  img_id int;
  bev_id int;
BEGIN
  -- The three readable columns of beverage_images.
  SELECT id, beverage_id INTO img_id, bev_id
  FROM beverage_images ORDER BY id LIMIT 1;
  PERFORM status FROM beverage_images LIMIT 1;
  RAISE NOTICE 'PASS: SELECT (id, beverage_id, status) on beverage_images succeeds';

  -- The one allowed write: the decision columns, guarded by the
  -- pending-status predicate the API uses. With no rows in the table
  -- this updates zero rows; the privilege check happens either way.
  UPDATE beverage_images
     SET status = 'approved', verified_at = CURRENT_TIMESTAMP,
         reviewed_by = NULL, reviewed_by_uid = NULL,
         reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
   WHERE id = img_id AND status = 'pending';
  RAISE NOTICE 'PASS: UPDATE of the decision columns on beverage_images succeeds';

  -- Audit trail: read and append. With no beverage_images row to point
  -- at, the append is stopped by the foreign key, which still proves
  -- the INSERT privilege (a missing privilege would fail first, with
  -- insufficient_privilege).
  PERFORM count(*) FROM image_review_events;
  BEGIN
    INSERT INTO image_review_events
      (beverage_image_id, beverage_id, action, from_status, to_status)
    VALUES (coalesce(img_id, -1), coalesce(bev_id, -1),
            'approve', 'pending', 'approved');
    RAISE NOTICE 'PASS: INSERT into image_review_events succeeds';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: INSERT into image_review_events is privileged (stopped only by the foreign key; no beverage_images row exists to reference)';
  END;
END
$$;

-- Operations that must all be DENIED.
DO $$
BEGIN
  BEGIN
    UPDATE beverage_images SET source_url = source_url WHERE id = -1;
    RAISE EXCEPTION 'FAIL: UPDATE of a non-decision column succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE of any other beverage_images column denied';
  END;
  BEGIN
    PERFORM storage_key FROM beverage_images LIMIT 1;
    RAISE EXCEPTION 'FAIL: storage_key is readable by the approver role';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: SELECT of storage_key denied';
  END;
  BEGIN
    INSERT INTO beverage_images (beverage_id) VALUES (-1);
    RAISE EXCEPTION 'FAIL: INSERT into beverage_images succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: INSERT into beverage_images denied';
  END;
  BEGIN
    DELETE FROM beverage_images WHERE id = -1;
    RAISE EXCEPTION 'FAIL: DELETE on beverage_images succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: DELETE on beverage_images denied';
  END;
  BEGIN
    PERFORM id FROM users LIMIT 1;
    RAISE EXCEPTION 'FAIL: SELECT on users succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: SELECT on users denied';
  END;
  BEGIN
    UPDATE beers SET name = name WHERE id = -1;
    RAISE EXCEPTION 'FAIL: UPDATE on beers succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE on beers denied';
  END;
  BEGIN
    DELETE FROM image_review_events WHERE id = -1;
    RAISE EXCEPTION 'FAIL: DELETE on image_review_events succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: DELETE on image_review_events denied';
  END;
  BEGIN
    CREATE TABLE approver_escape_test (id int);
    RAISE EXCEPTION 'FAIL: CREATE TABLE succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: CREATE TABLE denied';
  END;
END
$$;

ROLLBACK;
