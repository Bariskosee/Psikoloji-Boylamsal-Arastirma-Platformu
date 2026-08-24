-- The two NOLOGIN group roles the analytics boundary rests on (NFR-03).
--
-- Migration 0000 creates these too, but `CREATE ROLE` needs the CREATEROLE
-- attribute and a managed provider's user usually lacks it — which is why
-- `docs/runbooks/first-deploy.md` §3 has an operator run them by hand there.
--
-- Self-hosting is the one deployment where this can simply be automated: this
-- script runs as the superuser during first-time initialisation of an empty
-- data directory, before anything else connects.
--
-- Idempotent, because `docker-entrypoint-initdb.d` is skipped entirely on an
-- existing volume and re-run in full on a fresh one — including after a
-- restore drill.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_readwrite') THEN
    CREATE ROLE app_readwrite NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_analytics') THEN
    CREATE ROLE app_analytics NOLOGIN;
  END IF;

  -- The application connects as POSTGRES_USER. Membership is what lets it
  -- `SET ROLE`; the boundary itself is which privileges each role holds, and
  -- `app_analytics` is granted nothing at all on `identity`.
  EXECUTE format('GRANT app_readwrite, app_analytics TO %I', current_user);
END
$$;
