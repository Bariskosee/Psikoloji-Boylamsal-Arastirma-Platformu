/**
 * The deploy-time migration entrypoint.
 *
 * ── Why this exists rather than `drizzle-kit migrate` ───────────────────────
 * The deployment blueprint used to run `pnpm --filter=@lpr/db migrate:up`,
 * which is the drizzle-kit CLI — and `drizzle-kit` is a devDependency. A host
 * that prunes dev dependencies for the runtime environment (which is the norm
 * when `NODE_ENV=production`) leaves the pre-deploy command with no binary to
 * run, and the deploy fails at the one step that must not fail halfway.
 *
 * `drizzle-orm/node-postgres/migrator` is part of `drizzle-orm`, which IS a
 * production dependency, and it reads the same `migrations/` folder and the
 * same `drizzle.__drizzle_migrations` ledger that the CLI writes. So this is
 * the same migration, applied by a library that is guaranteed to be installed.
 *
 * ── Why it is a file rather than an inline command ──────────────────────────
 * STRUCTURE.md §7 has always described a "migration entrypoint" in
 * `infrastructure/`; there was never one. A file can be run identically from a
 * deploy hook, from a shell on the host during an incident, and from a test —
 * which is what makes the restore drill and `outage-recovery.md` executable
 * rather than aspirational.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * The folder holding the SQL and the journal.
 *
 * Resolved from this module rather than from `process.cwd()`: a deploy hook
 * runs from the repository root, an operator runs it from anywhere, and
 * guessing wrong means "0 migrations applied" reported as success.
 *
 * `__dirname` rather than `import.meta`: the backend compiles to CommonJS
 * (`packages/config/tsconfig.node.json`), which NestJS's decorator metadata
 * requires.
 */
const MIGRATIONS = resolve(__dirname, "..", "migrations");

/**
 * The two group roles NFR-03 is built on, and what it takes to create them.
 *
 * Migration 0000 issues `CREATE ROLE app_readwrite NOLOGIN` — which PostgreSQL
 * permits only to a role holding CREATEROLE. A managed provider hands you a
 * user that owns the database and often does NOT have it, so the very first
 * migration fails on the very first deploy with `Only roles with the CREATEROLE
 * attribute may create roles` — an error that names neither the migration nor
 * the remedy.
 *
 * Checked up front so the deploy stops with an instruction instead of a
 * stack trace. Not worked around: the two roles are how NFR-03 is enforced
 * technically rather than by convention, and an application that quietly ran
 * without them would have no analytics boundary at all.
 */
const REQUIRED_ROLES = ["app_readwrite", "app_analytics"] as const;

async function assertCanCreateRoles(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ missing: string[]; can_create: boolean }>(
    `SELECT
       array(
         SELECT r FROM unnest($1::text[]) AS r
          WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
       ) AS missing,
       (SELECT rolcreaterole FROM pg_roles WHERE rolname = CURRENT_USER) AS can_create`,
    [REQUIRED_ROLES],
  );

  const state = rows[0];
  if (state === undefined || state.missing.length === 0 || state.can_create) return;

  const sql = state.missing.map((role) => `CREATE ROLE ${role} NOLOGIN;`).join("\n  ");
  throw new Error(
    `Cannot create the role(s) ${state.missing.join(", ")}: this database user ` +
      "does not have CREATEROLE.\n\n" +
      "These are the NOLOGIN group roles that enforce the analytics boundary " +
      "(NFR-03). They must exist before the first migration. Ask whoever " +
      "administers the database to run, once:\n\n  " +
      sql +
      `\n  GRANT ${REQUIRED_ROLES.join(", ")} TO CURRENT_USER;\n\n` +
      "Then run this command again. See docs/runbooks/first-deploy.md.",
  );
}

export async function runMigrations(connectionString: string): Promise<number> {
  const journal = JSON.parse(
    readFileSync(resolve(MIGRATIONS, "meta", "_journal.json"), "utf8"),
  ) as { entries: unknown[] };

  /**
   * One connection, and `max: 1`.
   *
   * Migrations take locks. A pool that opens a second connection midway can
   * deadlock against the migration it is already running, and the failure mode
   * is a deploy that hangs rather than one that errors.
   */
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await assertCanCreateRoles(pool);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
    return journal.entries.length;
  } finally {
    await pool.end();
  }
}

/**
 * Run when invoked directly, stay silent when imported.
 *
 * Exits non-zero on failure so a deploy hook stops rather than promoting a
 * release whose schema never arrived — a half-migrated database that the
 * application then starts against is the worst of the available outcomes.
 */
if (require.main === module) {
  const connectionString = process.env["DATABASE_URL"];
  if (connectionString === undefined || connectionString === "") {
    console.error("DATABASE_URL is required to run migrations.");
    process.exit(1);
  }

  runMigrations(connectionString)
    .then((count) => {
      console.log(`migrations up to date (${String(count)} in the journal)`);
    })
    .catch((error: unknown) => {
      console.error("migration failed:", error);
      process.exit(1);
    });
}
