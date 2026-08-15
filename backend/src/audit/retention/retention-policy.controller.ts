import { Body, Controller, Get, Post, Put, Req } from "@nestjs/common";
import type { Request } from "express";
import { PermissionName } from "../../rbac/rbac.constants";
import { RequireAnyPermission } from "../../rbac/require-any-permission.decorator";
import { UpsertRetentionPolicyDto } from "./dto/upsert-retention-policy.dto";
import { RetentionPolicyService } from "./retention-policy.service";

// AC: "allowing Compliance Officers to configure retention periods" +
// implementation_steps' "Compliance Officer and Admin only." Neither role
// holds a single shared permission for this (data_retention:policy:manage
// is compliance_officer-exclusive per migration 024), so this uses the
// same @RequireAnyPermission OR-shape WO-047/WO-048 already established
// for "two roles, two different exclusive permissions."
const RETENTION_POLICY_PERMISSIONS = [PermissionName.DATA_RETENTION_POLICY_MANAGE, PermissionName.TENANT_RBAC_MANAGE];

@Controller("api/v1/audit/retention-policies")
export class RetentionPolicyController {
  constructor(private readonly service: RetentionPolicyService) {}

  @Get()
  @RequireAnyPermission(RETENTION_POLICY_PERMISSIONS)
  async list(@Req() req: Request) {
    const policies = await this.service.list(req.tenantId!, req.tenantDbClient);
    return { policies };
  }

  // AC: "POST/PUT ... allowing Compliance Officers to configure retention
  // periods" — both verbs perform the same upsert; PUT is the idempotent
  // "set this category's policy" form, POST is the "create/update" form
  // some clients prefer. No behavioral difference between the two here.
  @Post()
  @RequireAnyPermission(RETENTION_POLICY_PERMISSIONS)
  async create(@Body() dto: UpsertRetentionPolicyDto, @Req() req: Request) {
    const policy = await this.service.upsert(req.tenantId!, dto.dataCategory, dto.retentionDays, req.actorId ?? null, req.tenantDbClient);
    return { policy };
  }

  @Put()
  @RequireAnyPermission(RETENTION_POLICY_PERMISSIONS)
  async update(@Body() dto: UpsertRetentionPolicyDto, @Req() req: Request) {
    const policy = await this.service.upsert(req.tenantId!, dto.dataCategory, dto.retentionDays, req.actorId ?? null, req.tenantDbClient);
    return { policy };
  }
}
