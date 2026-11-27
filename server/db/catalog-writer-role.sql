-- A dedicated role for the catalog change workflow. Set its password out of
-- band after applying this script. Never reuse the migration/superuser role.
BEGIN;
DO $$
DECLARE writer_oid oid;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'beerpassport_catalog_writer') THEN
    CREATE ROLE beerpassport_catalog_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5;
  END IF;
  SELECT oid INTO writer_oid FROM pg_roles WHERE rolname = 'beerpassport_catalog_writer';
  IF EXISTS (SELECT FROM pg_roles WHERE oid = writer_oid AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT FROM pg_auth_members WHERE member = writer_oid)
    OR EXISTS (SELECT FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = writer_oid AND deptype = 'o')
  THEN RAISE EXCEPTION 'catalog writer has unsafe role attributes, memberships, or ownership'; END IF;
  IF EXISTS (
    SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
    WHERE a.grantee = writer_oid AND NOT (n.nspname = 'public' AND (
      (c.relname IN ('beers','breweries','categories','styles','collection_beers') AND a.privilege_type = 'SELECT') OR
      (c.relname = 'catalog_change_requests' AND a.privilege_type IN ('SELECT','INSERT')) OR
      (c.relname = 'catalog_change_events' AND a.privilege_type IN ('SELECT','INSERT')) OR
      (c.relname IN ('catalog_change_requests_id_seq','catalog_change_events_id_seq') AND a.privilege_type = 'USAGE')
    ))
  ) OR EXISTS (
    SELECT FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(att.attacl) a
    WHERE a.grantee = writer_oid AND NOT (n.nspname = 'public' AND a.privilege_type = 'UPDATE' AND (
      (c.relname = 'beers' AND att.attname IN ('name','brewery_id','cat_id','style_id','abv','ibu','srm','upc','descript','discontinued','last_mod','archived_at','search_vector')) OR
      (c.relname = 'breweries' AND att.attname IN ('name','address1','address2','city','state','code','country','phone','website','descript','last_mod','archived_at')) OR
      (c.relname = 'categories' AND att.attname IN ('cat_name','last_mod','archived_at')) OR
      (c.relname = 'styles' AND att.attname IN ('style_name','cat_id','last_mod','archived_at')) OR
      (c.relname = 'catalog_change_requests' AND att.attname IN ('status','after_hash','reviewed_by_uid','decided_at'))
    ))
  ) OR EXISTS (SELECT FROM pg_namespace n, aclexplode(n.nspacl) a WHERE a.grantee = writer_oid AND NOT (n.nspname = 'public' AND a.privilege_type = 'USAGE'))
    OR EXISTS (SELECT FROM pg_proc p, aclexplode(p.proacl) a WHERE a.grantee = writer_oid)
    OR EXISTS (SELECT FROM pg_type t, aclexplode(t.typacl) a WHERE a.grantee = writer_oid)
    OR EXISTS (SELECT FROM pg_default_acl d, aclexplode(d.defaclacl) a WHERE a.grantee = writer_oid)
    OR EXISTS (SELECT FROM pg_database d, aclexplode(d.datacl) a WHERE a.grantee = writer_oid AND NOT (d.datname = current_database() AND a.privilege_type = 'CONNECT'))
  THEN RAISE EXCEPTION 'catalog writer has unexpected direct privileges'; END IF;
END $$;
ALTER ROLE beerpassport_catalog_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM beerpassport_catalog_writer;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM beerpassport_catalog_writer;
GRANT USAGE ON SCHEMA public TO beerpassport_catalog_writer;
GRANT SELECT ON beers, breweries, categories, styles, collection_beers TO beerpassport_catalog_writer;
GRANT UPDATE (name, brewery_id, cat_id, style_id, abv, ibu, srm, upc, descript, discontinued, last_mod, archived_at, search_vector) ON beers TO beerpassport_catalog_writer;
GRANT UPDATE (name, address1, address2, city, state, code, country, phone, website, descript, last_mod, archived_at) ON breweries TO beerpassport_catalog_writer;
GRANT UPDATE (cat_name, last_mod, archived_at) ON categories TO beerpassport_catalog_writer;
GRANT UPDATE (style_name, cat_id, last_mod, archived_at) ON styles TO beerpassport_catalog_writer;
GRANT SELECT, INSERT ON catalog_change_requests TO beerpassport_catalog_writer;
GRANT UPDATE (status, after_hash, reviewed_by_uid, decided_at) ON catalog_change_requests TO beerpassport_catalog_writer;
GRANT SELECT, INSERT ON catalog_change_events TO beerpassport_catalog_writer;
GRANT USAGE ON SEQUENCE catalog_change_requests_id_seq, catalog_change_events_id_seq TO beerpassport_catalog_writer;
COMMIT;
