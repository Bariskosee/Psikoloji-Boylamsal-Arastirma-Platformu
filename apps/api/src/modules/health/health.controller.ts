import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import type { Response } from "express";
import type { HealthResponse, ReadyResponse } from "@lpr/contracts";
// Must be a VALUE import, not `import type`. NestJS resolves constructor
// injection through emitDecoratorMetadata, which needs the class at runtime —
// a type-only import erases it and DI fails at startup.
import { HealthService } from "./health.service.js";

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Liveness. The process is up and serving.
   *
   * Deliberately does NOT check dependencies: a liveness probe that fails on a
   * database blip causes the orchestrator to restart a perfectly healthy
   * process, which makes an outage worse rather than better.
   */
  @Get("health")
  getHealth(): HealthResponse {
    return this.health.liveness();
  }

  /**
   * Readiness. Every dependency this process needs is reachable.
   *
   * Returns 503 when not ready so a load balancer drains traffic instead of
   * routing requests that are certain to fail.
   */
  @Get("ready")
  async getReady(@Res({ passthrough: true }) res: Response): Promise<ReadyResponse> {
    const result = await this.health.readiness();
    res.status(result.ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}
