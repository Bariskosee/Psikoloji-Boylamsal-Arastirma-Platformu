import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "./schema/index.js";

/**
 * The typed query interface.
 *
 * Drizzle is constructed over the SAME `pg.Pool` the health probe uses, so
 * there is one connection pool per process per role rather than a second,
 * invisible one. The role is a property of the pool's connection string
 * (ADR-003): an analytics pool built from `DATABASE_ANALYTICS_URL` produces a
 * `Database` that the server cannot use to read `identity`, whatever the query
 * says.
 */
export type Database = NodePgDatabase<typeof schema>;

export function createDatabase(pool: Pool): Database {
  return drizzle(pool, { schema });
}

export { schema };
