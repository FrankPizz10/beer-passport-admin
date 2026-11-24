-- Verification for the beerpassport_discovery_reviewer role.
--
-- Run CONNECTED AS the reviewer role, AFTER
-- server/db/discovery-reviewer-role.sql and migrations
-- server/db/migrations/002-discovery-staging.sql,
-- server/db/migrations/003-discovery-decisions.sql,
-- server/db/migrations/004-discovery-image-review.sql, and
-- server/db/migrations/005-discovery-manifests.sql:
--
--   PGPASSWORD='<reviewer password>' psql -h <host> -U beerpassport_discovery_reviewer \
--        -d <database> -f server/db/verify-discovery-reviewer.sql
--
-- Expected: every check prints PASS and the script exits 0. Any
-- unexpected success raises an exception and psql exits non-zero.
-- Everything runs in one transaction that is rolled back, so the
-- (successful) allowed writes below leave no trace.
\set ON_ERROR_STOP on
BEGIN;

-- Optional until the canonical review-intent migration has been applied.
DO $$
BEGIN
  IF to_regclass('public.discovery_review_intents') IS NOT NULL THEN
    IF NOT has_table_privilege(current_user, 'public.discovery_review_intents', 'SELECT')
       OR NOT has_table_privilege(current_user, 'public.discovery_review_intents', 'INSERT')
       OR NOT has_sequence_privilege(current_user, 'public.discovery_review_intents_id_seq', 'USAGE')
       OR has_table_privilege(current_user, 'public.discovery_review_intents', 'UPDATE')
       OR has_table_privilege(current_user, 'public.discovery_review_intents', 'DELETE') THEN
      RAISE EXCEPTION 'FAIL: review-intent privileges are not append-only';
    END IF;
    RAISE NOTICE 'PASS: review-intent privileges are append-only';
  END IF;
END $$;

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
    RAISE EXCEPTION 'FAIL: reviewer role cannot log in';
  END IF;
  IF attrs.rolconnlimit <> 5 THEN
    RAISE EXCEPTION 'FAIL: connection limit is %, expected 5', attrs.rolconnlimit;
  END IF;
  RAISE NOTICE 'PASS: role attributes restricted (NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOINHERIT, NOREPLICATION, NOBYPASSRLS, LOGIN, CONNECTION LIMIT 5)';

  SELECT count(*) INTO memberships
  FROM pg_auth_members
  WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user);
  IF memberships > 0 THEN
    RAISE EXCEPTION 'FAIL: reviewer role is a member of % other role(s)', memberships;
  END IF;
  RAISE NOTICE 'PASS: reviewer role has no role memberships';

  SELECT count(*) INTO owned
  FROM pg_shdepend
  WHERE refclassid = 'pg_authid'::regclass
    AND refobjid = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    AND deptype = 'o';
  IF owned > 0 THEN
    RAISE EXCEPTION 'FAIL: reviewer role owns % database object(s)', owned;
  END IF;
  RAISE NOTICE 'PASS: reviewer role owns no database objects';

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
-- on this database, USAGE on public, SELECT on the discovery tables
-- and on beers and breweries, the column-level UPDATE sets, INSERT
-- and SELECT on discovery_decisions, discovery_image_fetches,
-- discovery_image_decisions, discovery_import_manifests, and
-- discovery_manifest_events, USAGE on their sequences), the role
-- must hold nothing. Mirrors the setup audit.
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
      AND ((c.relname IN ('discovery_batches', 'discovery_candidates',
             'discovery_candidate_pairs', 'beers', 'breweries')
             AND c.relkind = 'r' AND a.privilege_type = 'SELECT')
         OR (c.relname IN ('discovery_decisions', 'discovery_image_fetches',
             'discovery_image_decisions', 'discovery_import_manifests',
             'discovery_manifest_events', 'discovery_review_intents') AND c.relkind = 'r'
             AND a.privilege_type IN ('INSERT', 'SELECT'))
         OR (c.relname IN ('discovery_decisions_id_seq',
             'discovery_image_fetches_id_seq',
             'discovery_image_decisions_id_seq',
             'discovery_manifest_events_id_seq', 'discovery_review_intents_id_seq') AND c.relkind = 'S'
             AND a.privilege_type = 'USAGE')));
  SELECT unexpected + count(*) INTO unexpected
  FROM pg_attribute att
  JOIN pg_class c ON c.oid = att.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(att.attacl) a
  WHERE a.grantee = me AND att.attnum > 0 AND NOT att.attisdropped
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
              'approved_sha256'))));
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
    RAISE EXCEPTION 'FAIL: reviewer role holds % unexpected direct privilege(s)', unexpected;
  END IF;
  RAISE NOTICE 'PASS: no unexpected direct privileges in this database or at database level';
