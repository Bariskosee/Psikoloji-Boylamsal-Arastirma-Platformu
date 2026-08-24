"use strict";
/* global console, process, require */

// pg-boss's first-install plan contains CREATE SCHEMA IF NOT EXISTS. PostgreSQL
// requires database-level CREATE for that statement even when the deployment
// has already created the pgboss schema. Run the vendor plan as the schema
// owner with only that redundant statement removed; the runtime login keeps no
// CREATE privilege outside the dedicated pgboss schema.
const { createRequire } = require("node:module");
const { ALL_JOB_DEFINITIONS, createJobQueue, createPool } = require("@lpr/db");

const requireFromDatabasePackage = createRequire(require.resolve("@lpr/db"));
const PgBoss = requireFromDatabasePackage("pg-boss");
const SCHEMA_STATEMENT = /CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS\s+pgboss\s*;/gi;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  const appUser = process.env.APP_DATABASE_USER;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  if (!appUser) throw new Error("APP_DATABASE_USER is required");

  const pool = createPool({ connectionString, max: 2 });
  const queue = createJobQueue({
    pool,
    role: "owner",
    definitions: ALL_JOB_DEFINITIONS,
  });

  try {
    const ownership = await pool.query(
      `SELECT
         current_user AS session_user,
         pg_get_userbyid(n.nspowner) AS schema_owner,
         has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
         has_schema_privilege(current_user, 'pgboss', 'CREATE') AS schema_create
       FROM pg_namespace n
       WHERE n.nspname = 'pgboss'`,
    );
    const row = ownership.rows[0];
    if (!row || row.session_user !== appUser || row.schema_owner !== appUser) {
      throw new Error("pgboss schema must be owned by APP_DATABASE_USER");
    }
    if (row.database_create !== false || row.schema_create !== true) {
      throw new Error("runtime login must have CREATE only inside the pgboss schema");
    }

    const installed = await pool.query(
      "SELECT to_regclass('pgboss.version') IS NOT NULL AS installed",
    );
    if (installed.rows[0]?.installed !== true) {
      const plan = PgBoss.getConstructionPlans("pgboss");
      const matches = plan.match(SCHEMA_STATEMENT);
      if (matches?.length !== 1) {
        throw new Error("unexpected pg-boss construction plan; refusing to modify vendor SQL");
      }
      const schemaOwnedPlan = plan.replace(SCHEMA_STATEMENT, "");
      await pool.query(schemaOwnedPlan);
      console.log("pg-boss schema installed by its restricted runtime owner");
    }

    // This also applies any future pg-boss migrations and idempotently creates
    // every declared queue before API or worker processes can start.
    await queue.start(ALL_JOB_DEFINITIONS);
    console.log(`pg-boss is current (${ALL_JOB_DEFINITIONS.length} queue definitions)`);
  } finally {
    await queue.stop({ graceful: true }).catch(() => undefined);
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
