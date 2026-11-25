#!/usr/bin/env bash
# Disposable-database rehearsal for discovery match suggestions
# (guided review, WS1). Builds a socket-only PostgreSQL 16 cluster
# from the db-recovery workstream binaries, applies the catalog base
# schema, migrations 001-005, and the viewer role, then runs the
# RUN_DB_TESTS-guarded match integration suite, which seeds its own
# small catalog + staged batch through the owner identity and drives
# the endpoint through the read-only viewer client.
# Everything lives in a mktemp scratch directory and is deleted on
# exit. No production database, no network listener (unix socket
# only), no Docker.
#
# Run from anywhere:  bash server/scripts/test-discovery-match.sh
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "${SERVER_DIR}/.." && pwd)"
PGROOT="${PGROOT:-$HOME/workspace/workstreams/db-recovery/pginstall}"
PGPORT="${PGPORT:-54421}"
DBNAME="discovery_match"
VIEWER_PW="viewer-test"

SCRATCH="$(mktemp -d /tmp/discovery-match.XXXXXX)"
cp -a "${PGROOT}" "${SCRATCH}/pginstall"
PGBIN="${SCRATCH}/pginstall/bin"
export LD_LIBRARY_PATH="${SCRATCH}/pginstall/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
cleanup() {
  setpriv --reuid=65534 --regid=65534 --clear-groups \
    "${PGBIN}/pg_ctl" -D "${SCRATCH}/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "${SCRATCH}"
}
trap cleanup EXIT
chown -R 65534:65534 "${SCRATCH}"

as_nobody() {
  setpriv --reuid=65534 --regid=65534 --clear-groups "$@"
}

PSQL_OWNER=("${PGBIN}/psql" -h "${SCRATCH}" -p "${PGPORT}" -U postgres -v ON_ERROR_STOP=1)

echo "== initdb (socket-only, uid 65534) =="
as_nobody "${PGBIN}/initdb" -D "${SCRATCH}/data" -U postgres --auth=trust >/dev/null
as_nobody "${PGBIN}/pg_ctl" -D "${SCRATCH}/data" \
  -o "-k ${SCRATCH} -p ${PGPORT} -c listen_addresses=''" \
  -l "${SCRATCH}/pg.log" -w start >/dev/null
"${PSQL_OWNER[@]}" -c "CREATE DATABASE ${DBNAME}" postgres >/dev/null
PSQL_DB=("${PGBIN}/psql" -h "${SCRATCH}" -p "${PGPORT}" -U postgres -d "${DBNAME}" -v ON_ERROR_STOP=1)

echo "== catalog base schema (pre-migration-001 Prisma schema) =="
ALL_001_COMMITS="$(git -C "${REPO_DIR}" log --all --reverse --format=%H -S 'image_review_events' -- server/prisma/schema.prisma)"
FIRST_001_COMMIT="${ALL_001_COMMITS%%$'\n'*}"
git -C "${REPO_DIR}" show "${FIRST_001_COMMIT}^:server/prisma/schema.prisma" > "${SCRATCH}/base.prisma"
export PRISMA_QUERY_ENGINE_LIBRARY="${PRISMA_QUERY_ENGINE_LIBRARY:-$HOME/workspace/workstreams/pilot-impl/repo/node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node}"
export PRISMA_MIGRATION_ENGINE_BINARY="${PRISMA_MIGRATION_ENGINE_BINARY:-$HOME/workspace/engines/migration-engine}"
(cd "${SERVER_DIR}" && CHECKPOINT_DISABLE=1 npx prisma migrate diff --from-empty \
  --to-schema-datamodel "${SCRATCH}/base.prisma" --script > "${SCRATCH}/base.sql")
test -s "${SCRATCH}/base.sql"
(cd "${SERVER_DIR}" && CHECKPOINT_DISABLE=1 npx prisma generate >/dev/null)
"${PSQL_DB[@]}" -q -f "${SCRATCH}/base.sql"

echo "== migrations 001-005 and the viewer role =="
"${PSQL_DB[@]}" -q -f "${SERVER_DIR}/db/migrations/001-image-approval.sql"
"${PSQL_DB[@]}" -q -v viewer_password="${VIEWER_PW}" -f "${SERVER_DIR}/db/readonly-role.sql"
"${PSQL_DB[@]}" -q -f "${SERVER_DIR}/db/migrations/002-discovery-staging.sql"
"${PSQL_DB[@]}" -q -f "${SERVER_DIR}/db/migrations/003-discovery-decisions.sql"
"${PSQL_DB[@]}" -q -f "${SERVER_DIR}/db/migrations/004-discovery-image-review.sql"
"${PSQL_DB[@]}" -q -f "${SERVER_DIR}/db/migrations/005-discovery-manifests.sql"

echo "== match integration suite (RUN_DB_TESTS=1) =="
export DATABASE_URL="postgresql://beerpassport_admin_viewer:${VIEWER_PW}@localhost:${PGPORT}/${DBNAME}?host=${SCRATCH}"
export DISCOVERY_TEST_OWNER_URL="postgresql://postgres@localhost:${PGPORT}/${DBNAME}?host=${SCRATCH}"
(cd "${SERVER_DIR}" && RUN_DB_TESTS=1 npx jest test/discoveryMatch.integration.test.ts ${JEST_ARGS:-} 2>&1 | tail -n "${JEST_TAIL:-12}")

echo "ALL DISCOVERY MATCH CHECKS PASSED"
