import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { QuestionService } from "./question.service.js";
import { QuestionnaireController } from "./questionnaire.controller.js";
import { QuestionnaireService } from "./questionnaire.service.js";

/**
 * The questionnaire builder (PLAN.md Phase 3).
 *
 * `QuestionnaireService` is exported because Phase 4's protocol steps must
 * resolve a published questionnaire version before a step may reference it.
 * `QuestionService` is not: question and option writes are a builder-internal
 * concern and no other module has any business reaching them.
 */
@Module({
  imports: [AuditModule],
  controllers: [QuestionnaireController],
  providers: [QuestionnaireService, QuestionService],
  exports: [QuestionnaireService],
})
export class QuestionnaireModule {}
