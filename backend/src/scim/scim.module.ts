import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AUDIT_SERVICE } from "../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../tenants/ports/postgres/postgres-audit.service";
import { ScimAuthGuard } from "./scim-auth.guard";
import { ScimGroupController } from "./scim-group.controller";
import { ScimGroupService } from "./scim-group.service";
import { ScimTestController } from "./scim-test.controller";
import { ScimTokenController } from "./scim-token.controller";
import { ScimTokenRepository } from "./scim-token.repository";
import { ScimUserController } from "./scim-user.controller";
import { ScimUserService } from "./scim-user.service";

@Module({
  imports: [AuthModule],
  controllers: [ScimTokenController, ScimUserController, ScimGroupController, ScimTestController],
  providers: [
    ScimTokenRepository,
    ScimAuthGuard,
    ScimUserService,
    ScimGroupService,
    { provide: AUDIT_SERVICE, useClass: PostgresAuditService },
  ],
})
export class ScimModule {}
