#!/usr/bin/env bash
# Disposable-database proof for the FULL domestic discovery bundle
# ingest (6,817 records, hub decision 006): the production-scale
# counterpart to the 25-record seed rehearsal in
# test-discovery-manifests.sh.
#
# Builds a socket-only PostgreSQL 16 cluster from the db-recovery
# workstream binaries, applies the catalog base schema, migrations
# 001-005, the viewer role, and the discovery reviewer role, builds
# the FULL bundle from the staged reassessment candidates-us.json
# (NO --limit), then:
#   1. REPRODUCES the original failure: the pre-fix ingest script
#      (extracted from the branch base commit, whose single Prisma
#      interactive transaction uses the default 5s timeout) must
#      exit non-zero with P2028/timeout in its output and leave
#      0 batch rows and 0 candidates behind (clean rollback);
#   2. runs the fixed ingest (explicit transaction timeout) and
#      asserts the batch row, the 6,817 candidate count, the bundle
#      candidates_sha256, and the hold distribution;
#   3. re-runs the fixed ingest and asserts it is a no-op
#      (same-hash idempotency preserved).
# Everything lives in a mktemp scratch directory and is deleted on
# exit. No production database, no network listener (unix socket
# only), no Docker.
#
# Run from anywhere:  bash server/scripts/test-full-domestic-ingest.sh
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "${SERVER_DIR}/.." && pwd)"
STAGED_CANDIDATES="${STAGED_CANDIDATES:-$HOME/workspace/workstreams/catalog-expansion-2/reassessment/candidates-us.json}"
PGROOT="${PGROOT:-$HOME/workspace/workstreams/db-recovery/pginstall}"
PGPORT="${PGPORT:-54411}"
DBNAME="discovery_full_ingest"
VIEWER_PW="viewer-test"
REVIEWER_PW="reviewer-test"
BUNDLE_SLUG="candidates-us-full"
EXPECTED_RECORDS=6817
EXPECTED_SHA256="d9de3940d08b05f1afeb219ef2f54e8dd7c6ddf1c6a95549b193648cf3a39ed0"
# Commit the pre-fix ingest is extracted from for the reproduction
# (the stack tip this fix branch was created from).
BASE_COMMIT="${BASE_COMMIT:-ce4946f}"

