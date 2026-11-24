-- Migration 002: catalog discovery hub staging (hub decision 006,
-- issues/001-catalog-discovery-hub.md, selection policy decision 005).
--
-- STATUS: REVIEW ONLY. Do not apply to any production database until the
-- CTO approves it as part of the discovery hub deployment (see
-- docs/DISCOVERY_HUB_RUNBOOK.md). Nothing in this file authorizes
-- applying it.
--
-- Additive only: three new tables (discovery_batches,
-- discovery_candidates, discovery_candidate_pairs), their indexes, and
-- SELECT grants for the viewer role. No existing table, column, row, or
-- constraint is changed. The staging tables are fully separate from the
-- catalog tables (beers, breweries, beverage_images): staged candidates
-- can never leak into the catalog through this schema, and the only
-- catalog reference is the nullable matched_beer_id recorded by the
-- ingest collision check.
--
-- CANONICAL SCHEMA NOTE: the system of record for this schema is the
-- beer-passport-server repository. This change must be mirrored there
-- before the migration is applied to production (decision 006,
-- deployment sequence step 1); the copy in THIS repository
-- (server/prisma/schema.prisma) is downstream of it, and
-- scripts/check-schema-drift.sh will report drift until the server
-- change lands and the copy is refreshed.
--
-- Column notes:
--   discovery_batches.bundle_sha256 is the SHA-256 of the bundle's
--     candidates.jsonl bytes and is the ingest idempotency key:
--     re-ingesting the same bundle hash is a no-op, and a known slug
--     with a different hash is refused (see
--     server/scripts/ingest-discovery-bundle.ts). manifest stores the
--     bundle manifest.json verbatim.
--   discovery_candidates.payload stores the staged record verbatim
--     (provenance included); the remaining columns are the mapped,
--     queryable fields. Image statuses are preserved exactly as staged
--     (image_status verbatim, image_status_normalized one of verified /
--     gate_passed_unverified / failed / none) and are NEVER promoted by
--     ingest or by the API.
--   review_status starts at 'pending' for every staged candidate in
--     this read-only phase; decision states arrive with the review
--     write path in a later phase. hold_reason uses the controlled
--     vocabulary from issues/001: missing_brewery, origin_uncertain,
--     market_fit_uncertain, duplicate_unresolved, image_unverified,
--     metadata_incomplete, out_of_scope, other.
--   dedupe_outcome records the ingest-time live-catalog collision
--     check: 'no_match', 'collision' (matched_beer_id set), or
--     'ambiguous' (the record is one side of a staged pair).
--   discovery_candidate_pairs.candidate_id_b is nullable: the rival may
--     live in another batch (then external_ref carries its
--     source:source_record_id) and is resolved to a candidate row when
--     that batch has been ingested.
--
-- Grants: the viewer role's SELECT grants on the three discovery
-- tables are issued HERE (not in db/readonly-role.sql) so the grant
-- travels with the schema change; a fresh bootstrap that runs
-- readonly-role.sql first and then this migration ends with the same
-- grants. The grant block is guarded so the migration also applies
-- cleanly to a database where the viewer role has not been created
-- yet (the grants are then skipped and must be issued after the role
-- exists; docs/DISCOVERY_HUB_RUNBOOK.md covers the order).
--
-- Apply as the migration/owner identity, in one transaction:
--
--   psql -d <database> -f server/db/migrations/002-discovery-staging.sql
--
-- Down steps (rollback) live in docs/DISCOVERY_HUB_RUNBOOK.md.

BEGIN;

