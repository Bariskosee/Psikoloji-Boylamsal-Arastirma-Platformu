import { Inject, Injectable } from "@nestjs/common";
import { ping, type Pool } from "@lpr/db";
import {
  healthResponseSchema,
  readyResponseSchema,
  type HealthResponse,
  type ReadyResponse,
} from "@lpr/contracts";

export const DB_POOL = Symbol("DB_POOL");

const SERVICE_NAME = "api";
const VERSION = process.env["npm_package_version"] ?? "0.0.0";

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  liveness(): HealthResponse {
    // Responses are parsed through the shared schema, not merely typed as it,
    // so a contract drift fails here rather than in a consumer.
    return healthResponseSchema.parse({
      status: "ok",
      service: SERVICE_NAME,
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    });
  }

  async readiness(): Promise<ReadyResponse> {
    const database = await ping(this.pool);

    return readyResponseSchema.parse({
      ready: database.ok,
      service: SERVICE_NAME,
      checks: [
        {
          name: "postgres",
          ok: database.ok,
          latencyMs: database.latencyMs,
          ...(database.error ? { error: database.error } : {}),
        },
      ],
    });
  }
}
