import { Controller, Get, Param, Query } from "@nestjs/common";
import { auditQuerySchema, type AuditListResponse, type AuditQuery } from "@lpr/contracts";
import { ZodBodyPipe } from "../../common/zod-body.pipe.js";
import { RequireStudyPermission } from "../auth/decorators/require-study-permission.decorator.js";
import { StudyAccess } from "../auth/decorators/current-user.decorator.js";
import type { RequestStudyAccess } from "../auth/auth.types.js";
import { AuditService } from "./audit.service.js";

@Controller("api/studies/:studyId/audit")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /**
   * `GET /api/studies/:studyId/audit` — OWNER only (STRUCTURE.md §12).
   *
   * The trail records who did what to a study's data, so reading it is itself
   * a privileged act: it reveals which colleagues opened which records.
   *
   * The study id comes from the guard's verified access, not from the path
   * parameter, so the query cannot be pointed at a study the caller only
   * claimed to belong to.
   */
  @Get()
  @RequireStudyPermission("study:audit:read")
  async list(
    @Param("studyId") _studyId: string,
    @Query(new ZodBodyPipe(auditQuerySchema)) query: AuditQuery,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<AuditListResponse> {
    return this.audit.listForStudy(access.studyId, query.limit, query.cursor);
  }
}
