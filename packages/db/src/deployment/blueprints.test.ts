import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Staging must stay a mirror of production.
 *
 * ── The failure this prevents ───────────────────────────────────────────────
 * Staging environments do not decay in one step. Somebody adds an environment
 * variable to production because a deploy needs it, staging carries on without
 * it, and six weeks later staging is a different system that happens to run
 * the same code. The next release is then validated against something that
 * does not resemble what it will run on — which is worse than having no
 * staging, because it produces confidence rather than doubt.
 *
 * Structural equality is checked, not values: staging deliberately differs in
 * service names, database plan and sweep interval, and those three exceptions
 * are named below. Everything else — which services exist, which variables
 * each declares, whether the worker is always-on — must match.
 *
 * ── Why it lives in `@lpr/db` ───────────────────────────────────────────────
 * `infrastructure/` has no package of its own, and creating one to hold a
 * single test would be more machinery than the test is worth. `@lpr/db` is
 * where the migration entrypoint the blueprints call already lives.
 */
const ROOT = resolve(__dirname, "..", "..", "..", "..");

interface Blueprint {
  databases: { name: string; plan: string; region: string }[];
  services: {
    type: string;
    name: string;
    plan: string;
    region: string;
    envVars: { key: string }[];
    preDeployCommand?: string;
    healthCheckPath?: string;
  }[];
}

function load(file: string): Blueprint {
  return parse(readFileSync(resolve(ROOT, "infrastructure", file), "utf8")) as Blueprint;
}

const production = load("render.yaml");
const staging = load("render.staging.yaml");

/** Names differ by this prefix and nothing else. */
const withoutEnvironment = (name: string) => name.replace("lpr-staging-", "lpr-");

describe("the deployment blueprints", () => {
  it("declare the same services, in the same order", () => {
    expect(staging.services.map((service) => withoutEnvironment(service.name))).toEqual(
      production.services.map((service) => service.name),
    );
  });

  it("declare the same environment variables for every service", () => {
    for (const [index, service] of production.services.entries()) {
      const mirror = staging.services[index];
      expect(mirror?.envVars.map((entry) => entry.key).sort()).toEqual(
        service.envVars.map((entry) => entry.key).sort(),
      );
    }
  });

  /**
   * The single most important line in either file.
   *
   * ADR-005 makes the reconciliation sweepers the correctness guarantee for all
   * scheduling, and ADR-010 calls a spin-down tier "the single most important
   * operational fact about this deployment": the sweepers stop, nothing errors,
   * and sessions quietly stop opening. A staging environment that idles its
   * worker would also hide exactly the bug Phase 13 exists to catch.
   */
  it("keep the worker always-on in both environments", () => {
    for (const blueprint of [production, staging]) {
      const worker = blueprint.services.find((service) => service.type === "worker");
      expect(worker).toBeDefined();
      expect(worker?.plan).not.toBe("free");
    }
  });

  it("run migrations before the API serves traffic, using the runtime migrator", () => {
    for (const blueprint of [production, staging]) {
      const api = blueprint.services.find((service) => service.name.endsWith("-api"));
      // `migrate:up` is the drizzle-kit CLI and is a devDependency; it is absent
      // once dev dependencies are pruned. `migrate:deploy` uses drizzle-orm's
      // own migrator, which is a production dependency.
      expect(api?.preDeployCommand).toContain("migrate:deploy");
      expect(api?.preDeployCommand).not.toContain("migrate:up");
      expect(api?.healthCheckPath).toBe("/ready");
    }
  });

  it("keeps every service in one region, which is the data-residency claim", () => {
    for (const blueprint of [production, staging]) {
      const regions = new Set([
        ...blueprint.databases.map((database) => database.region),
        ...blueprint.services.map((service) => service.region),
      ]);
      expect([...regions]).toEqual(["frankfurt"]);
    }
  });

  /**
   * `PORT` must not be set by the blueprint.
   *
   * Render assigns it. Declaring it here would override the assignment and the
   * health check would fail against a port nothing is listening on — which is
   * how the previous version of this file would have failed its very first
   * deploy, since the API bound `API_PORT` and ignored `PORT` entirely.
   */
  it("never pins a port", () => {
    for (const blueprint of [production, staging]) {
      for (const service of blueprint.services) {
        const keys = service.envVars.map((entry) => entry.key);
        expect(keys).not.toContain("PORT");
        expect(keys).not.toContain("API_PORT");
      }
    }
  });
});
