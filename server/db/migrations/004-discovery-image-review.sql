-- Migration 004: catalog discovery hub image review (hub decision
-- 006 revision 2, issues/001-catalog-discovery-hub.md sections 2, 3,
-- and 4). This is the image review phase: server-side fetch of staged
-- candidate images under the documented SSRF restrictions, previews
-- served from the exact fetched bytes, and image decisions bound to
-- those bytes by SHA-256.
--
-- STATUS: REVIEW ONLY. Do not apply to any production database until
-- the CTO approves it as part of the discovery hub deployment (see
-- docs/DISCOVERY_HUB_RUNBOOK.md). Nothing in this file authorizes
-- applying it.
--
-- Additive only: TWO new tables (discovery_image_fetches,
-- discovery_image_decisions) and THREE new nullable columns on
-- discovery_candidates (the current image decision state). No
-- existing column, row, or constraint is changed.
--
-- CANONICAL SCHEMA NOTE: as with migrations 002 and 003, this change
-- must be mirrored into beer-passport-server's canonical Prisma
-- schema before the migration is applied to production; the copy in
-- THIS repository (server/prisma/schema.prisma) is downstream of it.
--
-- discovery_image_fetches is the audit log of EVERY fetch attempt
-- (decision 006 revision 2: every fetch is audit-logged and
-- rate-limited per reviewer). One row per attempt:
--   image_ref: the direct image locator exactly as staged on the
--     candidate (candidate.image_url at fetch time).
--   outcome: 'success', or the specific failure class the restricted
--     fetcher reports: dns_blocked, redirect_blocked,
--     downgrade_blocked, too_large, not_image, magic_mismatch,
--     unreachable, timeout. outcome_detail carries the human-readable
--     reason (for example the blocked address class or the HTTP
--     status). sha256 / content_type / byte_size / width / height
--     are set only on success: content_type is the VERIFIED type
--     (from the magic bytes, not the origin's claim), and sha256 is
--     the hash of the exact bytes stored in the content-addressed
--     store and later served as the preview.
--   fetched_by / fetched_by_uid: the fetching reviewer's users row
--     id and Firebase UID, mirroring the decisions audit pattern.
--     The UID is recorded here ONLY and is never serialized.
--   (issues/001 sketched a coarser outcome vocabulary - ok /
--   not_image / unreachable / refused; the failure classes above are
--   the revision-2 refinement of 'refused' and are what the API and
--   the client surface.)
--
-- discovery_image_decisions is the append-only audit trail for image
-- decisions, mirroring discovery_decisions. One row per decision:
--   fetch_id: the exact fetch whose bytes were previewed. UNIQUE:
--     a fetch can be decided exactly once (the API refuses a second
--     decision with 409; the constraint is the concurrency guard).
--   image_ref / image_sha256 / image_content_type / image_width /
--     image_height: the binding snapshot copied from the fetch row
--     at decision time; the API re-hashes the stored bytes before
--     writing and refuses (409) when they no longer match
--     image_sha256, so a decision can never bind to bytes the
--     reviewer did not see.
--   image_source / image_license: the provenance snapshot copied
--     from the candidate at decision time (issues/001 section 4).
--     Attribution lives in the candidate payload, preserved verbatim.
--   decision: the issues/001 vocabulary: approved / rejected.
--   decided_by / decided_by_uid: users id (serialized) and Firebase
--     UID (audit only, never serialized).
--
-- discovery_candidates gains the CURRENT image decision state so the
-- hub can surface it without a lateral join: image_decision
-- (approved / rejected / NULL when undecided), image_decision_fetch_id
-- (the fetch the current decision binds to), image_decision_at. The
-- audit table remains the history; these columns are its projection,
-- written in the same transaction as the audit insert. This is why
-- migration 004 needs ALTER TABLE where 003 did not: migrations 002
-- and 003 carried no image-decision state at all.
--
-- Grants: the viewer's SELECT grants on the two new tables are
-- issued HERE (guarded, the migration 002/003 pattern). The reviewer
-- role's new grants (INSERT/SELECT on both tables, UPDATE on the
-- three candidate columns, sequence USAGE) live in
-- server/db/discovery-reviewer-role.sql, mirroring how the Phase 3
-- grants were placed.
--
-- Apply as the migration/owner identity, in one transaction:
--
--   psql -d <database> -f server/db/migrations/004-discovery-image-review.sql
--
-- Down steps (rollback) live in docs/DISCOVERY_HUB_RUNBOOK.md.

BEGIN;

CREATE TABLE discovery_image_fetches (
  id SERIAL PRIMARY KEY,
  candidate_id INTEGER NOT NULL REFERENCES discovery_candidates(id),
  image_ref TEXT NOT NULL,
  sha256 VARCHAR(64) NULL,
  content_type VARCHAR(120) NULL,
  byte_size INTEGER NULL,
  width INTEGER NULL,
  height INTEGER NULL,
  outcome VARCHAR(30) NOT NULL,
  outcome_detail TEXT NULL,
  fetched_by INTEGER NULL REFERENCES users(id),
  fetched_by_uid VARCHAR(255) NULL,
  fetched_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX discovery_image_fetches_candidate_id_idx
  ON discovery_image_fetches (candidate_id);
CREATE INDEX discovery_image_fetches_fetched_by_idx
  ON discovery_image_fetches (fetched_by, fetched_at);

CREATE TABLE discovery_image_decisions (
  id SERIAL PRIMARY KEY,
  candidate_id INTEGER NOT NULL REFERENCES discovery_candidates(id),
  fetch_id INTEGER NOT NULL UNIQUE REFERENCES discovery_image_fetches(id),
  image_ref TEXT NOT NULL,
  image_sha256 VARCHAR(64) NOT NULL,
  image_content_type VARCHAR(120) NULL,
  image_width INTEGER NULL,
  image_height INTEGER NULL,
  image_source VARCHAR(120) NULL,
  image_license VARCHAR(255) NULL,
  decision VARCHAR(20) NOT NULL,
  note TEXT NULL,
  decided_by INTEGER NULL REFERENCES users(id),
  decided_by_uid VARCHAR(255) NULL,
  decided_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX discovery_image_decisions_candidate_id_idx
  ON discovery_image_decisions (candidate_id);
CREATE INDEX discovery_image_decisions_decided_at_idx
  ON discovery_image_decisions (decided_at);

ALTER TABLE discovery_candidates
  ADD COLUMN image_decision VARCHAR(20) NULL,
  ADD COLUMN image_decision_fetch_id INTEGER NULL
    REFERENCES discovery_image_fetches(id),
  ADD COLUMN image_decision_at TIMESTAMP(0) NULL;

-- Viewer SELECT grants (guarded; see the header note).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beerpassport_admin_viewer') THEN
    GRANT SELECT ON discovery_image_fetches, discovery_image_decisions
      TO beerpassport_admin_viewer;
    RAISE NOTICE 'granted SELECT on discovery image tables to beerpassport_admin_viewer';
  ELSE
    RAISE NOTICE 'beerpassport_admin_viewer does not exist yet; discovery image SELECT grants skipped (issue them after creating the role)';
  END IF;
END $$;

COMMIT;
