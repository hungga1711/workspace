-- No JIT compilation for this database's sessions. The app's queries are short and planned on every
-- call; Postgres compiles any whose estimated cost passes jit_above_cost, and on reports over tens of thousands of
-- tasks the compile alone took 120+ ms of a 200 ms query (measured: overdue trend 209 ms with JIT, 53 ms without).
-- Set on the database so it holds through PgBouncer (which refuses per-connection options). Only the database's owner
-- may do this: on an installation where someone else owns it (a development database created by the superuser),
-- the setting is skipped with a notice and everything works as before.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET jit = off', current_database());
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'jit left on: % is not owned by %', current_database(), current_user;
END
$$;
