#!/bin/sh
# Runs only while the official PostgreSQL image initialises a fresh data
# volume. The runtime application credential is deliberately not the bootstrap
# superuser used for migrations and backups.
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${APP_DATABASE_USER:?APP_DATABASE_USER is required}"
: "${APP_DATABASE_PASSWORD:?APP_DATABASE_PASSWORD is required}"

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=app_user="$APP_DATABASE_USER" \
  --set=app_password="$APP_DATABASE_PASSWORD" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_readwrite') THEN
    CREATE ROLE app_readwrite NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_analytics') THEN
    CREATE ROLE app_analytics NOLOGIN;
  END IF;
END
$$;

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  :'app_user', :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec

-- Re-running the bootstrap against a restored empty volume is safe and also
-- makes the configured password authoritative.
SELECT format(
  'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  :'app_user', :'app_password'
)
\gexec

SELECT format('GRANT app_readwrite, app_analytics TO %I', :'app_user')
\gexec

-- The worker owns and migrates pg-boss. Pre-creating this one infrastructure
-- schema lets it do so without granting CREATE on the whole database.
SELECT format('CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION %I', :'app_user')
\gexec
SELECT format('ALTER SCHEMA pgboss OWNER TO %I', :'app_user')
\gexec
SQL
