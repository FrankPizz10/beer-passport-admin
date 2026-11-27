#!/bin/sh
# Disposable catalog fixture only. No production credentials or persistent volumes.
set -eu
container="bp-catalog-changes-test-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=disposable-test -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
attempt=0
until docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 30 ] || { echo 'Postgres did not start' >&2; exit 1; }
  sleep 1
done
psql() { docker exec -i "$container" psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }
psql -q <<'SQL'
CREATE TABLE users (id serial PRIMARY KEY, uid varchar(255) UNIQUE NOT NULL, user_name varchar(255) NOT NULL);
CREATE TABLE breweries (id serial PRIMARY KEY, name varchar(255) NOT NULL DEFAULT '', address1 varchar(255) NOT NULL DEFAULT '', address2 varchar(255) NOT NULL DEFAULT '', city varchar(255) NOT NULL DEFAULT '', state varchar(255) NOT NULL DEFAULT '', code varchar(25) NOT NULL DEFAULT '', country varchar(255) NOT NULL DEFAULT '', phone varchar(50) NOT NULL DEFAULT '', website varchar(255) NOT NULL DEFAULT '', descript text NOT NULL DEFAULT '', add_user integer, last_mod timestamp(0) NOT NULL DEFAULT now());
CREATE TABLE categories (id serial PRIMARY KEY, cat_name varchar(255) UNIQUE NOT NULL DEFAULT '', last_mod timestamp(0) NOT NULL DEFAULT now());
CREATE TABLE styles (id serial PRIMARY KEY, cat_id integer REFERENCES categories(id), style_name varchar(255) UNIQUE NOT NULL DEFAULT '', last_mod timestamp(0) NOT NULL DEFAULT now());
CREATE TABLE beers (id serial PRIMARY KEY, brewery_id integer REFERENCES breweries(id), name varchar(255) NOT NULL DEFAULT '', cat_id integer REFERENCES categories(id), style_id integer REFERENCES styles(id), abv double precision, ibu double precision, srm double precision, upc varchar(255), descript text, search_vector tsvector, discontinued boolean NOT NULL DEFAULT false, last_mod timestamp(0) NOT NULL DEFAULT now());
CREATE TABLE beverage_images (id serial PRIMARY KEY, beverage_id integer REFERENCES beers(id) ON DELETE CASCADE);
CREATE TABLE user_beers (id serial PRIMARY KEY, beer_id integer REFERENCES beers(id) ON DELETE RESTRICT);
CREATE TABLE collection_beers (id serial PRIMARY KEY, collection_id integer NOT NULL, beer_id integer NOT NULL REFERENCES beers(id) ON DELETE CASCADE, created_at timestamp(0) NOT NULL DEFAULT now(), updated_at timestamp(0) NOT NULL DEFAULT now());
INSERT INTO users(uid, user_name) VALUES ('owner', 'Owner'), ('reviewer', 'Reviewer');
INSERT INTO breweries(id,name,descript) VALUES (1,'Original Brewery','');
INSERT INTO categories(id,cat_name) VALUES (1,'Lager');
INSERT INTO styles(id,cat_id,style_name) VALUES (1,1,'Lager');
INSERT INTO beers(id,brewery_id,name,cat_id,style_id,abv,descript) VALUES (1,1,'Original Beer',1,1,5,'Original');
INSERT INTO beverage_images(beverage_id) VALUES (1);
INSERT INTO user_beers(beer_id) VALUES (1);
CREATE ROLE beerpassport_admin_viewer;
SQL
psql -q < server/db/migrations/007-catalog-change-workflow.sql
psql -q < server/db/catalog-writer-role.sql
psql -q < server/db/catalog-writer-role.sql
psql -q -c 'GRANT UPDATE ON users TO beerpassport_catalog_writer'
if psql -q < server/db/catalog-writer-role.sql >/dev/null 2>&1; then
  echo 'FAIL: catalog writer accepted unexpected privileges' >&2; exit 1
fi
psql -q -c "REVOKE UPDATE ON users FROM beerpassport_catalog_writer; ALTER ROLE beerpassport_catalog_writer PASSWORD 'disposable-test'"
if psql -q -c 'SET ROLE beerpassport_catalog_writer; DELETE FROM beers WHERE id = 1' >/dev/null 2>&1; then
  echo 'FAIL: catalog writer can delete catalog records' >&2; exit 1
fi
if psql -q -c "SET ROLE beerpassport_catalog_writer; UPDATE users SET user_name = 'bad'" >/dev/null 2>&1; then
  echo 'FAIL: catalog writer can edit user data' >&2; exit 1
fi
port=$(docker port "$container" 5432/tcp | awk -F: 'NR == 1 {print $NF}')
[ -n "$port" ] || { echo 'No disposable Postgres port' >&2; exit 1; }
RUN_CATALOG_CHANGES_DB_TESTS=1 \
CATALOG_TEST_OWNER_URL="postgresql://postgres:disposable-test@127.0.0.1:$port/postgres" \
CATALOG_TEST_WRITER_URL="postgresql://beerpassport_catalog_writer:disposable-test@127.0.0.1:$port/postgres" \
  npm --prefix server test -- --runInBand test/catalogChanges.integration.test.ts
echo 'PASS: catalog changes, archive safety, audit and role restrictions'