CREATE TABLE discovery_batches (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(120) NOT NULL UNIQUE,
  title VARCHAR(255) NULL,
  source VARCHAR(120) NOT NULL,
  source_summary TEXT NULL,
  manifest JSONB NOT NULL,
  bundle_sha256 VARCHAR(64) NOT NULL UNIQUE,
  candidates_sha256 VARCHAR(64) NOT NULL,
  record_count INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'staged',
  ingested_by VARCHAR(120) NULL,
  ingested_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE discovery_candidates (
  id SERIAL PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES discovery_batches(id),
  candidate_key VARCHAR(320) NOT NULL,
  payload JSONB NOT NULL,
  name VARCHAR(600) NOT NULL,
  brewery_name VARCHAR(600) NULL,
  style VARCHAR(255) NULL,
  abv DOUBLE PRECISION NULL,
  ibu DOUBLE PRECISION NULL,
  description TEXT NULL,
  barcode VARCHAR(64) NULL,
  source VARCHAR(120) NOT NULL,
  source_record_id VARCHAR(320) NOT NULL,
  source_url TEXT NULL,
  retrieved_at TIMESTAMP(0) NULL,
  tier VARCHAR(20) NULL,
  origin_bucket VARCHAR(30) NULL,
  origin_evidence JSONB NULL,
  image_url TEXT NULL,
  image_source VARCHAR(120) NULL,
  image_tier VARCHAR(20) NULL,
  image_status VARCHAR(80) NULL,
  image_status_normalized VARCHAR(30) NULL,
  image_verified BOOLEAN NULL,
  image_flag_reason TEXT NULL,
  image_license VARCHAR(255) NULL,
  image_page_url TEXT NULL,
  image_width INTEGER NULL,
  image_height INTEGER NULL,
  review_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  hold_reason VARCHAR(40) NULL,
  hold_note TEXT NULL,
  dedupe_outcome VARCHAR(30) NOT NULL DEFAULT 'not_checked',
  matched_beer_id INTEGER NULL REFERENCES beers(id),
  duplicate_of_candidate_id INTEGER NULL REFERENCES discovery_candidates(id),
  normalized_name VARCHAR(600) NOT NULL,
  normalized_brewery VARCHAR(600) NULL,
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (batch_id, candidate_key)
);

CREATE INDEX discovery_candidates_batch_id_idx
  ON discovery_candidates (batch_id);
CREATE INDEX discovery_candidates_origin_bucket_idx
  ON discovery_candidates (origin_bucket);
CREATE INDEX discovery_candidates_hold_reason_idx
  ON discovery_candidates (hold_reason);
CREATE INDEX discovery_candidates_review_status_idx
  ON discovery_candidates (review_status);
CREATE INDEX discovery_candidates_barcode_idx
  ON discovery_candidates (barcode);
CREATE INDEX discovery_candidates_normalized_name_idx
  ON discovery_candidates (normalized_name);
CREATE INDEX discovery_candidates_image_status_normalized_idx
  ON discovery_candidates (image_status_normalized);
CREATE INDEX discovery_candidates_source_idx
  ON discovery_candidates (source);

CREATE TABLE discovery_candidate_pairs (
  id SERIAL PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES discovery_batches(id),
  candidate_id INTEGER NOT NULL REFERENCES discovery_candidates(id),
  candidate_id_b INTEGER NULL REFERENCES discovery_candidates(id),
  external_ref VARCHAR(320) NULL,
  comparison VARCHAR(120) NULL,
  method VARCHAR(40) NULL,
  score DOUBLE PRECISION NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  decided_by INTEGER NULL REFERENCES users(id),
  decided_at TIMESTAMP(0) NULL,
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX discovery_candidate_pairs_batch_id_idx
  ON discovery_candidate_pairs (batch_id);
CREATE INDEX discovery_candidate_pairs_candidate_id_idx
  ON discovery_candidate_pairs (candidate_id);
CREATE INDEX discovery_candidate_pairs_status_idx
  ON discovery_candidate_pairs (status);

-- Viewer SELECT grants (guarded; see the header note).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beerpassport_admin_viewer') THEN
    GRANT SELECT ON discovery_batches, discovery_candidates, discovery_candidate_pairs
      TO beerpassport_admin_viewer;
    RAISE NOTICE 'granted SELECT on discovery tables to beerpassport_admin_viewer';
  ELSE
    RAISE NOTICE 'beerpassport_admin_viewer does not exist yet; discovery SELECT grants skipped (issue them after creating the role)';
  END IF;
END $$;

COMMIT;