SCRATCH="$(mktemp -d /tmp/discovery-full-ingest.XXXXXX)"
cp -a "${PGROOT}" "${SCRATCH}/pginstall"
PGBIN="${SCRATCH}/pginstall/bin"
export LD_LIBRARY_PATH="${SCRATCH}/pginstall/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
PRISTINE_INGEST="${SERVER_DIR}/scripts/.pristine-ingest-discovery-bundle.ts"
cleanup() {
  setpriv --reuid=65534 --regid=65534 --clear-groups \
    "${PGBIN}/pg_ctl" -D "${SCRATCH}/data" -m immediate stop >/dev/null 2>&1 || true
  rm -f "${PRISTINE_INGEST}"
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

export DATABASE_URL_ADMIN_LOADER="postgresql://postgres@localhost:${PGPORT}/${DBNAME}?host=${SCRATCH}"

echo "== build the FULL domestic bundle (no --limit) =="
test -f "${STAGED_CANDIDATES}"
(cd "${SERVER_DIR}" && npx ts-node --transpile-only scripts/build-discovery-bundle.ts \
  --in "${STAGED_CANDIDATES}" --slug "${BUNDLE_SLUG}" --source reassessment \
  --title "Full domestic set (candidates-us)" --out "${SCRATCH}/bundles")
BUNDLE_DIR="${SCRATCH}/bundles/${BUNDLE_SLUG}"
BUNDLE_SHA="$(python3 -c "import json; print(json.load(open('${BUNDLE_DIR}/manifest.json'))['candidates_sha256'])")"
echo "bundle candidates_sha256: ${BUNDLE_SHA}"
test "${BUNDLE_SHA}" = "${EXPECTED_SHA256}"

echo "== reproduce: pre-fix ingest (default 5s transaction timeout) must fail =="
INGEST_SCRIPT="${INGEST_SCRIPT:-}"
if [ -z "${INGEST_SCRIPT}" ]; then
  # The pristine copy must sit in scripts/ so its relative import of
  # ./discoveryBundleCore resolves exactly as the real script's does.
  git -C "${REPO_DIR}" show "${BASE_COMMIT}:server/scripts/ingest-discovery-bundle.ts" > "${PRISTINE_INGEST}"
  INGEST_SCRIPT="scripts/.pristine-ingest-discovery-bundle.ts"
fi
set +e
PRISTINE_OUT="$(cd "${SERVER_DIR}" && npx ts-node --transpile-only "${INGEST_SCRIPT}" "${BUNDLE_DIR}" 2>&1)"
PRISTINE_CODE=$?
set -e
echo "pre-fix ingest exit=${PRISTINE_CODE}"
echo "${PRISTINE_OUT}" | tail -n 3
test "${PRISTINE_CODE}" -ne 0
echo "${PRISTINE_OUT}" | grep -qi "P2028\|timeout"
BATCHES_AFTER_FAIL="$("${PSQL_DB[@]}" -t -A -c "SELECT count(*) FROM discovery_batches;")"
CANDIDATES_AFTER_FAIL="$("${PSQL_DB[@]}" -t -A -c "SELECT count(*) FROM discovery_candidates;")"
echo "after failed ingest: batches=${BATCHES_AFTER_FAIL} candidates=${CANDIDATES_AFTER_FAIL} (expect 0/0, clean rollback)"
test "${BATCHES_AFTER_FAIL}" = "0"
test "${CANDIDATES_AFTER_FAIL}" = "0"
rm -f "${PRISTINE_INGEST}"

echo "== fixed ingest: full set in one transaction =="
FIXED_OUT="$(cd "${SERVER_DIR}" && npx ts-node --transpile-only scripts/ingest-discovery-bundle.ts "${BUNDLE_DIR}" 2>&1)"
echo "${FIXED_OUT}"
echo "${FIXED_OUT}" | grep -q '"status": "inserted"'
BATCH_SHA="$("${PSQL_DB[@]}" -t -A -c "SELECT candidates_sha256 FROM discovery_batches WHERE slug = '${BUNDLE_SLUG}';")"
CANDIDATE_COUNT="$("${PSQL_DB[@]}" -t -A -c "SELECT count(*) FROM discovery_candidates;")"
echo "batch candidates_sha256: ${BATCH_SHA}"
echo "candidates ingested: ${CANDIDATE_COUNT} (expect ${EXPECTED_RECORDS})"
test "${BATCH_SHA}" = "${EXPECTED_SHA256}"
test "${CANDIDATE_COUNT}" = "${EXPECTED_RECORDS}"

echo "== hold distribution =="
HOLD_IMAGE="$("${PSQL_DB[@]}" -t -A -c "SELECT count(*) FROM discovery_candidates WHERE hold_reason = 'image_unverified';")"
HOLD_BREWERY="$("${PSQL_DB[@]}" -t -A -c "SELECT count(*) FROM discovery_candidates WHERE hold_reason = 'missing_brewery';")"
HOLD_METADATA="$("${PSQL_DB[@]}" -t -A -c "SELECT count(*) FROM discovery_candidates WHERE hold_reason = 'metadata_incomplete';")"
HOLD_NONE="$("${PSQL_DB[@]}" -t -A -c "SELECT count(*) FROM discovery_candidates WHERE hold_reason IS NULL;")"
echo "image_unverified=${HOLD_IMAGE} (expect 6685), missing_brewery=${HOLD_BREWERY} (expect 82), metadata_incomplete=${HOLD_METADATA} (expect 48), no hold=${HOLD_NONE} (expect 2)"
test "${HOLD_IMAGE}" = "6685"
test "${HOLD_BREWERY}" = "82"
test "${HOLD_METADATA}" = "48"
test "${HOLD_NONE}" = "2"

echo "== second ingest of the same bundle is a no-op =="
SECOND_OUT="$(cd "${SERVER_DIR}" && npx ts-node --transpile-only scripts/ingest-discovery-bundle.ts "${BUNDLE_DIR}" 2>&1)"
echo "${SECOND_OUT}"
echo "${SECOND_OUT}" | grep -q '"status": "noop"'
CANDIDATE_COUNT_AFTER="$("${PSQL_DB[@]}" -t -A -c "SELECT count(*) FROM discovery_candidates;")"
test "${CANDIDATE_COUNT_AFTER}" = "${EXPECTED_RECORDS}"

echo "ALL FULL DOMESTIC INGEST CHECKS PASSED"
