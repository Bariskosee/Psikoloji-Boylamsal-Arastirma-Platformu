import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { StudyController } from "./study.controller.js";
import { StudyMemberService } from "./study-member.service.js";
import { StudyService } from "./study.service.js";

@Module({
  imports: [AuditModule],
  controllers: [StudyController],
  providers: [StudyService, StudyMemberService],
  exports: [StudyService],
})
export class StudyModule {}
