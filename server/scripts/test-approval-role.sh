#!/usr/bin/env bash
# test-approval-role.sh - disposable-PostgreSQL verification of the two
# admin database roles (beerpassport_admin_viewer and
# beerpassport_admin_approver) and of migration 001.
#
# What it does, all against a THROWAWAY PostgreSQL instance in a scratch
# directory (socket-only, non-default port, deleted on exit):
#   1. Generates the base schema DDL from server/prisma/schema.prisma
#      with `prisma migrate diff --from-empty` (the Prisma engine env
#      vars below point at the locally cached engines; in a normal
#      checkout with network access they are unnecessary).
#   2. Rolls the generated schema back to the pre-migration-001 shape
#      (the Prisma schema already includes migration 001, so its table
#      and six columns are dropped), then applies
#      server/db/migrations/001-image-approval.sql for real.
#   3. Seeds one user, one beer, and one pending beverage_images row.
#   4. Applies server/db/readonly-role.sql and
#      server/db/approval-role.sql as superuser, with test-only
#      passwords that never leave this script's throwaway instance.
#   5. Runs server/db/verify-readonly-role.sql AS the viewer (expects
#      exit 0 and all 13 PASS notices) and
#      server/db/verify-approval-role.sql AS the approver (exit 0).
#   6. Runs explicit psql probes AS the approver: a decision-column
#      UPDATE and an audit INSERT must succeed; a non-granted column
#      UPDATE, INSERT/UPDATE/DELETE on beers, and a SELECT of
#      users.notification_token must each fail.
#
# Authentication on the throwaway instance is `trust` on the local
# socket: this script tests AUTHORIZATION (grants), not passwords, and
# the instance listens on no network interface and is deleted on exit.
#
# PostgreSQL refuses to run as root, so when this script runs as root
# the server processes are started via setpriv as a non-root uid with
# a passwd entry (1000 where it exists, otherwise 65534/nobody; this
# VM has no uid-1000 passwd entry, so initdb cannot run as 1000 here),
# from a scratch copy of the install owned by that uid, because the
# server uid cannot traverse the tree the binaries were found in and
# the pgserver-packaged binaries need their bundled libs on
# LD_LIBRARY_PATH.
#
# Overrides: PG_BIN_DIR (directory holding initdb/pg_ctl/psql),
# BP_PG_PORT (default 55439).
set -uo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${BP_PG_PORT:-55439}"
DB="bp_role_test"
VIEWER_PASSWORD="viewer-test-only"
APPROVER_PASSWORD="approver-test-only"
FAILURES=0

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }

# --- Locate PostgreSQL binaries -------------------------------------------
PG_BIN=""
if command -v initdb >/dev/null 2>&1; then
  PG_BIN="$(dirname "$(command -v initdb)")"
elif [ -n "${PG_BIN_DIR:-}" ] && [ -x "${PG_BIN_DIR}/initdb" ]; then
  PG_BIN="$PG_BIN_DIR"
elif [ -x "$HOME/workspace/workstreams/db-recovery/pginstall/bin/initdb" ]; then
  PG_BIN="$HOME/workspace/workstreams/db-recovery/pginstall/bin"
fi
if [ -z "$PG_BIN" ]; then
  echo "FAIL: initdb not found (set PG_BIN_DIR)" >&2
  exit 1
fi
echo "Using PostgreSQL binaries from: $PG_BIN"

# --- Scratch instance ------------------------------------------------------
SCRATCH="$(mktemp -d /tmp/bp-role-test.XXXXXX)"
if [ "$(id -u)" = "0" ]; then
  # Run the server as a non-root uid that has a passwd entry (initdb
  # looks the effective uid up). Prefer 1000 (the workspace owner in
  # this environment); fall back to 65534 (nobody) where 1000 has no
  # entry. Override with BP_PG_RUN_UID / BP_PG_RUN_GID.
  RUN_UID="${BP_PG_RUN_UID:-1000}"
  getent passwd "$RUN_UID" >/dev/null 2>&1 || RUN_UID=65534
  RUN_GID="${BP_PG_RUN_GID:-$(getent passwd "$RUN_UID" | cut -d: -f4)}"
  chown "$RUN_UID:$RUN_GID" "$SCRATCH"
  # The server uid cannot traverse the tree the binaries were found in
  # (and the pgserver-packaged binaries need their bundled libs on
  # LD_LIBRARY_PATH), so the server runs from a scratch copy of the
  # whole install (bin + lib + share).
  cp -a "$(dirname "$PG_BIN")" "$SCRATCH/pginstall"
  chown -R "$RUN_UID:$RUN_GID" "$SCRATCH/pginstall"
  PG_BIN="$SCRATCH/pginstall/bin"
  RUN_AS=(setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups env \
    "HOME=$SCRATCH" LC_ALL=C "LD_LIBRARY_PATH=$SCRATCH/pginstall/lib")
  echo "Server processes run as uid $RUN_UID from a scratch copy of the install"
