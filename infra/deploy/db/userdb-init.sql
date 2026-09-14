-- =================================================================
--  userdb-init.sql — one-time lockdown of the customer data cluster
--  -----------------------------------------------------------------
--  Runs once, on an empty data directory, before any tenant exists.
--
--  Postgres ships with PUBLIC able to connect to the maintenance
--  databases. Left alone, a tenant role could connect to `postgres`
--  instead of its own database and work from there — read the catalogs,
--  create objects in a shared schema, and generally stand somewhere it
--  was never meant to stand. Its own database being locked down would
--  not matter, because it never needed to go there.
--
--  Per-tenant grants live in src/dbproviders/builtin.js. This file is
--  only the things that are true for the whole cluster.
-- =================================================================

REVOKE CONNECT ON DATABASE postgres  FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;

-- A new database is cloned from template1, so revoking here means every
-- tenant database is created with a locked public schema rather than
-- being fixed up afterwards. Doing it at creation time removes the window
-- where a database exists with the default permissive grant.
\connect template1
REVOKE ALL ON SCHEMA public FROM PUBLIC;
