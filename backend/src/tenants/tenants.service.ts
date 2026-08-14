import { ConflictException, Inject, Injectable, InternalServerErrorException, Logger, NotFoundException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import type { CreateTenantDto } from "./dto/create-tenant.dto";
import { AUDIT_SERVICE, type AuditServicePort } from "./ports/audit-service.port";
import { TenantAlreadyExistsError, TenantProvisioningError, TenantProvisioningSaga } from "./tenant-provisioning.saga";
import { TenantRepository, type Tenant } from "./tenant.repository";

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    // Explicit token, not just the reflected class type: found (WO-015)
    // that a concrete-class constructor param sitting next to interface-
    // typed @Inject'd params can fail to resolve under esbuild-based
    // transpilation (tsx, used by this repo's ad-hoc verification
    // scripts) even though it resolves fine under the real tsc build —
    // an explicit token removes the ambiguity for either toolchain.
    @Inject(TenantProvisioningSaga) private readonly saga: TenantProvisioningSaga,
    private readonly tenantRepository: TenantRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  async create(dto: CreateTenantDto, actorId: string | null): Promise<Tenant> {
    try {
      return await this.saga.provision({
        name: dto.name,
        slug: dto.slug,
        dataResidencyRegion: dto.dataResidencyRegion,
        settings: dto.settings,
        actorId,
      });
    } catch (err) {
      if (err instanceof TenantAlreadyExistsError) {
        throw new ConflictException(err.message);
      }
      if (err instanceof TenantProvisioningError) {
        // The client only ever sees the correlationId — the underlying
        // cause is logged server-side so an operator can actually
        // diagnose what failed without exposing internals in the response.
        this.logger.error(`tenant provisioning failed [${err.correlationId}]: ${err.cause instanceof Error ? err.cause.stack : err.cause}`);
        throw new InternalServerErrorException({
          message: err.message,
          correlationId: err.correlationId,
        });
      }
      throw err;
    }
  }

  // Scoped to the requesting user's own tenant — the tenants table has
  // no RLS policy of its own (it IS the tenant dimension, see
  // database/migrations/001_create_tenants.sql), so this check is the
  // enforcement point, not the database.
  async findScoped(id: string, requestingTenantId: string, clientOrPool: PoolClient | Pool = this.pool): Promise<Tenant> {
    if (id !== requestingTenantId) {
      throw new NotFoundException(`Tenant ${id} not found.`);
    }
    const tenant = await this.tenantRepository.findById(clientOrPool, id);
    if (!tenant) {
      throw new NotFoundException(`Tenant ${id} not found.`);
    }
    return tenant;
  }

  async updateSettingsScoped(
    id: string,
    requestingTenantId: string,
    settings: Record<string, unknown>,
    actorId: string | null,
    client: PoolClient,
  ): Promise<Tenant> {
    const existing = await this.findScoped(id, requestingTenantId, client);

    const updated = await this.tenantRepository.updateSettings(client, id, settings);
    if (!updated) {
      throw new NotFoundException(`Tenant ${id} not found.`);
    }

    await this.auditService.recordEvent(
      {
        tenantId: id,
        actorId,
        action: "tenant.settings_updated",
        resourceType: "tenant",
        resourceId: id,
        details: { previousSettings: existing.settings, newSettings: settings },
      },
      client,
    );

    return updated;
  }
}