else
  RUN_AS=(env "HOME=$SCRATCH" LC_ALL=C)
fi
# The psql client invoked by this script needs the same bundled libs.
if [ -d "$(dirname "$PG_BIN")/lib" ]; then
  export LD_LIBRARY_PATH="$(dirname "$PG_BIN")/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

cleanup() {
  "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$SCRATCH/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

"${RUN_AS[@]}" "$PG_BIN/initdb" -D "$SCRATCH/data" -U postgres --auth=trust -E UTF8 >/dev/null 2>&1 \
  || { echo "FAIL: initdb failed" >&2; exit 1; }
"${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$SCRATCH/data" -l "$SCRATCH/pg.log" \
  -o "-k $SCRATCH -p $PORT -c listen_addresses=''" -w -t 60 start >/dev/null 2>&1 \
  || { echo "FAIL: postgres did not start; log follows" >&2; cat "$SCRATCH/pg.log" >&2; exit 1; }
pass "throwaway PostgreSQL instance is up (socket $SCRATCH, port $PORT)"

PSQL_SUPER=("$PG_BIN/psql" -h "$SCRATCH" -p "$PORT" -U postgres -v ON_ERROR_STOP=1)
"${PSQL_SUPER[@]}" -d postgres -c "CREATE DATABASE $DB" >/dev/null 2>&1 \
  || { echo "FAIL: could not create the test database" >&2; exit 1; }
PSQL_SUPER_DB=("$PG_BIN/psql" -h "$SCRATCH" -p "$PORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1)

# --- Base schema from the Prisma datamodel ---------------------------------
# The sandbox cannot download Prisma engines; point at the cached ones
# when they exist (harmless elsewhere: real paths win only if present).
if [ -f "$HOME/workspace/engines/migration-engine" ]; then
  export PRISMA_MIGRATION_ENGINE_BINARY="${PRISMA_MIGRATION_ENGINE_BINARY:-$HOME/workspace/engines/migration-engine}"
fi
if [ -f "$HOME/workspace/workstreams/pilot-impl/repo/node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node" ]; then
  export PRISMA_QUERY_ENGINE_LIBRARY="${PRISMA_QUERY_ENGINE_LIBRARY:-$HOME/workspace/workstreams/pilot-impl/repo/node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node}"
fi
if (cd "$SERVER_DIR" && npx prisma migrate diff --from-empty \
      --to-schema-datamodel prisma/schema.prisma --script) > "$SCRATCH/base.sql" 2>"$SCRATCH/prisma.log"; then
  pass "base schema DDL generated with prisma migrate diff"
else
  echo "FAIL: prisma migrate diff failed; log follows" >&2
  cat "$SCRATCH/prisma.log" >&2
  exit 1
fi
"${PSQL_SUPER_DB[@]}" -f "$SCRATCH/base.sql" >/dev/null 2>&1 \
  || { echo "FAIL: base schema DDL did not apply" >&2; exit 1; }

# The Prisma schema already reflects migration 001; drop its additions
# so the migration below applies to the true pre-001 shape.
"${PSQL_SUPER_DB[@]}" >/dev/null 2>&1 <<'SQL' \
  || { echo "FAIL: pre-migration rollback of the generated schema failed" >&2; exit 1; }
DROP TABLE IF EXISTS image_review_events;
ALTER TABLE beverage_images
  DROP COLUMN IF EXISTS reviewed_by,
  DROP COLUMN IF EXISTS reviewed_by_uid,
  DROP COLUMN IF EXISTS reviewed_at,
  DROP COLUMN IF EXISTS source_content_type,
  DROP COLUMN IF EXISTS source_checked_at,
  DROP COLUMN IF EXISTS source_check_status;
SQL
pass "schema rolled back to the pre-migration-001 shape"

if "${PSQL_SUPER_DB[@]}" -f "$SERVER_DIR/db/migrations/001-image-approval.sql" >/dev/null 2>&1; then
  pass "migration 001 applies cleanly"
else
  fail "migration 001 did not apply"
fi

# --- Seed ------------------------------------------------------------------
USER_ID="$("${PSQL_SUPER_DB[@]}" -qAt -c "INSERT INTO users (uid, age, email, user_name) VALUES ('seed-uid', 30, 'seed@example.com', 'seed') RETURNING id")"
BEER_ID="$("${PSQL_SUPER_DB[@]}" -qAt -c "INSERT INTO beers (name) VALUES ('Seed Beer') RETURNING id")"
IMG_ID="$("${PSQL_SUPER_DB[@]}" -qAt -c "INSERT INTO beverage_images (beverage_id, storage_key, status) VALUES ($BEER_ID, 'https://example.com/seed.jpg', 'pending') RETURNING id")"
if [ -n "$USER_ID" ] && [ -n "$BEER_ID" ] && [ -n "$IMG_ID" ]; then
  pass "seeded user $USER_ID, beer $BEER_ID, pending image $IMG_ID"
else
  echo "FAIL: seeding failed" >&2
  exit 1
fi

# --- Role setup -------------------------------------------------------------
if "${PSQL_SUPER_DB[@]}" -v viewer_password="$VIEWER_PASSWORD" \
     -f "$SERVER_DIR/db/readonly-role.sql" >/dev/null 2>&1; then
  pass "readonly-role.sql applied (viewer role created)"
else
  fail "readonly-role.sql did not apply"
fi
if "${PSQL_SUPER_DB[@]}" -v approver_password="$APPROVER_PASSWORD" \
     -f "$SERVER_DIR/db/approval-role.sql" >/dev/null 2>&1; then
  pass "approval-role.sql applied (approver role created)"
else
  fail "approval-role.sql did not apply"
fi

# --- Verify scripts, run AS each role ---------------------------------------
run_verify() {
  local role="$1" password="$2" file="$3" min_pass="$4" label="$5"
  local out rc count
  out="$(PGPASSWORD="$password" "$PG_BIN/psql" -h "$SCRATCH" -p "$PORT" \
        -U "$role" -d "$DB" -v ON_ERROR_STOP=1 -f "$file" 2>&1)"
  rc=$?
  count="$(printf '%s' "$out" | grep -c 'PASS:' || true)"
  if [ "$rc" -eq 0 ] && [ "$count" -ge "$min_pass" ]; then
    pass "$label: exit 0, $count PASS notices"
  else
    fail "$label: exit $rc, $count PASS notices (expected >= $min_pass)"
    printf '%s\n' "$out" | tail -20 >&2
  fi
}
run_verify beerpassport_admin_viewer "$VIEWER_PASSWORD" \
  "$SERVER_DIR/db/verify-readonly-role.sql" 13 "verify-readonly-role.sql as viewer"
run_verify beerpassport_admin_approver "$APPROVER_PASSWORD" \
  "$SERVER_DIR/db/verify-approval-role.sql" 16 "verify-approval-role.sql as approver"

# --- Explicit probes AS the approver ----------------------------------------
probe() {
  local expect="$1" label="$2" sql="$3"
  if PGPASSWORD="$APPROVER_PASSWORD" "$PG_BIN/psql" -h "$SCRATCH" -p "$PORT" \
       -U beerpassport_admin_approver -d "$DB" -v ON_ERROR_STOP=1 \
       -c "$sql" >/dev/null 2>&1; then
    if [ "$expect" = "ok" ]; then pass "probe: $label"; else fail "probe: $label (succeeded but must be denied)"; fi
  else
    if [ "$expect" = "denied" ]; then pass "probe: $label"; else fail "probe: $label (failed but must succeed)"; fi
  fi
}
probe ok     "UPDATE of beverage_images.status succeeds" \
  "UPDATE beverage_images SET status = 'approved' WHERE id = $IMG_ID"
probe denied "UPDATE of a non-granted beverage_images column fails" \
  "UPDATE beverage_images SET source_url = 'https://example.com/x' WHERE id = $IMG_ID"
probe ok     "INSERT into image_review_events succeeds" \
  "INSERT INTO image_review_events (beverage_image_id, beverage_id, action, from_status, to_status) VALUES ($IMG_ID, $BEER_ID, 'approve', 'pending', 'approved')"
probe denied "INSERT on beers fails" \
  "INSERT INTO beers (name) VALUES ('probe')"
probe denied "UPDATE on beers fails" \
  "UPDATE beers SET name = name WHERE id = -1"
probe denied "DELETE on beers fails" \
  "DELETE FROM beers WHERE id = -1"
probe denied "SELECT of users.notification_token fails" \
  "SELECT notification_token FROM users LIMIT 1"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "ALL ROLE TESTS PASSED"
  exit 0
fi
echo "$FAILURES CHECK(S) FAILED" >&2
exit 1
