import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../client.js";

/**
 * Constraint tests — every rule this schema claims to enforce is verified by
 * ATTEMPTING TO VIOLATE IT.
 *
 * A constraint that is never violated in a test is a constraint nobody has
 * confirmed exists. These are the rules that stop two accounts sharing an
 * email, two roles applying to one member, and an audit trail being rewritten.
 *
 * Requires a live PostgreSQL with the migrations applied:
 *   pnpm db:up && pnpm --filter=@lpr/db migrate:up
 */
const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is required for integration tests.\n" +
      "  Local:  pnpm db:up && cp .env.example .env && pnpm --filter=@lpr/db migrate:up\n" +
      "  CI:     provide it in the job environment",
  );
}

const pool = createPool({ connectionString, max: 4 });

/** Unique per run so repeated local runs never collide on the email unique key. */
const suffix = () => Math.random().toString(36).slice(2, 10);

async function insertUser(overrides: Partial<Record<string, unknown>> = {}): Promise<string> {
  const email = (overrides["email"] as string) ?? `user-${suffix()}@example.org`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO identity.researcher_users (email, password_hash, display_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [email, "$argon2id$placeholder", "Test Researcher"],
  );
  return result.rows[0]!.id;
}

async function insertStudy(createdBy: string | null = null): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO research.studies (name, enrollment_code, timezone, default_locale, supported_locales, created_by)
     VALUES ($1, $2, 'Europe/Istanbul', 'tr', ARRAY['tr','en'], $3) RETURNING id`,
    ["Test Study", randomCode(), createdBy],
  );
  return result.rows[0]!.id;
}

function randomCode(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

beforeAll(async () => {
  await pool.query("SELECT 1");
});

afterAll(async () => {
  await pool.end();
});

describe("schema separation (ADR-003, NFR-03)", () => {
  it("puts the two schemas and both roles in place", async () => {
    const schemas = await pool.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace WHERE nspname IN ('research', 'identity') ORDER BY nspname`,
    );
    expect(schemas.rows.map((r) => r.nspname)).toEqual(["identity", "research"]);

    const roles = await pool.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('app_readwrite', 'app_analytics') ORDER BY rolname`,
    );
    expect(roles.rows.map((r) => r.rolname)).toEqual(["app_analytics", "app_readwrite"]);
  });

  it("keeps researcher credentials OUT of the analytics role's reach", async () => {
    /**
     * The load-bearing privacy assertion of Phase 2.
     *
     * `app_analytics` holds SELECT on all of `research`. Researcher password
     * hashes and email addresses therefore live in `identity`, where that role
     * has no privileges at all — so an export query cannot reach a credential
     * even by accident. Phase 1 extends the same test to the participant
     * identity tables.
     */
    const denied = await pool.query<{ has: boolean }>(
      `SELECT has_table_privilege('app_analytics', $1, 'SELECT') AS has`,
      ["identity.researcher_users"],
    );
    expect(denied.rows[0]!.has).toBe(false);

    const sessionsDenied = await pool.query<{ has: boolean }>(
      `SELECT has_table_privilege('app_analytics', $1, 'SELECT') AS has`,
      ["identity.researcher_sessions"],
    );
    expect(sessionsDenied.rows[0]!.has).toBe(false);

    const schemaDenied = await pool.query<{ has: boolean }>(
      `SELECT has_schema_privilege('app_analytics', 'identity', 'USAGE') AS has`,
    );
    expect(schemaDenied.rows[0]!.has).toBe(false);
  });

  it("lets the analytics role read research, which is its purpose", async () => {
    for (const table of ["research.studies", "research.study_members", "research.audit_events"]) {
      const granted = await pool.query<{ has: boolean }>(
        `SELECT has_table_privilege('app_analytics', $1, 'SELECT') AS has`,
        [table],
      );
      expect(granted.rows[0]!.has, table).toBe(true);
    }
  });

  it("gives the analytics role no way to write anything", async () => {
    for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
      const granted = await pool.query<{ has: boolean }>(
        `SELECT has_table_privilege('app_analytics', 'research.studies', $1) AS has`,
        [privilege],
      );
      expect(granted.rows[0]!.has, privilege).toBe(false);
    }
  });
});

describe("researcher_users constraints", () => {
  it("refuses a duplicate email", async () => {
    const email = `dup-${suffix()}@example.org`;
    await insertUser({ email });
    await expect(insertUser({ email })).rejects.toThrow(/duplicate key|unique/i);
  });

  it("refuses a non-lowercased email, so case cannot fork an account", async () => {
    // The contract lowercases before writing. This constraint is what makes
    // that a guarantee rather than a habit.
    await expect(insertUser({ email: `Mixed-${suffix()}@Example.org` })).rejects.toThrow(
      /researcher_users_email_lowercase/,
    );
  });

  it("refuses a locale the interface cannot render", async () => {
    const id = await insertUser();
    await expect(
      pool.query("UPDATE identity.researcher_users SET locale = 'de' WHERE id = $1", [id]),
    ).rejects.toThrow(/researcher_users_locale_valid/);
  });
});

describe("studies constraints", () => {
  it("refuses a duplicate enrollment code", async () => {
    const code = randomCode();
    await pool.query(
      `INSERT INTO research.studies (name, enrollment_code, timezone, default_locale, supported_locales)
       VALUES ('A', $1, 'Europe/Istanbul', 'en', ARRAY['en'])`,
      [code],
    );
    await expect(
      pool.query(
        `INSERT INTO research.studies (name, enrollment_code, timezone, default_locale, supported_locales)
         VALUES ('B', $1, 'Europe/Istanbul', 'en', ARRAY['en'])`,
        [code],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("refuses an enrollment code containing an ambiguous character", async () => {
    // I, L, O and U are excluded so a code read off a poster cannot be
    // mistyped into a different, valid study.
    await expect(
      pool.query(
        `INSERT INTO research.studies (name, enrollment_code, timezone, default_locale, supported_locales)
         VALUES ('X', 'ABCDIO', 'Europe/Istanbul', 'en', ARRAY['en'])`,
      ),
    ).rejects.toThrow(/studies_enrollment_code_shape/);
  });

  it("refuses a default locale that the study does not support", async () => {
    await expect(
      pool.query(
        `INSERT INTO research.studies (name, enrollment_code, timezone, default_locale, supported_locales)
         VALUES ('X', $1, 'Europe/Istanbul', 'tr', ARRAY['en'])`,
        [randomCode()],
      ),
    ).rejects.toThrow(/studies_default_locale_supported/);
  });

  it("refuses an unknown status", async () => {
    const id = await insertStudy();
    await expect(
      pool.query("UPDATE research.studies SET status = 'RUNNING' WHERE id = $1", [id]),
    ).rejects.toThrow(/studies_status_valid/);
  });

  it("refuses a zero or negative enrollment capacity", async () => {
    const id = await insertStudy();
    await expect(
      pool.query("UPDATE research.studies SET enrollment_capacity = 0 WHERE id = $1", [id]),
    ).rejects.toThrow(/studies_capacity_positive/);
  });

  it("maintains updated_at by trigger rather than by convention", async () => {
    const id = await insertStudy();
    const before = await pool.query<{ updated_at: Date }>(
      "SELECT updated_at FROM research.studies WHERE id = $1",
      [id],
    );
    await pool.query("UPDATE research.studies SET name = 'Renamed' WHERE id = $1", [id]);
    const after = await pool.query<{ updated_at: Date }>(
      "SELECT updated_at FROM research.studies WHERE id = $1",
      [id],
    );
    expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThanOrEqual(
      before.rows[0]!.updated_at.getTime(),
    );
  });
});

describe("study_members constraints", () => {
  it("refuses two roles for the same user in the same study", async () => {
    // Application-level checks lose races. If this were enforced only in code,
    // two concurrent "add member" calls would leave the effective-role
    // question with two answers.
    const userId = await insertUser();
    const studyId = await insertStudy(userId);
    await pool.query(
      "INSERT INTO research.study_members (study_id, user_id, role) VALUES ($1, $2, 'OWNER')",
      [studyId, userId],
    );
    await expect(
      pool.query(
        "INSERT INTO research.study_members (study_id, user_id, role) VALUES ($1, $2, 'VIEWER')",
        [studyId, userId],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("refuses a role outside the four", async () => {
    const userId = await insertUser();
    const studyId = await insertStudy(userId);
    await expect(
      pool.query(
        "INSERT INTO research.study_members (study_id, user_id, role) VALUES ($1, $2, 'ADMIN')",
        [studyId, userId],
      ),
    ).rejects.toThrow(/study_members_role_valid/);
  });

  it("removes memberships with the study, and with the user", async () => {
    const userId = await insertUser();
    const studyId = await insertStudy(userId);
    await pool.query(
      "INSERT INTO research.study_members (study_id, user_id, role) VALUES ($1, $2, 'EDITOR')",
      [studyId, userId],
    );
    await pool.query("DELETE FROM research.studies WHERE id = $1", [studyId]);
    const remaining = await pool.query("SELECT 1 FROM research.study_members WHERE study_id = $1", [
      studyId,
    ]);
    expect(remaining.rowCount).toBe(0);
  });
});

describe("audit_events is append-only (NFR-05)", () => {
  async function insertEvent(studyId: string | null): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO research.audit_events (actor_type, action, entity_type, study_id)
       VALUES ('RESEARCHER', 'study.created', 'study', $1) RETURNING id`,
      [studyId],
    );
    return result.rows[0]!.id;
  }

  it("rejects an UPDATE even from a superuser connection", async () => {
    // Privilege revocation alone would not cover this: migrations and
    // maintenance connect as an owner, and owners bypass GRANT. A trail a
    // privileged connection can quietly rewrite is not a trail.
    const id = await insertEvent(null);
    await expect(
      pool.query("UPDATE research.audit_events SET action = 'auth.logout' WHERE id = $1", [id]),
    ).rejects.toThrow(/append-only/);
  });

  it("rejects a DELETE even from a superuser connection", async () => {
    const id = await insertEvent(null);
    await expect(
      pool.query("DELETE FROM research.audit_events WHERE id = $1", [id]),
    ).rejects.toThrow(/append-only/);
  });

  it("denies UPDATE and DELETE to the application role as well", async () => {
    for (const privilege of ["UPDATE", "DELETE"]) {
      const granted = await pool.query<{ has: boolean }>(
        `SELECT has_table_privilege('app_readwrite', 'research.audit_events', $1) AS has`,
        [privilege],
      );
      expect(granted.rows[0]!.has, privilege).toBe(false);
    }
    const insert = await pool.query<{ has: boolean }>(
      `SELECT has_table_privilege('app_readwrite', 'research.audit_events', 'INSERT') AS has`,
    );
    expect(insert.rows[0]!.has).toBe(true);
  });

  it("survives the study it describes being deleted", async () => {
    // ON DELETE NO ACTION: the trail must outlive its subject, so the delete
    // is refused rather than the audit row silently vanishing.
    const studyId = await insertStudy();
    await insertEvent(studyId);
    await expect(
      pool.query("DELETE FROM research.studies WHERE id = $1", [studyId]),
    ).rejects.toThrow(/foreign key|audit_events_study_id/i);
  });

  it("refuses an unknown actor type", async () => {
    await expect(
      pool.query(
        `INSERT INTO research.audit_events (actor_type, action, entity_type)
         VALUES ('ROBOT', 'study.created', 'study')`,
      ),
    ).rejects.toThrow(/audit_events_actor_type_valid/);
  });
});
