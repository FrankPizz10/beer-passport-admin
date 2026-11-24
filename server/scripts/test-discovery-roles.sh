#!/usr/bin/env bash
# Disposable-database verification for the discovery reviewer role and
# the decision endpoints (hub decision 006, issues/001 section 3).
#
# Builds a throwaway socket-only PostgreSQL 16 cluster from the
# db-recovery workstream binaries, applies the catalog base schema,
# migrations 001-004, the viewer role, and the discovery reviewer
# role, then:
#   1. runs server/db/verify-discovery.sql AS the viewer (must pass),
#   2. runs server/db/verify-discovery-reviewer.sql AS the reviewer
#      (must pass),
#   3. seeds one admin user and runs the RUN_DB_TESTS-guarded decision
#      and image-review integration suites with the API connected as
#      viewer (reads) + reviewer (writes).
# Everything lives in a mktemp scratch directory and is deleted on
# exit. No production database, no network listener (unix socket
# only), no Docker.
#
# Run from anywhere:  bash server/scripts/test-discovery-roles.sh
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "${SERVER_DIR}/.." && pwd)"
PGROOT="${PGROOT:-$HOME/workspace/workstreams/db-recovery/pginstall}"
PGPORT="${PGPORT:-54399}"
DBNAME="discovery_roles"
VIEWER_PW="viewer-test"
REVIEWER_PW="reviewer-test"

SCRATCH="$(mktemp -d /tmp/discovery-roles.XXXXXX)"
# The workstream binaries are owned by another uid and are not
# executable by 65534 in place, so the install is copied into the
# scratch directory and chowned (the established disposable-PG copy
# pattern) before anything runs as 65534.
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
# The sandbox cannot download Prisma engines; point the CLI at the
# locally provisioned ones (the established workaround).
export PRISMA_QUERY_ENGINE_LIBRARY="${PRISMA_QUERY_ENGINE_LIBRARY:-$HOME/workspace/workstreams/pilot-impl/repo/node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node}"
export PRISMA_MIGRATION_ENGINE_BINARY="${PRISMA_MIGRATION_ENGINE_BINARY:-$HOME/workspace/engines/migration-engine}"
(cd "${SERVER_DIR}" && CHECKPOINT_DISABLE=1 npx prisma migrate diff --from-empty \
  --to-schema-datamodel "${SCRATCH}/base.prisma" --script > "${SCRATCH}/base.sql")
test -s "${SCRATCH}/base.sql"
(cd "${SERVER_DIR}" && CHECKPOINT_DISABLE=1 npx prisma generate >/dev/null)
"${PSQL_DB[@]}" -q -f "${SCRATCH}/base.sql"

echo "== migrations 001-004 and roles =="
"${PSQL_DB[@]}" -q -f "${SERVER_DIR}/db/migrations/001-image-approval.sql"
"${PSQL_DB[@]}" -q -v viewer_password="${VIEWER_PW}" -f "${SERVER_DIR}/db/readonly-role.sql"
"${PSQL_DB[@]}" -q -f "${SERVER_DIR}/db/migrations/002-discovery-staging.sql"
"${PSQL_DB[@]}" -q -f "${SERVER_DIR}/db/migrations/003-discovery-decisions.sql"
"${PSQL_DB[@]}" -q -f "${SERVER_DIR}/db/migrations/004-discovery-image-review.sql"
"${PSQL_DB[@]}" -q -v reviewer_password="${REVIEWER_PW}" -f "${SERVER_DIR}/db/discovery-reviewer-role.sql"

echo "== seed admin user =="
"${PSQL_DB[@]}" -q -c "INSERT INTO users (uid, age, email, user_name) VALUES ('integration-admin', 30, 'integration-admin@example.com', 'Integration Admin');"

echo "== verify-discovery.sql as viewer =="
PGPASSWORD="${VIEWER_PW}" "${PGBIN}/psql" -h "${SCRATCH}" -p "${PGPORT}" \
  -U beerpassport_admin_viewer -d "${DBNAME}" -v ON_ERROR_STOP=1 \
  -f "${SERVER_DIR}/db/verify-discovery.sql"

echo "== verify-discovery-reviewer.sql as reviewer =="
PGPASSWORD="${REVIEWER_PW}" "${PGBIN}/psql" -h "${SCRATCH}" -p "${PGPORT}" \
  -U beerpassport_discovery_reviewer -d "${DBNAME}" -v ON_ERROR_STOP=1 \
  -f "${SERVER_DIR}/db/verify-discovery-reviewer.sql"

echo "== decision + image endpoint integration tests (RUN_DB_TESTS=1) =="
export DATABASE_URL="postgresql://beerpassport_admin_viewer:${VIEWER_PW}@localhost:${PGPORT}/${DBNAME}?host=${SCRATCH}"
export DATABASE_URL_DISCOVERY_WRITE="postgresql://beerpassport_discovery_reviewer:${REVIEWER_PW}@localhost:${PGPORT}/${DBNAME}?host=${SCRATCH}"
export DISCOVERY_TEST_OWNER_URL="postgresql://postgres@localhost:${PGPORT}/${DBNAME}?host=${SCRATCH}"
(cd "${SERVER_DIR}" && RUN_DB_TESTS=1 npx jest test/discoveryDecisions.integration.test.ts test/discoveryImages.integration.test.ts 2>&1 | tail -n 8)

echo "ALL DISCOVERY ROLE CHECKS PASSED"
