#!/bin/sh
# Disposable container only. No host ports, production credentials, or volumes.
set -eu
container="bp-admin-access-test-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=disposable-test -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
attempt=0
until docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 30 ] || { echo 'Postgres did not start' >&2; exit 1; }
  sleep 1
done
psql() { docker exec -i "$container" psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }
psql -q <<'SQL'
CREATE TABLE users (uid varchar(255) PRIMARY KEY);
INSERT INTO users VALUES ('owner'), ('reviewer');
CREATE ROLE beerpassport_admin_viewer;
SQL
psql -q < server/db/migrations/006-admin-access.sql
psql -q < server/db/admin-access-role.sql
psql -q < server/db/admin-access-role.sql
psql -q -c 'GRANT UPDATE ON users TO beerpassport_admin_access_writer'
if psql -q < server/db/admin-access-role.sql >/dev/null 2>&1; then
  echo 'FAIL: role setup accepted unexpected permissions' >&2; exit 1
fi
psql -q -c 'REVOKE UPDATE ON users FROM beerpassport_admin_access_writer'
psql -q <<'SQL'
BEGIN;
SET ROLE beerpassport_admin_access_writer;
SELECT pg_advisory_xact_lock(hashtextextended('reviewer', 0))::text AS locked;
INSERT INTO admin_access_grants (uid, granted_by_uid) VALUES ('reviewer', 'owner');
INSERT INTO admin_access_events (target_uid, actor_uid, action) VALUES ('reviewer', 'owner', 'grant');
COMMIT;
RESET ROLE;
DO $$ BEGIN
  IF (SELECT count(*) FROM admin_access_grants) <> 1 OR (SELECT count(*) FROM admin_access_events) <> 1 THEN
    RAISE EXCEPTION 'grant/audit mismatch';
  END IF;
END $$;
BEGIN;
SET ROLE beerpassport_admin_access_writer;
DELETE FROM admin_access_grants WHERE uid = 'reviewer';
INSERT INTO admin_access_events (target_uid, actor_uid, action) VALUES ('reviewer', 'owner', 'revoke');
ROLLBACK;
RESET ROLE;
DO $$ BEGIN
  IF (SELECT count(*) FROM admin_access_grants) <> 1 OR (SELECT count(*) FROM admin_access_events) <> 1 THEN
    RAISE EXCEPTION 'rollback did not preserve grant/audit';
  END IF;
END $$;
SQL
if psql -q -c 'SET ROLE beerpassport_admin_access_writer; DELETE FROM admin_access_events' >/dev/null 2>&1; then
  echo 'FAIL: writer can delete audit events' >&2; exit 1
fi
if psql -q -c "SET ROLE beerpassport_admin_access_writer; DELETE FROM users WHERE uid = 'owner'" >/dev/null 2>&1; then
  echo 'FAIL: writer can delete users' >&2; exit 1
fi
psql -q -c 'SET ROLE beerpassport_admin_viewer; SELECT count(*) FROM admin_access_grants; SELECT count(*) FROM admin_access_events' >/dev/null
psql -q -c "ALTER ROLE beerpassport_admin_access_writer PASSWORD 'disposable-test'; INSERT INTO users VALUES ('integration-reviewer')"
port=$(docker port "$container" 5432/tcp | awk -F: 'NR == 1 {print $NF}')
[ -n "$port" ] || { echo 'No disposable Postgres port' >&2; exit 1; }
RUN_ADMIN_ACCESS_DB_TESTS=1 \
ADMIN_ACCESS_TEST_OWNER_URL="postgresql://postgres:disposable-test@127.0.0.1:$port/postgres" \
ADMIN_ACCESS_TEST_WRITER_URL="postgresql://beerpassport_admin_access_writer:disposable-test@127.0.0.1:$port/postgres" \
  npm --prefix server test -- --runInBand test/adminAccess.integration.test.ts
echo 'PASS: admin grant, audit, rollback and role restrictions'
