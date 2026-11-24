#!/usr/bin/env bash
# Disposable local PostgreSQL only. No production credentials or AWS access.
set -euo pipefail
server_dir="$(cd "$(dirname "$0")/.." && pwd)"
canonical_schema="${CANONICAL_SCHEMA:-/private/tmp/bp-server-recovery/prisma/schema.prisma}"
source_file="${STAGED_CANDIDATES:-/Users/fpizz/Downloads/candidates-us.json}"
scratch="$(mktemp -d /private/tmp/bp-review-test.XXXXXX)"
container="bp-review-test-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT
test -f "$canonical_schema"
test -f "$source_file"
docker run -d --name "$container" --network bridge -e POSTGRES_PASSWORD=disposable-test \
  -e POSTGRES_DB=discovery_test -p 127.0.0.1::5432 postgres:16 >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -U postgres -d discovery_test >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container" pg_isready -U postgres -d discovery_test >/dev/null
port="$(docker port "$container" 5432/tcp | awk -F: 'NR==1 {print $NF}')"
[[ "$port" =~ ^[0-9]+$ ]]
export DATABASE_URL="postgresql://postgres:disposable-test@127.0.0.1:${port}/discovery_test"
export DATABASE_URL_ADMIN_LOADER="$DATABASE_URL"
export DISCOVERY_TEST_OWNER_URL="$DATABASE_URL"
cd "$server_dir"
./node_modules/.bin/prisma migrate deploy --schema "$canonical_schema"
set +e
drift="$(./node_modules/.bin/prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$canonical_schema" --exit-code)"
drift_status=$?
set -e
# The search migration creates these PostgreSQL-specific GIN indexes outside
# Prisma's schema representation. Refuse any other drift, including no output
# from a failed Prisma command; these indexes are expected to exist.
expected_drift=$'\n[*] Changed the `beers` table\n  [-] Removed index on columns (name)\n  [-] Removed index on columns (search_vector)\n\n[*] Changed the `breweries` table\n  [-] Removed index on columns (name)'
if [[ "$drift_status" != 2 || "$drift" != "$expected_drift" ]]; then
  printf 'Unexpected Prisma schema drift (exit %s):\n%s\n' "$drift_status" "$drift" >&2
  exit 1
fi
echo 'Schema matches apart from the three SQL-managed search indexes.'
./node_modules/.bin/prisma generate --schema prisma/schema.prisma
docker exec -i "$container" psql -U postgres -d discovery_test -v ON_ERROR_STOP=1 \
  -v viewer_password=viewer-test < db/readonly-role.sql
docker exec -i "$container" psql -U postgres -d discovery_test -v ON_ERROR_STOP=1 \
  -v reviewer_password=reviewer-test < db/discovery-reviewer-role.sql
docker exec -i "$container" psql -U postgres -d discovery_test -v ON_ERROR_STOP=1 \
  -c 'SET SESSION AUTHORIZATION beerpassport_admin_viewer' -f - < db/verify-readonly-role.sql
docker exec -i "$container" psql -U postgres -d discovery_test -v ON_ERROR_STOP=1 \
  -c 'SET SESSION AUTHORIZATION beerpassport_discovery_reviewer' -f - < db/verify-discovery-reviewer.sql
docker exec -i "$container" psql -U postgres -d discovery_test -v ON_ERROR_STOP=1 \
  -v viewer_password=viewer-test < db/readonly-role.sql
docker exec -i "$container" psql -U postgres -d discovery_test -v ON_ERROR_STOP=1 \
  -v reviewer_password=reviewer-test < db/discovery-reviewer-role.sql
docker exec -i "$container" psql -U postgres -d discovery_test -v ON_ERROR_STOP=1 \
  -c 'SET SESSION AUTHORIZATION beerpassport_admin_viewer' -f - < db/verify-readonly-role.sql
docker exec -i "$container" psql -U postgres -d discovery_test -v ON_ERROR_STOP=1 \
  -c 'SET SESSION AUTHORIZATION beerpassport_discovery_reviewer' -f - < db/verify-discovery-reviewer.sql
docker exec -i "$container" psql -U postgres -d discovery_test -v ON_ERROR_STOP=1 \
  -c "INSERT INTO users (uid, age, email, user_name) VALUES ('integration-admin', 30, 'integration-admin@example.com', 'Integration Admin'), ('integration-frank', 30, 'integration-frank@example.com', 'Integration Frank');"
./node_modules/.bin/ts-node --transpile-only scripts/build-discovery-bundle.ts \
  --in "$source_file" --slug manifest-seed-25 --source openfoodfacts \
  --title 'Manifest rehearsal seed' --out "$scratch/bundles" --limit 50
./node_modules/.bin/ts-node --transpile-only scripts/ingest-discovery-bundle.ts "$scratch/bundles/manifest-seed-25"
export DATABASE_URL="postgresql://beerpassport_admin_viewer:viewer-test@127.0.0.1:${port}/discovery_test"
export DATABASE_URL_DISCOVERY_WRITE="postgresql://beerpassport_discovery_reviewer:reviewer-test@127.0.0.1:${port}/discovery_test"
export MANIFEST_EXPORT_DIR="$scratch/export"
mkdir -p "$MANIFEST_EXPORT_DIR"
RUN_DB_TESTS=1 REVIEW_TEST_SEED_COUNT=50 ./node_modules/.bin/jest test/discoveryManifests.integration.test.ts --runInBand
