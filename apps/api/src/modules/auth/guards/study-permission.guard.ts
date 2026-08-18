import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { and, eq } from "drizzle-orm";
import { studies, studyMembers, type Database } from "@lpr/db";
import { can, PERMISSION_MINIMUM_ROLE } from "@lpr/domain";
import type { StudyPermission, StudyRole } from "@lpr/contracts";
import { ApiErrors } from "../../../common/api-error.js";
import { DATABASE } from "../../database/database.module.js";
import { STUDY_PERMISSION_KEY } from "../decorators/require-study-permission.decorator.js";
import type { AuthenticatedRequest } from "../auth.types.js";

/**
 * Study-scoped authorization (NFR-04).
 *
 * The whole of researcher authorization runs through this guard. It does three
 * things, and the order matters:
 *
 * 1. Reads the membership row **with `study_id` and `user_id` both in the
 *    WHERE clause**. NFR-04 is explicit that a study-scoped query must filter
 *    by study in the query itself and never trust a path parameter that was
 *    checked earlier. There is no "load the study, then compare ids" step here
 *    for exactly that reason — that pattern is how a cross-study leak gets
 *    written.
 * 2. Asks @lpr/domain whether the role satisfies the declared permission.
 * 3. On any failure, returns `STUDY_NOT_FOUND`. A member of study A probing
 *    study B must not be able to tell "exists but forbidden" from "does not
 *    exist" — that difference maps the platform's studies for them.
 */
@Injectable()
export class StudyPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<StudyPermission | undefined>(
      STUDY_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    // Routes that declare no permission are not study-scoped.
    if (!permission) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.auth) throw ApiErrors.authenticationRequired();

    const studyId = extractStudyId(request);
    if (!studyId) throw ApiErrors.studyNotFound();

    const rows = await this.db
      .select({ role: studyMembers.role })
      .from(studyMembers)
      .innerJoin(studies, eq(studies.id, studyMembers.studyId))
      .where(and(eq(studyMembers.studyId, studyId), eq(studyMembers.userId, request.auth.user.id)))
      .limit(1);

    const role = rows[0]?.role as StudyRole | undefined;
    if (!role) throw ApiErrors.studyNotFound();

    if (!can(role, permission)) {
      // The caller demonstrably belongs to this study, so naming the required
      // role tells them nothing they could not already infer, and makes the
      // failure actionable ("ask an OWNER") instead of mystifying.
      throw ApiErrors.studyRoleRequired(PERMISSION_MINIMUM_ROLE[permission]);
    }

    request.studyAccess = { studyId, role };
    return true;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads the study id from the path.
 *
 * Validated here rather than in the handler: a malformed id must fail as
 * "not found" before it reaches a query, so a caller cannot use a type error
 * from the database to distinguish a real id from a fabricated one.
 */
function extractStudyId(request: AuthenticatedRequest): string | null {
  const params = request.params as Record<string, string | undefined>;
  const raw = params["studyId"] ?? params["id"];
  if (!raw || !UUID_PATTERN.test(raw)) return null;
  return raw;
}
