-- ── Role membership for the application's login user (NFR-03) ───────────────
--
-- `app_readwrite` and `app_analytics` are NOLOGIN group roles created in
-- migration 0000. Nothing ever granted MEMBERSHIP of them to the user the
-- application actually connects as, which worked locally only because the
-- development user owns the database and can assume any role it owns.
--
-- On a managed provider the application user is not a superuser, and the
-- consequence is not subtle: `createAnalyticsPool` puts `-c role=app_analytics`
-- in the connection's STARTUP packet, so without membership the connection is
-- refused outright rather than degrading. Every analytics screen — monitoring,
-- the participant list, distributions, export — would fail on a fresh
-- production database, with an error that names neither the role nor the
-- grant.
--
-- Granted to CURRENT_USER, which is whoever runs the migration: on Render that
-- is the same user the services connect as, and in CI and locally it is the
-- development user. Naming a role here instead would hard-code a provider's
-- username into the schema.
--
-- This does NOT weaken the boundary. NFR-03 is enforced by which privileges
-- each ROLE holds — `app_analytics` still has no grant of any kind on
-- `identity` — not by the login user being unable to assume it. Being able to
-- `SET ROLE` to a role that cannot read `identity` is exactly the mechanism.
DO $$
BEGIN
  IF NOT pg_has_role(CURRENT_USER, 'app_readwrite', 'MEMBER') THEN
    EXECUTE format('GRANT app_readwrite TO %I', CURRENT_USER);
  END IF;

  IF NOT pg_has_role(CURRENT_USER, 'app_analytics', 'MEMBER') THEN
    EXECUTE format('GRANT app_analytics TO %I', CURRENT_USER);
  END IF;
END
$$;