END
$$;

-- Operations that must WORK (all rolled back at the end).
DO $$
DECLARE
  cand_id int;
  pair_id int;
BEGIN
  PERFORM count(*) FROM discovery_batches;
  PERFORM count(*) FROM discovery_candidates;
  PERFORM count(*) FROM discovery_candidate_pairs;
  PERFORM count(*) FROM beers;
  PERFORM count(*) FROM breweries;
  RAISE NOTICE 'PASS: SELECT on discovery tables, beers, and breweries succeeds';

  SELECT id INTO cand_id FROM discovery_candidates ORDER BY id LIMIT 1;
  SELECT id INTO pair_id FROM discovery_candidate_pairs ORDER BY id LIMIT 1;

  -- The allowed candidate write: the decision columns, guarded by the
  -- status predicate the API uses. With no rows in the table this
  -- updates zero rows; the privilege check happens either way.
  UPDATE discovery_candidates
     SET review_status = 'held', hold_reason = 'other',
         duplicate_of_candidate_id = duplicate_of_candidate_id,
         updated_at = CURRENT_TIMESTAMP
   WHERE id = cand_id AND review_status = 'pending';
  RAISE NOTICE 'PASS: UPDATE of the candidate decision columns succeeds';

  -- The allowed pair write: status and the decider stamp, guarded by
  -- the pending predicate.
  UPDATE discovery_candidate_pairs
     SET status = 'distinct', decided_by = NULL, decided_at = CURRENT_TIMESTAMP
   WHERE id = pair_id AND status = 'pending';
  RAISE NOTICE 'PASS: UPDATE of the pair decision columns succeeds';

  -- Audit trail: read and append. With no candidate row to point at,
  -- the append is stopped by the target-present CHECK constraint (or
  -- the foreign key), which still proves the INSERT privilege (a
  -- missing privilege would fail first, with
  -- insufficient_privilege).
  PERFORM count(*) FROM discovery_decisions;
  BEGIN
    INSERT INTO discovery_decisions
      (candidate_id, decision, from_status, to_status)
    VALUES (cand_id, 'hold', 'pending', 'held');
    RAISE NOTICE 'PASS: INSERT into discovery_decisions succeeds';
  EXCEPTION WHEN foreign_key_violation OR check_violation THEN
    RAISE NOTICE 'PASS: INSERT into discovery_decisions is privileged (stopped only by a constraint; no candidate row exists to reference)';
  END;

  -- Image review (migration 004): the candidate image-decision state
  -- columns are writable; the fetch log and the image decision audit
  -- are readable and appendable (same constraint trick: with no
  -- candidate row, the foreign key stops the append only after the
  -- privilege check has passed).
  UPDATE discovery_candidates
     SET image_decision = 'approved', image_decision_fetch_id = NULL,
         image_decision_at = CURRENT_TIMESTAMP
   WHERE id = cand_id;
  RAISE NOTICE 'PASS: UPDATE of the candidate image-decision columns succeeds';

  PERFORM count(*) FROM discovery_image_fetches;
  PERFORM count(*) FROM discovery_image_decisions;
  RAISE NOTICE 'PASS: SELECT on discovery image tables succeeds';
  BEGIN
    INSERT INTO discovery_image_fetches (candidate_id, image_ref, outcome)
    VALUES (cand_id, 'https://example.invalid/x.png', 'success');
    RAISE NOTICE 'PASS: INSERT into discovery_image_fetches succeeds';
  EXCEPTION WHEN foreign_key_violation OR check_violation OR not_null_violation THEN
    RAISE NOTICE 'PASS: INSERT into discovery_image_fetches is privileged (stopped only by a constraint; no candidate row exists to reference)';
  END;
  BEGIN
    INSERT INTO discovery_image_decisions
      (candidate_id, fetch_id, image_ref, image_sha256, decision)
    VALUES (cand_id, -1, 'https://example.invalid/x.png', repeat('0', 64), 'approved');
    RAISE NOTICE 'PASS: INSERT into discovery_image_decisions succeeds';
  EXCEPTION WHEN foreign_key_violation OR check_violation OR not_null_violation THEN
    RAISE NOTICE 'PASS: INSERT into discovery_image_decisions is privileged (stopped only by a constraint; no fetch row exists to reference)';
  END;

  -- Import manifests (migration 005): readable, buildable (INSERT),
  -- and updatable on exactly the four approval columns. The INSERT
  -- appends are stopped by the batch foreign key when no batch row
  -- exists, which still proves the privilege (same trick as above).
  PERFORM count(*) FROM discovery_import_manifests;
  PERFORM count(*) FROM discovery_manifest_events;
  RAISE NOTICE 'PASS: SELECT on discovery manifest tables succeeds';
  BEGIN
    INSERT INTO discovery_import_manifests
      (id, batch_id, manifest, sha256, record_count, catalog_fingerprint)
    VALUES ('mf-verify-20260101-01', -1, '{}'::jsonb, repeat('1', 64), 0, '{}'::jsonb);
    RAISE NOTICE 'PASS: INSERT into discovery_import_manifests succeeds';
  EXCEPTION WHEN foreign_key_violation OR check_violation OR not_null_violation THEN
    RAISE NOTICE 'PASS: INSERT into discovery_import_manifests is privileged (stopped only by a constraint; no batch row exists to reference)';
  END;
  BEGIN
    INSERT INTO discovery_manifest_events (manifest_id, action)
    VALUES ('mf-verify-20260101-01', 'build');
    RAISE NOTICE 'PASS: INSERT into discovery_manifest_events succeeds';
  EXCEPTION WHEN foreign_key_violation OR check_violation OR not_null_violation THEN
    RAISE NOTICE 'PASS: INSERT into discovery_manifest_events is privileged (stopped only by a constraint; no manifest row exists to reference)';
  END;
  UPDATE discovery_import_manifests
     SET status = 'approved', approved_by = NULL, approved_at = CURRENT_TIMESTAMP,
         approved_sha256 = repeat('1', 64)
   WHERE id = 'mf-no-such-manifest';
  RAISE NOTICE 'PASS: UPDATE of the four manifest approval columns succeeds';
