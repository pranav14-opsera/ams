import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { AUDIT_SERVICE } from "../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../tenants/ports/postgres/postgres-audit.service";
import { RbacController } from "./rbac.controller";
import { RbacDefinitionService } from "./rbac-definition.service";
import { RbacForbiddenExceptionFilter } from "./rbac-forbidden-exception.filter";
import { RbacGuard } from "./rbac.guard";
import { RbacMatrixCacheService } from "./rbac-matrix-cache.service";
import { TeamMembershipRepository } from "./team-membership.repository";

@Module({
  controllers: [RbacController],
  providers: [
    RbacDefinitionService,
    RbacMatrixCacheService,
    TeamMembershipRepository,
    { provide: AUDIT_SERVICE, useClass: PostgresAuditService },
    // Global: every route in the app goes through RbacGuard (deny-by-default,
    // OWASP A01) and has its ForbiddenExceptions checked by this filter.
    { provide: APP_GUARD, useClass: RbacGuard },
    { provide: APP_FILTER, useClass: RbacForbiddenExceptionFilter },
  ],
  exports: [RbacDefinitionService, RbacMatrixCacheService, TeamMembershipRepository],
})
export class RbacModule {}
