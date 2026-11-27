-- Run only on a disposable database or as an explicitly approved production
-- step after the canonical migration. Password supplied out of band.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'beerpassport_admin_access_writer') THEN
    CREATE ROLE beerpassport_admin_access_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5;
  END IF;
  IF EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'beerpassport_admin_access_writer') THEN
    RAISE EXCEPTION 'admin access writer must have no role memberships';
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'beerpassport_admin_access_writer' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'admin access writer has unsafe attributes';
  END IF;
  IF EXISTS (SELECT FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = (SELECT oid FROM pg_roles WHERE rolname = 'beerpassport_admin_access_writer') AND deptype = 'o') THEN
    RAISE EXCEPTION 'admin access writer must not own database objects';
  END IF;
  IF EXISTS (
    SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
      aclexplode(c.relacl) a
    WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'beerpassport_admin_access_writer')
      AND NOT (n.nspname = 'public' AND (
        (c.relname = 'admin_access_grants' AND a.privilege_type IN ('SELECT', 'INSERT', 'DELETE')) OR
        (c.relname = 'admin_access_events' AND a.privilege_type = 'INSERT') OR
        (c.relname = 'admin_access_events_id_seq' AND a.privilege_type = 'USAGE')
      ))
  ) THEN RAISE EXCEPTION 'admin access writer has unexpected direct relation privileges'; END IF;
  IF EXISTS (SELECT FROM pg_namespace n, aclexplode(n.nspacl) a
    WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'beerpassport_admin_access_writer')
      AND NOT (n.nspname = 'public' AND a.privilege_type = 'USAGE'))
    OR EXISTS (SELECT FROM pg_proc p, aclexplode(p.proacl) a WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'beerpassport_admin_access_writer'))
    OR EXISTS (SELECT FROM pg_default_acl d, aclexplode(d.defaclacl) a WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'beerpassport_admin_access_writer'))
    OR EXISTS (SELECT FROM pg_attribute att, aclexplode(att.attacl) a WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'beerpassport_admin_access_writer'))
    OR EXISTS (SELECT FROM pg_type t, aclexplode(t.typacl) a WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'beerpassport_admin_access_writer'))
    OR EXISTS (SELECT FROM pg_database d, aclexplode(d.datacl) a WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'beerpassport_admin_access_writer') AND NOT (d.datname = current_database() AND a.privilege_type = 'CONNECT'))
  THEN RAISE EXCEPTION 'admin access writer has unexpected direct privileges'; END IF;
END $$;
ALTER ROLE beerpassport_admin_access_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM beerpassport_admin_access_writer;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM beerpassport_admin_access_writer;
GRANT USAGE ON SCHEMA public TO beerpassport_admin_access_writer;
GRANT SELECT, INSERT, DELETE ON admin_access_grants TO beerpassport_admin_access_writer;
GRANT INSERT ON admin_access_events TO beerpassport_admin_access_writer;
GRANT USAGE ON SEQUENCE admin_access_events_id_seq TO beerpassport_admin_access_writer;
COMMIT;