END
$$;

-- Operations that must all be DENIED.
DO $$
BEGIN
  BEGIN
    UPDATE discovery_candidates SET name = name WHERE id = -1;
    RAISE EXCEPTION 'FAIL: UPDATE of a non-decision candidate column succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE of a non-decision candidate column denied';
  END;
  BEGIN
    UPDATE discovery_candidates SET hold_note = hold_note WHERE id = -1;
    RAISE EXCEPTION 'FAIL: UPDATE of hold_note succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE of hold_note (outside the decision columns) denied';
  END;
  BEGIN
    INSERT INTO discovery_candidates (batch_id, candidate_key, payload, name, source, source_record_id, normalized_name)
    VALUES (-1, 'verify:must-fail', '{}'::jsonb, 'verify', 'verify', 'must-fail', 'verify');
    RAISE EXCEPTION 'FAIL: INSERT into discovery_candidates succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: INSERT into discovery_candidates denied';
  END;
  BEGIN
    DELETE FROM discovery_candidates WHERE id = -1;
    RAISE EXCEPTION 'FAIL: DELETE on discovery_candidates succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: DELETE on discovery_candidates denied';
  END;
  BEGIN
    UPDATE discovery_candidate_pairs SET score = score WHERE id = -1;
    RAISE EXCEPTION 'FAIL: UPDATE of a non-decision pair column succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE of a non-decision pair column denied';
  END;
  BEGIN
    INSERT INTO discovery_candidate_pairs (batch_id, candidate_id) VALUES (-1, -1);
    RAISE EXCEPTION 'FAIL: INSERT into discovery_candidate_pairs succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: INSERT into discovery_candidate_pairs denied';
  END;
  BEGIN
    DELETE FROM discovery_candidate_pairs WHERE id = -1;
    RAISE EXCEPTION 'FAIL: DELETE on discovery_candidate_pairs succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: DELETE on discovery_candidate_pairs denied';
  END;
  BEGIN
    UPDATE discovery_batches SET status = status WHERE id = -1;
    RAISE EXCEPTION 'FAIL: UPDATE on discovery_batches succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE on discovery_batches denied';
  END;
  BEGIN
    INSERT INTO discovery_batches (slug, source, manifest, bundle_sha256, candidates_sha256, record_count)
    VALUES ('verify-must-fail', 'verify', '{}'::jsonb, repeat('0', 64), repeat('0', 64), 0);
    RAISE EXCEPTION 'FAIL: INSERT into discovery_batches succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: INSERT into discovery_batches denied';
  END;
  BEGIN
    UPDATE beers SET name = name WHERE id = -1;
    RAISE EXCEPTION 'FAIL: UPDATE on beers succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE on beers denied';
  END;
  BEGIN
    UPDATE breweries SET name = name WHERE id = -1;
    RAISE EXCEPTION 'FAIL: UPDATE on breweries succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE on breweries denied';
  END;
  BEGIN
    DELETE FROM discovery_decisions WHERE id = -1;
    RAISE EXCEPTION 'FAIL: DELETE on discovery_decisions succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: DELETE on discovery_decisions denied';
  END;
  BEGIN
    UPDATE discovery_decisions SET note = note WHERE id = -1;
    RAISE EXCEPTION 'FAIL: UPDATE on discovery_decisions succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE on discovery_decisions (append-only) denied';
  END;
  BEGIN
    UPDATE discovery_image_fetches SET outcome = outcome WHERE id = -1;
    RAISE EXCEPTION 'FAIL: UPDATE on discovery_image_fetches succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE on discovery_image_fetches (append-only) denied';
  END;
  BEGIN
    DELETE FROM discovery_image_fetches WHERE id = -1;
    RAISE EXCEPTION 'FAIL: DELETE on discovery_image_fetches succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: DELETE on discovery_image_fetches denied';
  END;
  BEGIN
    UPDATE discovery_image_decisions SET note = note WHERE id = -1;
    RAISE EXCEPTION 'FAIL: UPDATE on discovery_image_decisions succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE on discovery_image_decisions (append-only) denied';
  END;
  BEGIN
    DELETE FROM discovery_image_decisions WHERE id = -1;
    RAISE EXCEPTION 'FAIL: DELETE on discovery_image_decisions succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: DELETE on discovery_image_decisions denied';
  END;
  BEGIN
    UPDATE discovery_candidates SET image_url = image_url WHERE id = -1;
    RAISE EXCEPTION 'FAIL: UPDATE of image_url (outside the image-decision columns) succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE of image_url (outside the image-decision columns) denied';
  END;
  BEGIN
    UPDATE discovery_import_manifests SET sha256 = sha256 WHERE id = 'mf-no-such-manifest';
    RAISE EXCEPTION 'FAIL: UPDATE of manifest sha256 (immutable content) succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE of manifest sha256 (outside the approval columns) denied';
  END;
  BEGIN
    UPDATE discovery_import_manifests SET manifest = manifest WHERE id = 'mf-no-such-manifest';
    RAISE EXCEPTION 'FAIL: UPDATE of manifest content succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE of manifest content (immutable) denied';
  END;
  BEGIN
    UPDATE discovery_import_manifests SET imported_at = CURRENT_TIMESTAMP WHERE id = 'mf-no-such-manifest';
    RAISE EXCEPTION 'FAIL: UPDATE of imported_at succeeded (the reviewer must never mark a manifest imported)';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE of imported_at denied (marking imported is the operator executor only)';
  END;
  BEGIN
    UPDATE discovery_import_manifests SET record_count = record_count WHERE id = 'mf-no-such-manifest';
    RAISE EXCEPTION 'FAIL: UPDATE of manifest record_count succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE of manifest record_count (outside the approval columns) denied';
  END;
  BEGIN
    DELETE FROM discovery_import_manifests WHERE id = 'mf-no-such-manifest';
    RAISE EXCEPTION 'FAIL: DELETE on discovery_import_manifests succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: DELETE on discovery_import_manifests denied';
  END;
  BEGIN
    UPDATE discovery_manifest_events SET note = note WHERE id = -1;
    RAISE EXCEPTION 'FAIL: UPDATE on discovery_manifest_events succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE on discovery_manifest_events (append-only) denied';
  END;
  BEGIN
    DELETE FROM discovery_manifest_events WHERE id = -1;
    RAISE EXCEPTION 'FAIL: DELETE on discovery_manifest_events succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: DELETE on discovery_manifest_events denied';
  END;
  BEGIN
    PERFORM id FROM users LIMIT 1;
    RAISE EXCEPTION 'FAIL: SELECT on users succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: SELECT on users denied';
  END;
  BEGIN
    CREATE TABLE reviewer_escape_test (id int);
    RAISE EXCEPTION 'FAIL: CREATE TABLE succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: CREATE TABLE denied';
  END;
END
$$;

ROLLBACK;
