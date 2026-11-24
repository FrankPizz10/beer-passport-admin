-- Migration 005: catalog discovery hub import manifests (hub decision
-- 006 revisions 1 and 2, issues/001-catalog-discovery-hub.md sections
-- 2, 3, and 4). This is the manifest phase: immutable import
-- manifests, Frank's hash-bound approval of the exact (id, SHA-256)
-- pair, and the manifest lifecycle audit. Building or approving a
-- manifest writes NO catalog rows; the catalog write happens only in
-- the operator-run import executor (server/scripts/
-- import-discovery-manifest.ts), which re-verifies everything inside
-- its transaction and refuses to run against a manifest that is not
-- approved with a matching hash.
--
-- STATUS: REVIEW ONLY. Do not apply to any production database until
-- the CTO approves it as part of the discovery hub deployment (see
-- docs/DISCOVERY_HUB_RUNBOOK.md). Nothing in this file authorizes
-- applying it.
--
-- Additive only: TWO new tables (discovery_import_manifests,
-- discovery_manifest_events). No existing table, column, row, or
-- constraint is changed.
--
-- CANONICAL SCHEMA NOTE: as with migrations 002 to 004, this change
-- must be mirrored into beer-passport-server's canonical Prisma
-- schema before the migration is applied to production; the copy in
-- THIS repository (server/prisma/schema.prisma) is downstream of it.
--
-- discovery_import_manifests: one row per built manifest. Manifests
-- are IMMUTABLE once built: the API exposes no endpoint that changes
-- manifest or sha256, and any content change is a new manifest with
-- a new id (decision 006 revision 1).
--   id: the manifest id, format mf-<batch-slug>-<yyyymmdd>-<seq>
--     (for example mf-reassessment-us-20261123-01). The id is part of
--     the canonical content, so the SHA-256 binds the id as well.
--   manifest: the canonical content as JSONB (header, per-record
--     import payload snapshots with payload hashes and decision ids,
--     and the catalog baseline fingerprint). The hashed bytes are
--     the canonical serialization of this value (keys sorted at
--     every depth, no insignificant whitespace, one trailing LF);
--     the export endpoint reproduces exactly those bytes.
--   sha256: SHA-256 of the canonical bytes; UNIQUE.
--   catalog_fingerprint: the fingerprint object copied out of the
--     manifest header for query convenience (per catalog table: row
--     count + MD5 over content-bearing columns in id order; beers
--     uses last_mod, the catalog's actual timestamp column - see
--     server/src/discoveryManifestCore.ts). The copy inside the
--     manifest content is the hashed, authoritative one.
--   status: draft -> approved -> imported, or draft | approved ->
--     void. 'void' is final: a voided manifest can never be imported
--     (the executor checks the status inside its transaction).
--   built_by / built_by_uid: the building reviewer's users id and
--     Firebase UID, mirroring the decisions audit pattern; the UID
--     is recorded here ONLY and never serialized.
--   approved_by / approved_at / approved_sha256: Frank's approval,
--     written atomically by the approval endpoint in one transaction
--     (issues/001 section 4). approved_sha256 equals sha256 at
--     approval time and is never updated afterward.
--   imported_at: stamped by the operator import executor when (and
--     only when) its transaction commits.
--
-- discovery_manifest_events: the append-only lifecycle audit,
-- mirroring discovery_decisions and image_review_events. A separate
-- table (not discovery_decisions) because manifest events have no
-- candidate or pair target - discovery_decisions requires one by
-- CHECK constraint - and because the import event is written by the
-- operator identity, not the API. One row per lifecycle transition:
--   action: build / approve / void / import.
--   from_status / to_status: the manifest status transition (NULL
--     from_status for build).
--   note: the void reason, or the import report summary for import.
--   actor_id / actor_uid: the acting admin's users id and Firebase
--     UID for API actions (approve, void, build); NULL for the
--     operator-written import event (the executor has no Firebase
--     identity; its report names the operator identity instead).
--
-- Grants: the viewer's SELECT grants on the two new tables are
-- issued HERE (guarded, the migration 002 to 004 pattern). The
-- reviewer role's grants (INSERT and SELECT on both tables, UPDATE
-- on exactly the four approval columns of
-- discovery_import_manifests, sequence USAGE for the events table)
-- live in server/db/discovery-reviewer-role.sql, mirroring how the
-- earlier phases placed their grants. The reviewer role can never
-- set imported_at or change manifest content: marking a manifest
-- imported is the operator executor's act, under the operator
-- identity.
--
-- Apply as the migration/owner identity, in one transaction:
--
--   psql -d <database> -f server/db/migrations/005-discovery-manifests.sql
--
-- Down steps (rollback) live in docs/DISCOVERY_HUB_RUNBOOK.md.

BEGIN;

CREATE TABLE discovery_import_manifests (
  id VARCHAR(80) PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES discovery_batches(id),
  manifest JSONB NOT NULL,
  sha256 VARCHAR(64) NOT NULL UNIQUE,
  record_count INTEGER NOT NULL,
  catalog_fingerprint JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  built_by INTEGER NULL REFERENCES users(id),
  built_by_uid VARCHAR(255) NULL,
  approved_by INTEGER NULL REFERENCES users(id),
  approved_at TIMESTAMP(0) NULL,
  approved_sha256 VARCHAR(64) NULL,
  imported_at TIMESTAMP(0) NULL,
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX discovery_import_manifests_batch_id_idx
  ON discovery_import_manifests (batch_id);
CREATE INDEX discovery_import_manifests_status_idx
  ON discovery_import_manifests (status);

CREATE TABLE discovery_manifest_events (
  id SERIAL PRIMARY KEY,
  manifest_id VARCHAR(80) NOT NULL REFERENCES discovery_import_manifests(id),
  action VARCHAR(40) NOT NULL,
  from_status VARCHAR(20) NULL,
  to_status VARCHAR(20) NULL,
  note TEXT NULL,
  actor_id INTEGER NULL REFERENCES users(id),
  actor_uid VARCHAR(255) NULL,
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX discovery_manifest_events_manifest_id_idx
  ON discovery_manifest_events (manifest_id);
CREATE INDEX discovery_manifest_events_created_at_idx
  ON discovery_manifest_events (created_at);

-- Viewer SELECT grants (guarded; see the header note).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beerpassport_admin_viewer') THEN
    GRANT SELECT ON discovery_import_manifests, discovery_manifest_events
      TO beerpassport_admin_viewer;
    RAISE NOTICE 'granted SELECT on discovery manifest tables to beerpassport_admin_viewer';
  ELSE
    RAISE NOTICE 'beerpassport_admin_viewer does not exist yet; discovery manifest SELECT grants skipped (issue them after creating the role)';
  END IF;
END $$;

COMMIT;
