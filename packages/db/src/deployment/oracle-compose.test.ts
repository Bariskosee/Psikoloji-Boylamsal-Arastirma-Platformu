import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = resolve(__dirname, "..", "..", "..", "..");

interface Service {
  build?: { context?: string };
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
    for (const name of ["migrate", "api", "worker", "participant", "researcher"]) {
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

  it("keeps every long-running service alive across a reboot", () => {
    for (const name of ["postgres", "api", "worker", "participant", "researcher", "proxy"]) {
      expect(compose.services[name]?.restart).toBe("unless-stopped");
    }
    expect(compose.services.migrate?.restart).toBe("no");
    expect(compose.services["queue-migrate"]?.restart).toBe("no");
  });
});
