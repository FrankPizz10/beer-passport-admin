#!/usr/bin/env bash
# Disposable-database rehearsal for discovery import manifests and
# the import executor (hub decision 006 revisions 1 and 2,
# issues/001 section 4). This is the Phase 5 core proof: the ONLY
# place the executor ever runs in this phase is inside this
# throwaway database.
#
# Builds a socket-only PostgreSQL 16 cluster from the db-recovery
# workstream binaries, applies the catalog base schema, migrations
# 001-005, the viewer role, and the discovery reviewer role, seeds
# two admin users (a reviewer and the manifest approver), builds the
# Phase 2 seed bundle (25 records from the catalog-expansion-2
# reassessment candidates) and ingests it with the operator loader
# identity, then:
#   1. proves the executor CLI refuses to run without
#      DATABASE_URL_ADMIN_LOADER (exit 2) and refuses a manifest that
#      does not exist (exit 1, check 1) BEFORE any import logic;
#   2. runs the RUN_DB_TESTS-guarded manifest integration suite,
#      which drives candidates through selection (Phase 3) and image
#      approval (Phase 4, local stub origin), builds, approves, and
#      exports a manifest through the API, imports it with the real
#      executor inside this database, and runs the negative battery
#      (draft refusal, fingerprint abort, decision-change abort,
#      tampered-image abort, concurrent imports, --dry-run);
#   3. verifies the exported manifest bytes offline with sha256sum
#      against the hash the API recorded.
# Everything lives in a mktemp scratch directory and is deleted on
# exit. No production database, no network listener (unix socket
# only), no Docker.
#
# Run from anywhere:  bash server/scripts/test-discovery-manifests.sh
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "${SERVER_DIR}/.." && pwd)"
STAGED_CANDIDATES="${STAGED_CANDIDATES:-$HOME/workspace/workstreams/catalog-expansion-2/reassessment/candidates-us.json}"
PGROOT="${PGROOT:-$HOME/workspace/workstreams/db-recovery/pginstall}"
PGPORT="${PGPORT:-54401}"
DBNAME="discovery_manifests"
VIEWER_PW="viewer-test"
REVIEWER_PW="reviewer-test"
BUNDLE_SLUG="manifest-seed-25"

SCRATCH="$(mktemp -d /tmp/discovery-manifests.XXXXXX)"
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

echo "== migrations 001-005 and roles =="
"${PSQL_DB[@]}" -q -f "${SERVER_DIR}/db/migrations/001-image-approval.sql"
"${PSQL_DB[@]}" -q -v viewer_password="${VIEWER_PW}" -f "${SERVER_DIR}/db/readonly-role.sql"
"${PSQL_DB[@]}" -q -f "${SERVER_DIR}/db/migrations/002-discovery-staging.sql"
"${PSQL_DB[@]}" -q -f "${SERVER_DIR}/db/migrations/003-discovery-decisions.sql"
"${PSQL_DB[@]}" -q -f "${SERVER_DIR}/db/migrations/004-discovery-image-review.sql"
"${PSQL_DB[@]}" -q -f "${SERVER_DIR}/db/migrations/005-discovery-manifests.sql"
"${PSQL_DB[@]}" -q -v reviewer_password="${REVIEWER_PW}" -f "${SERVER_DIR}/db/discovery-reviewer-role.sql"

echo "== seed admin users (reviewer + manifest approver) =="
"${PSQL_DB[@]}" -q -c "INSERT INTO users (uid, age, email, user_name) VALUES ('integration-admin', 30, 'integration-admin@example.com', 'Integration Admin');"
"${PSQL_DB[@]}" -q -c "INSERT INTO users (uid, age, email, user_name) VALUES ('integration-frank', 30, 'integration-frank@example.com', 'Integration Frank');"

export DATABASE_URL_ADMIN_LOADER="postgresql://postgres@localhost:${PGPORT}/${DBNAME}?host=${SCRATCH}"

echo "== build + ingest the Phase 2 seed bundle (25 records) =="
test -f "${STAGED_CANDIDATES}"
(cd "${SERVER_DIR}" && npx ts-node --transpile-only scripts/build-discovery-bundle.ts \
  --in "${STAGED_CANDIDATES}" --slug "${BUNDLE_SLUG}" --source openfoodfacts \
  --title "Manifest rehearsal seed" --out "${SCRATCH}/bundles" --limit 25)
(cd "${SERVER_DIR}" && npx ts-node --transpile-only scripts/ingest-discovery-bundle.ts \
  "${SCRATCH}/bundles/${BUNDLE_SLUG}")

echo "== executor CLI refusals before any import logic =="
set +e
NOENV_OUT="$(cd "${SERVER_DIR}" && env -u DATABASE_URL_ADMIN_LOADER npx ts-node --transpile-only scripts/import-discovery-manifest.ts --manifest mf-none-20260101-01 --sha256 0000000000000000000000000000000000000000000000000000000000000000 2>&1)"
NOENV_CODE=$?
MISSING_OUT="$(cd "${SERVER_DIR}" && npx ts-node --transpile-only scripts/import-discovery-manifest.ts --manifest mf-none-20260101-01 --sha256 0000000000000000000000000000000000000000000000000000000000000000 2>&1)"
MISSING_CODE=$?
set -e
echo "no-loader-env exit=${NOENV_CODE}: ${NOENV_OUT}"
echo "missing-manifest exit=${MISSING_CODE}: ${MISSING_OUT}"
test "${NOENV_CODE}" -eq 2
test "${MISSING_CODE}" -eq 1
echo "${MISSING_OUT}" | grep -q "IMPORT REFUSED \[check1\]"

echo "== manifest integration suite (RUN_DB_TESTS=1) =="
export DATABASE_URL="postgresql://beerpassport_admin_viewer:${VIEWER_PW}@localhost:${PGPORT}/${DBNAME}?host=${SCRATCH}"
export DATABASE_URL_DISCOVERY_WRITE="postgresql://beerpassport_discovery_reviewer:${REVIEWER_PW}@localhost:${PGPORT}/${DBNAME}?host=${SCRATCH}"
export DISCOVERY_TEST_OWNER_URL="postgresql://postgres@localhost:${PGPORT}/${DBNAME}?host=${SCRATCH}"
export MANIFEST_EXPORT_DIR="${SCRATCH}/export"
mkdir -p "${MANIFEST_EXPORT_DIR}"
(cd "${SERVER_DIR}" && RUN_DB_TESTS=1 npx jest test/discoveryManifests.integration.test.ts ${JEST_ARGS:-} 2>&1 | tail -n "${JEST_TAIL:-12}")

echo "== offline sha256sum verification of the exported manifest =="
EXPORTED_SHA="$(sha256sum "${MANIFEST_EXPORT_DIR}/manifest.json" | cut -d' ' -f1)"
RECORDED_SHA="$(cat "${MANIFEST_EXPORT_DIR}/manifest.sha256")"
echo "sha256sum: ${EXPORTED_SHA}"
echo "recorded:  ${RECORDED_SHA}"
test "${EXPORTED_SHA}" = "${RECORDED_SHA}"

echo "ALL DISCOVERY MANIFEST CHECKS PASSED"
