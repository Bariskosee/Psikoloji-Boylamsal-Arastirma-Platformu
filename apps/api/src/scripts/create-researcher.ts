import "../config/load-env.js";
import { createInterface } from "node:readline/promises";
import { hash, Algorithm } from "@node-rs/argon2";
import { createDatabase, createPool, researcherUsers } from "@lpr/db";
import { checkPassword } from "@lpr/domain";
import { MIN_PASSWORD_LENGTH, researcherEmailSchema } from "@lpr/contracts";
import { loadEnv } from "../config/env.js";

/**
 * Creates the first researcher account.
 *
 * Phase 2 deliberately has NO registration endpoint. Self-service signup on a
 * platform that holds psychological research data would mean anyone who finds
 * the dashboard can create an account and start a study; accounts are created
 * by whoever administers the deployment, deliberately.
 *
 * Run (after `pnpm build`):
 *   pnpm --filter=@lpr/api researcher:create -- --email a@b.org --name "Ada L."
 *
 * The password is read from stdin, never from an argument: a password in argv
 * is visible in `ps`, in shell history, and in process logs.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const emailResult = researcherEmailSchema.safeParse(args["email"]);
  if (!emailResult.success) {
    fail("--email is required and must be a valid address");
  }
  const email = emailResult.data;
  const displayName = args["name"]?.trim();
  if (!displayName) fail('--name is required, e.g. --name "Ada Lovelace"');

  const isAdmin = args["admin"] === "true" || "admin" in args;
  const locale = args["locale"] === "tr" ? "tr" : "en";

  const password = await readPassword();
  const policy = checkPassword(password, email);
  if (!policy.ok) {
    fail(
      `Password rejected: ${policy.reasons.join(", ")}\n` +
        `Minimum length is ${MIN_PASSWORD_LENGTH}; a passphrase of several words is ideal.`,
    );
  }

  const pool = createPool({ connectionString: loadEnv().DATABASE_URL, max: 1 });
  const db = createDatabase(pool);

  try {
    const passwordHash = await hash(password, {
      algorithm: Algorithm.Argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    const inserted = await db
      .insert(researcherUsers)
      .values({ email, passwordHash, displayName, isAdmin, locale })
      .returning({ id: researcherUsers.id });

    // The id, never the hash. A convenience script is exactly where a
    // credential ends up pasted into a chat log.
    console.log(`Created researcher ${email} (${inserted[0]?.id})${isAdmin ? " [admin]" : ""}`);
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: string }).code === "23505") {
      fail(`An account already exists for ${email}`);
    }
    throw error;
  } finally {
    await pool.end();
  }
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env["RESEARCHER_PASSWORD"];
  // Supported for provisioning scripts and tests; interactive use should not
  // put a password in the environment either, but that is the operator's call.
  if (fromEnv) return fromEnv;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question("Password (input is visible): ")).trim();
  } finally {
    rl.close();
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = "true";
    }
  }
  return args;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
