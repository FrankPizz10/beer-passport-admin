-- Migration 003: catalog discovery hub decision audit (hub decision
-- 006, issues/001-catalog-discovery-hub.md section 2 and 3). This is
-- the review write path phase (the issue's Phase 2): audited candidate
-- decisions, pair decisions, and the beerpassport_discovery_reviewer
-- role's audit table.
--
-- STATUS: REVIEW ONLY. Do not apply to any production database until
-- the CTO approves it as part of the discovery hub deployment (see
-- docs/DISCOVERY_HUB_RUNBOOK.md). Nothing in this file authorizes
-- applying it.
--
-- Additive only: ONE new table (discovery_decisions). No existing
-- table, column, row, or constraint is changed: the candidate and pair
-- decision columns the review endpoints write (review_status,
-- hold_reason, duplicate_of_candidate_id, updated_at on candidates;
-- status, decided_by, decided_at on pairs) already exist from
-- migration 002, which is why this migration needs no ALTER TABLE.
--
-- CANONICAL SCHEMA NOTE: as with migration 002, this change must be
-- mirrored into beer-passport-server's canonical Prisma schema before
-- the migration is applied to production; the copy in THIS repository
-- (server/prisma/schema.prisma) is downstream of it.
--
-- discovery_decisions is the append-only audit trail, mirroring
-- image_review_events in the image approval workflow. One row per
-- decision, written by the API in the SAME transaction as the status
-- change it records (the decision endpoints refuse to commit one
-- without the other):
--   candidate_id / pair_id: exactly one is set for candidate
--     decisions; pair decisions set pair_id AND candidate_id (the
--     pair's flagged candidate), so a candidate's decision history is
--     a single query.
--   decision: the audit action vocabulary from issues/001:
--     select / hold / reject / unhold for candidate decisions;
--     mark_duplicate / mark_distinct for pair decisions (the pair
--     endpoint's {same | distinct} payload maps onto these).
--   from_status / to_status: the review_status transition for
--     candidate decisions; the pair status transition (pending ->
--     same / distinct) for pair decisions.
--   reason: the hold-reason vocabulary value for hold and reject
--     decisions (issues/001: a hold or rejection without a reason is
--     refused by the API); NULL for select, unhold, and pair
--     decisions.
--   decided_by / decided_by_uid: the decider's users row id and the
--     Firebase UID from the verified token. The UID is recorded here
--     ONLY (audit durability if the users row is later removed) and
--     is never serialized by the API, mirroring reviewed_by_uid in
--     the image workflow.
--
-- Grants: the viewer's SELECT grant on discovery_decisions is issued
-- HERE (guarded, the same pattern as migration 002's grants) so the
-- grant travels with the schema change. The reviewer role's grants
-- live in server/db/discovery-reviewer-role.sql, mirroring how the
-- approver's grants live in approval-role.sql.
--
-- Apply as the migration/owner identity, in one transaction:
--
--   psql -d <database> -f server/db/migrations/003-discovery-decisions.sql
--
-- Down steps (rollback) live in docs/DISCOVERY_HUB_RUNBOOK.md.

BEGIN;

CREATE TABLE discovery_decisions (
  id SERIAL PRIMARY KEY,
  candidate_id INTEGER NULL REFERENCES discovery_candidates(id),
  pair_id INTEGER NULL REFERENCES discovery_candidate_pairs(id),
  decision VARCHAR(40) NOT NULL,
  from_status VARCHAR(20) NULL,
  to_status VARCHAR(20) NULL,
  reason VARCHAR(40) NULL,
  note TEXT NULL,
  decided_by INTEGER NULL REFERENCES users(id),
  decided_by_uid VARCHAR(255) NULL,
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT discovery_decisions_target_present
    CHECK (candidate_id IS NOT NULL OR pair_id IS NOT NULL)
);

CREATE INDEX discovery_decisions_candidate_id_idx
  ON discovery_decisions (candidate_id);
CREATE INDEX discovery_decisions_pair_id_idx
  ON discovery_decisions (pair_id);
CREATE INDEX discovery_decisions_created_at_idx
  ON discovery_decisions (created_at);

-- Viewer SELECT grant (guarded; see the header note).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beerpassport_admin_viewer') THEN
    GRANT SELECT ON discovery_decisions TO beerpassport_admin_viewer;
    RAISE NOTICE 'granted SELECT on discovery_decisions to beerpassport_admin_viewer';
  ELSE
    RAISE NOTICE 'beerpassport_admin_viewer does not exist yet; discovery_decisions SELECT grant skipped (issue it after creating the role)';
  END IF;
END $$;

COMMIT;
