import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import type { Response } from "express";
import type { HealthResponse, ReadyResponse } from "@lpr/contracts";
// Must be a VALUE import, not `import type`. NestJS resolves constructor
// injection through emitDecoratorMetadata, which needs the class at runtime —
// a type-only import erases it and DI fails at startup.
import { HealthService } from "./health.service.js";
import { Public } from "../auth/decorators/public.decorator.js";

/**
 * Both probes are `@Public()`.
 *
 * Authentication is global and opt-out (see `app.module.ts`), and a probe is
 * the one caller that can never present a session: the orchestrator and the
 * load balancer are not logged in. Behind the guard these return 401, which a
 * probe reads as "not healthy" forever — the process is marked permanently
 * unready while it is in fact serving perfectly. That failure is silent from
 * inside the application, because a 401 looks like a correctly-refused request.
 *
 * Neither route exposes anything a caller could not learn by watching whether
 * the port answers, which is what makes them safe to leave open.
 */
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
  @Public()
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
  @Public()
  @Get("ready")
  async getReady(@Res({ passthrough: true }) res: Response): Promise<ReadyResponse> {
    const result = await this.health.readiness();
    res.status(result.ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}
