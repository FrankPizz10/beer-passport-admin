-- Migration 001: image approval workflow support for beverage_images.
--
-- STATUS: REVIEW ONLY. Do not apply to any production database until the
-- CTO approves it as part of the image approval workflow deployment (see
-- docs/DEPLOYMENT_RUNBOOK.md, "Image approval workflow"). Nothing in this
-- file authorizes applying it.
--
-- Additive only: new nullable columns on beverage_images, one new table
-- (image_review_events), one new index. No existing column, row, or
-- constraint is changed. beverage_images is empty in production today,
-- so applying this migration touches no image data.
--
-- CANONICAL SCHEMA NOTE: the system of record for this schema is the
-- beer-passport-server repository (prisma/schema.prisma and its migration
-- history). This change must be mirrored there as a server migration;
-- the copy in THIS repository (server/prisma/schema.prisma) is downstream
-- of it, and scripts/check-schema-drift.sh will report drift against the
-- pilot schema until the server change lands and the copy is refreshed.
--
-- What the new columns and table are for:
--   reviewed_by / reviewed_by_uid / reviewed_at: who decided the row's
--     status (approve or reject) and when. reviewed_by is the decider's
--     row in users; reviewed_by_uid is the Firebase UID from the verified
--     token, kept so the audit trail survives even if the users row is
--     later removed.
--   source_content_type / source_checked_at / source_check_status: the
--     candidate loader's verification that a hosted candidate's
--     storage_key (an http(s) URL) really serves an image, so a source
--     WEB PAGE is never mistaken for a direct image URL:
--       'image'       final Content-Type started with image/
--       'not_image'   the URL answered but not with an image type
--       'unreachable' network error or HTTP failure
--       'unchecked'   not checked (private storage-key candidates)
--     Approval of a row whose source_check_status is 'not_image' or
--     'unreachable' is refused by the API (422).
--   image_review_events: append-only audit trail, one row per decision,
--     written in the same transaction as the status change by the
--     beerpassport_admin_approver role (see server/db/approval-role.sql).
--
-- Apply as the migration/owner identity, in one transaction:
--
--   psql -d <database> -f server/db/migrations/001-image-approval.sql
--
-- Down steps (rollback) live in docs/DEPLOYMENT_RUNBOOK.md.

BEGIN;

ALTER TABLE beverage_images
  ADD COLUMN reviewed_by INTEGER NULL REFERENCES users(id),
  ADD COLUMN reviewed_by_uid VARCHAR(128) NULL,
  ADD COLUMN reviewed_at TIMESTAMP(0) NULL,
  ADD COLUMN source_content_type VARCHAR(100) NULL,
  ADD COLUMN source_checked_at TIMESTAMP(0) NULL,
  ADD COLUMN source_check_status VARCHAR(20) NULL;

CREATE TABLE image_review_events (
  id SERIAL PRIMARY KEY,
  beverage_image_id INTEGER NOT NULL REFERENCES beverage_images(id),
  beverage_id INTEGER NOT NULL,
  action VARCHAR(10) NOT NULL,
  from_status VARCHAR(20) NOT NULL,
  to_status VARCHAR(20) NOT NULL,
  admin_user_id INTEGER NULL REFERENCES users(id),
  admin_uid VARCHAR(128) NULL,
  note TEXT NULL,
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX image_review_events_beverage_image_id_idx
  ON image_review_events (beverage_image_id);

COMMIT;
