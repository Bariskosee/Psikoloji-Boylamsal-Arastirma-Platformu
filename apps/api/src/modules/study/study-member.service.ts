import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, ne } from "drizzle-orm";
import { researcherUsers, studyMembers, type Database } from "@lpr/db";
import type { ResearcherProfile, StudyMemberResponse, StudyRole } from "@lpr/contracts";
import { ApiErrors } from "../../common/api-error.js";
import { DATABASE } from "../database/database.module.js";
import { AuditService } from "../audit/audit.service.js";
import type { RequestContext } from "../auth/session.service.js";
import { isUniqueViolation } from "./study.service.js";

/**
 * Study membership management — OWNER only (STRUCTURE.md §12).
 *
 * Every method takes `studyId` and puts it in the WHERE clause. There is no
 * "find the member by id, then check the study matches" path anywhere here,
 * because that shape is how a member id from study A ends up being edited
 * through study B's endpoint (NFR-04).
 */
@Injectable()
export class StudyMemberService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(studyId: string): Promise<StudyMemberResponse[]> {
    const rows = await this.db
      .select({
        userId: studyMembers.userId,
        role: studyMembers.role,
        createdAt: studyMembers.createdAt,
        email: researcherUsers.email,
        displayName: researcherUsers.displayName,
      })
      .from(studyMembers)
      .innerJoin(researcherUsers, eq(researcherUsers.id, studyMembers.userId))
      .where(eq(studyMembers.studyId, studyId))
      .orderBy(studyMembers.createdAt);

    return rows.map((row) => ({
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
      role: row.role as StudyRole,
      addedAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Add an existing researcher to a study.
   *
   * Phase 2 has no invitation email — that is Phase 12 — so the person must
   * already hold an account. An unknown email returns NOT_FOUND rather than
   * silently creating a shell account, which would be an unauthenticated way
   * to make rows in the identity schema.
   */
  async add(
    actor: ResearcherProfile,
    studyId: string,
    email: string,
    role: StudyRole,
    now: Date,
    context: RequestContext,
  ): Promise<StudyMemberResponse> {
    const users = await this.db
      .select({
        id: researcherUsers.id,
        email: researcherUsers.email,
        displayName: researcherUsers.displayName,
      })
      .from(researcherUsers)
      .where(and(eq(researcherUsers.email, email), eq(researcherUsers.isActive, true)))
      .limit(1);

    const user = users[0];
    if (!user) throw ApiErrors.notFound("Researcher account");

    try {
      const inserted = await this.db
        .insert(studyMembers)
        .values({
          studyId,
          userId: user.id,
          role,
          addedBy: actor.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const member = inserted[0];
      if (!member) throw ApiErrors.conflict("Could not add the member");

      await this.audit.record({
        actorType: "RESEARCHER",
        actorId: actor.id,
        actorLabel: actor.email,
        studyId,
        action: "study.member.added",
        entityType: "study_member",
        entityId: user.id,
        metadata: { role, memberEmail: user.email },
        context,
        occurredAt: now,
      });

      return {
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        role,
        addedAt: member.createdAt.toISOString(),
      };
    } catch (error) {
      if (isUniqueViolation(error, "study_members_study_user_key")) {
        throw ApiErrors.conflict("That researcher is already a member of this study");
      }
      throw error;
    }
  }

  async changeRole(
    actor: ResearcherProfile,
    studyId: string,
    userId: string,
    role: StudyRole,
    now: Date,
    context: RequestContext,
  ): Promise<StudyMemberResponse> {
    const existing = await this.findMember(studyId, userId);

    if (existing.role === "OWNER" && role !== "OWNER") {
      await this.assertNotLastOwner(studyId, userId);
    }

    await this.db
      .update(studyMembers)
      .set({ role })
      .where(and(eq(studyMembers.studyId, studyId), eq(studyMembers.userId, userId)));

    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: actor.id,
      actorLabel: actor.email,
      studyId,
      action: "study.member.role.changed",
      entityType: "study_member",
      entityId: userId,
      metadata: { from: existing.role, to: role, memberEmail: existing.email },
      context,
      occurredAt: now,
    });

    return { ...existing, role };
  }

  async remove(
    actor: ResearcherProfile,
    studyId: string,
    userId: string,
    now: Date,
    context: RequestContext,
  ): Promise<void> {
    const existing = await this.findMember(studyId, userId);
    if (existing.role === "OWNER") await this.assertNotLastOwner(studyId, userId);

    await this.db
      .delete(studyMembers)
      .where(and(eq(studyMembers.studyId, studyId), eq(studyMembers.userId, userId)));

    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: actor.id,
      actorLabel: actor.email,
      studyId,
      action: "study.member.removed",
      entityType: "study_member",
      entityId: userId,
      metadata: { role: existing.role, memberEmail: existing.email },
      context,
      occurredAt: now,
    });
  }

  private async findMember(studyId: string, userId: string): Promise<StudyMemberResponse> {
    const rows = await this.db
      .select({
        userId: studyMembers.userId,
        role: studyMembers.role,
        createdAt: studyMembers.createdAt,
        email: researcherUsers.email,
        displayName: researcherUsers.displayName,
      })
      .from(studyMembers)
      .innerJoin(researcherUsers, eq(researcherUsers.id, studyMembers.userId))
      .where(and(eq(studyMembers.studyId, studyId), eq(studyMembers.userId, userId)))
      .limit(1);

    const row = rows[0];
    if (!row) throw ApiErrors.notFound("Study member");

    return {
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
      role: row.role as StudyRole,
      addedAt: row.createdAt.toISOString(),
    };
  }

  /**
   * A study must always keep at least one OWNER.
   *
   * Without this, an owner could demote or remove themselves and leave a study
   * nobody can administer — no member management, no lifecycle changes, no
   * audit access — recoverable only by direct database surgery.
   */
  private async assertNotLastOwner(studyId: string, excludingUserId: string): Promise<void> {
    const rows = await this.db
      .select({ remaining: count() })
      .from(studyMembers)
      .where(
        and(
          eq(studyMembers.studyId, studyId),
          eq(studyMembers.role, "OWNER"),
          ne(studyMembers.userId, excludingUserId),
        ),
      );

    if ((rows[0]?.remaining ?? 0) === 0) throw ApiErrors.lastOwnerRequired();
  }
}
