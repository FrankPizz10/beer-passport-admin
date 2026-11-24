-- Verification for the discovery staging grants (migration 002).
--
-- Run CONNECTED AS the viewer role, AFTER migration 002 has been
-- applied and its grant block has run (the role must exist before the
-- migration for the grants to be issued; see the migration header):
--
--   PGPASSWORD='<redacted>' psql -h <host> -U beerpassport_admin_viewer \
--        -d <database> -f server/db/verify-discovery.sql
--
-- Expected: every check prints PASS and the script exits 0. Any
-- unexpected success raises an exception and psql exits non-zero.
-- Everything runs in one transaction that is rolled back, so even a
-- (failing) successful write leaves no trace.
--
-- This script is deliberately separate from verify-readonly-role.sql:
-- that script's 13-check expectation set covers the catalog grants and
-- is unchanged by the discovery work; the discovery grants ship inside
-- migration 002 and are verified here.
\set ON_ERROR_STOP on
BEGIN;

-- Reads that must work.
SELECT count(*) AS discovery_batches_readable FROM discovery_batches;
SELECT count(*) AS discovery_candidates_readable FROM discovery_candidates;
SELECT count(*) AS discovery_candidate_pairs_readable FROM discovery_candidate_pairs;
DO $$ BEGIN RAISE NOTICE 'PASS: discovery reads succeed'; END $$;

-- Writes that must fail, one per table and verb.
DO $$
BEGIN
  INSERT INTO discovery_batches (slug, source, manifest, bundle_sha256, candidates_sha256, record_count)
  VALUES ('verify-must-fail', 'verify', '{}'::jsonb, repeat('0', 64), repeat('0', 64), 0);
  RAISE EXCEPTION 'FAIL: INSERT into discovery_batches succeeded';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: INSERT into discovery_batches denied';
END $$;

DO $$
BEGIN
  UPDATE discovery_batches SET status = status WHERE id = -1;
  RAISE EXCEPTION 'FAIL: UPDATE on discovery_batches succeeded';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: UPDATE on discovery_batches denied';
END $$;

DO $$
BEGIN
  INSERT INTO discovery_candidates (batch_id, candidate_key, payload, name, source, source_record_id, normalized_name)
  VALUES (-1, 'verify:must-fail', '{}'::jsonb, 'verify', 'verify', 'must-fail', 'verify');
  RAISE EXCEPTION 'FAIL: INSERT into discovery_candidates succeeded';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: INSERT into discovery_candidates denied';
END $$;

DO $$
BEGIN
  UPDATE discovery_candidates SET review_status = review_status WHERE id = -1;
  RAISE EXCEPTION 'FAIL: UPDATE on discovery_candidates succeeded';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: UPDATE on discovery_candidates denied';
END $$;

DO $$
BEGIN
  INSERT INTO discovery_candidate_pairs (batch_id, candidate_id)
  VALUES (-1, -1);
  RAISE EXCEPTION 'FAIL: INSERT into discovery_candidate_pairs succeeded';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: INSERT into discovery_candidate_pairs denied';
END $$;

DO $$
BEGIN
  UPDATE discovery_candidate_pairs SET status = status WHERE id = -1;
  RAISE EXCEPTION 'FAIL: UPDATE on discovery_candidate_pairs succeeded';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: UPDATE on discovery_candidate_pairs denied';
END $$;

DO $$
BEGIN
  DELETE FROM discovery_batches WHERE id = -1;
  RAISE EXCEPTION 'FAIL: DELETE on discovery_batches succeeded';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: DELETE on discovery_batches denied';
END $$;

-- Image review tables (migration 004): the viewer reads both (the
-- fetch history, previews' metadata, and the decision history are
-- browsing surfaces) and writes neither.
SELECT count(*) AS discovery_image_fetches_readable FROM discovery_image_fetches;
SELECT count(*) AS discovery_image_decisions_readable FROM discovery_image_decisions;
DO $$ BEGIN RAISE NOTICE 'PASS: discovery image reads succeed'; END $$;

DO $$
BEGIN
  INSERT INTO discovery_image_fetches (candidate_id, image_ref, outcome)
  VALUES (-1, 'https://example.invalid/x.png', 'success');
  RAISE EXCEPTION 'FAIL: INSERT into discovery_image_fetches succeeded';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: INSERT into discovery_image_fetches denied';
END $$;

DO $$
BEGIN
  UPDATE discovery_image_fetches SET outcome = outcome WHERE id = -1;
  RAISE EXCEPTION 'FAIL: UPDATE on discovery_image_fetches succeeded';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: UPDATE on discovery_image_fetches denied';
END $$;

DO $$
BEGIN
  DELETE FROM discovery_image_fetches WHERE id = -1;
  RAISE EXCEPTION 'FAIL: DELETE on discovery_image_fetches succeeded';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: DELETE on discovery_image_fetches denied';
END $$;

DO $$
BEGIN
  INSERT INTO discovery_image_decisions (candidate_id, fetch_id, image_ref, image_sha256, decision)
  VALUES (-1, -1, 'https://example.invalid/x.png', repeat('0', 64), 'approved');
  RAISE EXCEPTION 'FAIL: INSERT into discovery_image_decisions succeeded';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: INSERT into discovery_image_decisions denied';
END $$;

DO $$
BEGIN
  UPDATE discovery_image_decisions SET note = note WHERE id = -1;
  RAISE EXCEPTION 'FAIL: UPDATE on discovery_image_decisions succeeded';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: UPDATE on discovery_image_decisions denied';
END $$;

DO $$
BEGIN
  DELETE FROM discovery_image_decisions WHERE id = -1;
  RAISE EXCEPTION 'FAIL: DELETE on discovery_image_decisions succeeded';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: DELETE on discovery_image_decisions denied';
END $$;

DO $$
BEGIN
  UPDATE discovery_candidates SET image_decision = 'approved' WHERE id = -1;
  RAISE EXCEPTION 'FAIL: UPDATE of image_decision on discovery_candidates succeeded';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: UPDATE of image_decision on discovery_candidates denied';
END $$;

ROLLBACK;
