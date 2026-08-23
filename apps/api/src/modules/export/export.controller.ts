import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { ApiErrors } from "../../common/api-error.js";
import { ClockService } from "../../common/core.module.js";
import { CurrentUser } from "../auth/decorators/current-user.decorator.js";
import { RequireStudyPermission } from "../auth/decorators/require-study-permission.decorator.js";
import { RateLimitService } from "../auth/rate-limit.service.js";
import { AuditService } from "../audit/audit.service.js";
import { ExportService, type ExportResult } from "./export.service.js";

/**
 * Data export (PLAN.md Phase 11, `docs/export-codebook.md` §6).
 *
 * Four files, each streamed: `long.csv`, `wide.csv`, `codebook.csv`, and
 * `steps.csv`. Long is authoritative; the other three exist so that a recipient
 * holding only these files can interpret and reproduce the dataset without
 * access to the platform.
 *
 * ── Three controls, all required by §6 ──────────────────────────────────────
 * ANALYST and above, because an export is every psychological answer in the
 * study. Rate limited, because it is the most expensive thing a researcher can
 * ask for and the easiest to trigger by holding a key down. And audited with
 * the row count and scope, because "who took a copy of this dataset, and when"
 * is a question an ethics board will eventually ask.
 */
@Controller("api/studies/:studyId/exports")
export class ExportController {
  constructor(
    private readonly exports: ExportService,
    private readonly audit: AuditService,
    private readonly rateLimits: RateLimitService,
    private readonly clock: ClockService,
  ) {}

  @Get("long.csv")
  @RequireStudyPermission("export:run")
  async long(
    @Param("studyId") studyId: string,
    @CurrentUser() user: { id: string; email: string },
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    this.limit(user.id);
    await this.stream(this.exports.longFormat({ studyId }), "long.csv", {
      studyId,
      user,
      request,
      response,
      format: "long",
    });
  }

  @Get("wide.csv")
  @RequireStudyPermission("export:run")
  async wide(
    @Param("studyId") studyId: string,
    @CurrentUser() user: { id: string; email: string },
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    this.limit(user.id);
    await this.stream(await this.exports.wideFormat({ studyId }), "wide.csv", {
      studyId,
      user,
      request,
      response,
      format: "wide",
    });
  }

  @Get("codebook.csv")
  @RequireStudyPermission("export:run")
  async codebook(
    @Param("studyId") studyId: string,
    @CurrentUser() user: { id: string; email: string },
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    this.limit(user.id);
    await this.stream(await this.exports.codebook({ studyId }), "codebook.csv", {
      studyId,
      user,
      request,
      response,
      format: "codebook",
    });
  }

  @Get("steps.csv")
  @RequireStudyPermission("export:run")
  async steps(
    @Param("studyId") studyId: string,
    @CurrentUser() user: { id: string; email: string },
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    this.limit(user.id);
    await this.stream(await this.exports.steps({ studyId }), "steps.csv", {
      studyId,
      user,
      request,
      response,
      format: "steps",
    });
  }

  /**
   * Write the generator to the response, then audit what was written.
   *
   * ── Why the audit row is written with the real count, before `end()` ───────
   * "An export happened" is worth less than "an export of 41 208 rows
   * happened". The count is only known once the generator is exhausted, so the
   * row cannot be written up front — writing it before would record an intent
   * rather than a fact, and an export that failed halfway would look identical
   * to one that succeeded.
   *
   * But it must land BEFORE `response.end()`, not after. Ending the response
   * first tells the client the export is complete while the audit row is still
   * an unresolved promise: a process that dies in that window has handed over
   * the entire dataset with no record that it did. "Who took a copy of this
   * study's data" is a question an ethics board will ask, and the honest answer
   * cannot depend on the process surviving the last few milliseconds.
   *
   * The gap was found by an intermittently failing test that read the audit
   * table immediately after the response and sometimes found nothing — which
   * was not a flaky test but an accurate report of this race.
   *
   * ── Why headers are sent before the first row ──────────────────────────────
   * `Content-Length` is deliberately absent: the length is unknown until the
   * last row, and buffering to compute it would defeat the streaming this whole
   * service is built around. `Transfer-Encoding: chunked` is what the absence
   * gets us, and every HTTP client understands it.
   */
  private async stream(
    result: ExportResult,
    filename: string,
    context: {
      studyId: string;
      user: { id: string; email: string };
      request: Request;
      response: Response;
      format: string;
    },
  ): Promise<void> {
    const { response, studyId, format } = context;

    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    // The file is a snapshot of live data; a cached copy would be a silently
    // stale dataset, which is worse than a slow download.
    response.setHeader("Cache-Control", "no-store");

    for await (const chunk of result.rows) {
      // Respect backpressure. Without this, a fast database and a slow client
      // buffer the entire study in the Node process — the exact failure the
      // cursor exists to avoid.
      if (!response.write(chunk)) {
        await new Promise<void>((resolve) => response.once("drain", resolve));
      }
    }

    /**
     * Audited before the response is closed, and failure here does not fail the
     * export: the bytes are already on the wire, so throwing would break a
     * download that has in fact succeeded. It is logged loudly instead, because
     * an unaudited export is a compliance problem that somebody must find out
     * about — just not by having the researcher's download truncated.
     */
    try {
      await this.recordExport(context, result.rowCount());
    } catch (error) {
      console.error("export.audit_failed", { studyId, format, error });
    }

    response.end();
  }

  private async recordExport(
    context: {
      studyId: string;
      user: { id: string; email: string };
      request: Request;
      format: string;
    },
    rowCount: number,
  ): Promise<void> {
    const { studyId, user, request, format } = context;
    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: user.id,
      actorLabel: user.email,
      studyId,
      action: "export.run",
      entityType: "export",
      entityId: null,
      // Scope and volume, never content. An audit trail must not become a
      // second copy of the data it exists to protect.
      metadata: { format, rowCount, scope: "study" },
      context: { ip: request.ip, userAgent: request.headers["user-agent"] },
      occurredAt: this.clock.now(),
    });
  }

  /**
   * Ten exports per hour per user (STRUCTURE.md §11.5).
   *
   * Per user rather than per IP: a research team behind one institutional
   * address shares an IP, and an IP budget would let one person's afternoon of
   * downloads lock out their colleagues.
   */
  private limit(userId: string): void {
    const decision = this.rateLimits.hit(
      `export:${userId}`,
      10,
      60 * 60 * 1000,
      this.clock.now().getTime(),
    );
    if (!decision.allowed) throw ApiErrors.rateLimited(decision.retryAfterSeconds);
  }
}
