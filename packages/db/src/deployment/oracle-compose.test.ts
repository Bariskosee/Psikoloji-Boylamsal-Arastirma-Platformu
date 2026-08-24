import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = resolve(__dirname, "..", "..", "..", "..");

interface Service {
  build?: { context?: string };
  image?: string;
  mem_limit?: string;
  networks?: string[];
  restart?: string;
  ports?: string[];
  volumes?: string[];
  depends_on?: Record<string, { condition?: string }>;
  environment?: Record<string, string>;
  healthcheck?: { test?: string[] };
}

interface OracleCompose {
  services: Record<string, Service>;
}

const compose = parse(
  readFileSync(resolve(ROOT, "infrastructure", "oracle", "docker-compose.production.yml"), "utf8"),
) as OracleCompose;
const queueBootstrap = readFileSync(
  resolve(ROOT, "infrastructure", "oracle", "queue-bootstrap.cjs"),
  "utf8",
);
const composeScript = readFileSync(resolve(ROOT, "infrastructure", "oracle", "compose.sh"), "utf8");
const verifyScript = readFileSync(resolve(ROOT, "infrastructure", "oracle", "verify.sh"), "utf8");
const caddyfile = readFileSync(resolve(ROOT, "infrastructure", "oracle", "Caddyfile"), "utf8");
const environmentTemplate = readFileSync(
  resolve(ROOT, "infrastructure", "oracle", ".env.production.example"),
  "utf8",
);
const dockerIgnore = readFileSync(resolve(ROOT, ".dockerignore"), "utf8");

describe("the Oracle single-VM deployment", () => {
  it("waits for TCP-ready PostgreSQL and a successful migration", () => {
    expect(compose.services.postgres?.healthcheck?.test?.join(" ")).toContain(
      "pg_isready -h 127.0.0.1",
    );

    for (const name of ["api", "worker"]) {
      expect(compose.services[name]?.depends_on?.migrate?.condition).toBe(
        "service_completed_successfully",
      );
      expect(compose.services[name]?.depends_on?.["queue-migrate"]?.condition).toBe(
        "service_completed_successfully",
      );
    }
  });

  it("keeps PostgreSQL and application ports off the host", () => {
    for (const [name, service] of Object.entries(compose.services)) {
      if (name === "proxy") continue;
      expect(service.ports, `${name} must not publish a host port`).toBeUndefined();
    }
    expect(compose.services.proxy?.ports).toEqual(["80:80", "443:443"]);
  });

  it("resolves build and bind paths from the Compose file directory", () => {
    expect(composeScript).not.toContain("--project-directory");
    for (const name of ["migrate", "api", "queue-migrate", "worker", "participant", "researcher"]) {
      expect(compose.services[name]?.build?.context).toBe("../..");
    }
    expect(compose.services.postgres?.volumes).toContain("./initdb:/docker-entrypoint-initdb.d:ro");
    expect(compose.services["queue-migrate"]?.volumes).toContain(
      "./queue-bootstrap.cjs:/app/queue-bootstrap.cjs:ro",
    );
    expect(compose.services.proxy?.volumes).toContain("./Caddyfile:/etc/caddy/Caddyfile:ro");
    expect(dockerIgnore).toContain(".env.*");
    expect(dockerIgnore).toContain("**/node_modules");
  });

  it("separates runtime and migration database credentials", () => {
    for (const name of ["api", "worker"]) {
      expect(compose.services[name]?.environment?.DATABASE_URL).toContain(
        "${APP_DATABASE_USER}:${APP_DATABASE_PASSWORD}",
      );
      expect(compose.services[name]?.environment?.DATABASE_URL).not.toContain(
        "${POSTGRES_USER}:${POSTGRES_PASSWORD}",
      );
    }

    expect(compose.services.migrate?.environment?.DATABASE_URL).toContain(
      "${POSTGRES_USER}:${POSTGRES_PASSWORD}",
    );
    expect(compose.services["queue-migrate"]?.environment?.DATABASE_URL).toContain(
      "${APP_DATABASE_USER}:${APP_DATABASE_PASSWORD}",
    );
    expect(queueBootstrap).toContain("getConstructionPlans");
    expect(queueBootstrap).toContain("runtime login must have CREATE only inside");
    expect(queueBootstrap).not.toContain("GRANT CREATE ON DATABASE");
  });

  it("checks worker freshness through the database package public API", () => {
    const probe = compose.services.worker?.healthcheck?.test?.join(" ") ?? "";
    expect(probe).toContain("require('@lpr/db')");
    expect(probe).toContain("research.system_heartbeats");
    expect(probe).not.toContain("require('pg')");
  });

  it("verifies current worker and pg-boss state without relying on startup logs", () => {
    expect(verifyScript).toContain("worker_id = :'worker_id'");
    expect(verifyScript).toContain("maintained_on > now() - interval '5 minutes'");
    expect(verifyScript).not.toContain("logs --no-color --since");
    expect(verifyScript).not.toContain("pg-boss connected as queue owner");
  });

  it("derives the expected migration count from the repository journal", () => {
    expect(verifyScript).toContain("packages/db/migrations/meta/_journal.json");
    expect(verifyScript).toContain('entries = journal.get("entries")');
    expect(verifyScript).toContain("print(len(entries))");
    expect(verifyScript).toContain("(:expected_migrations)::integer");
    expect(verifyScript).not.toMatch(/count\(\*\)\s*=\s*\d+/);
  });

  it("keeps every long-running service alive across a reboot", () => {
    for (const name of ["postgres", "api", "worker", "participant", "researcher", "proxy"]) {
      expect(compose.services[name]?.restart).toBe("unless-stopped");
    }
    expect(compose.services.migrate?.restart).toBe("no");
    expect(compose.services["queue-migrate"]?.restart).toBe("no");
  });

  it("keeps frontends off the PostgreSQL data network and makes one-shots self-contained", () => {
    expect(compose.services.postgres?.networks).toEqual(["data"]);
    expect(compose.services.participant?.networks).toEqual(["web"]);
    expect(compose.services.researcher?.networks).toEqual(["web"]);
    expect(compose.services.proxy?.networks).toEqual(["web"]);
    expect(compose.services.api?.networks).toEqual(["web", "data"]);
    expect(compose.services.worker?.networks).toEqual(["web", "data"]);
    expect(compose.services.migrate?.image).toBe("lpr-oracle-api:latest");
    expect(compose.services.migrate?.mem_limit).toBe("640m");
    expect(compose.services["queue-migrate"]?.image).toBe("lpr-oracle-worker:latest");
    expect(compose.services["queue-migrate"]?.build?.context).toBe("../..");
    expect(compose.services["queue-migrate"]?.mem_limit).toBe("384m");
  });

  it("gives Caddy a local liveness probe for bounded host recovery", () => {
    expect(compose.services.proxy?.healthcheck?.test?.join(" ")).toContain(
      "http://127.0.0.1:2019/config/",
    );
  });

  it("configures an explicit ACME contact email", () => {
    expect(caddyfile).toMatch(/\{\s+email \{\$ACME_EMAIL\}\s+\}/);
    expect(compose.services.proxy?.environment?.ACME_EMAIL).toBe("${ACME_EMAIL:?set ACME_EMAIL}");
    expect(environmentTemplate).toContain("ACME_EMAIL=");
  });
});
