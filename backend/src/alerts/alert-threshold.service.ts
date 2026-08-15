import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { DataClassification } from "../classification/data-classification.enum";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import { AlertThresholdRepository } from "./alert-threshold.repository";
import { DEFAULT_THRESHOLDS, type AlertMetricName, type AlertThresholdConfig } from "./alert-threshold.types";
import type { CreateAlertThresholdDto } from "./dto/create-alert-threshold.dto";
import type { UpdateAlertThresholdDto } from "./dto/update-alert-threshold.dto";

const DEFAULT_COOLDOWN_SECONDS = 300;

@Injectable()
export class AlertThresholdService {
  private readonly logger = new Logger(AlertThresholdService.name);

  constructor(
    private readonly repository: AlertThresholdRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  private assertValid(warningThreshold: number, criticalThreshold: number): void {
    if (warningThreshold < 0 || criticalThreshold < 0) throw new BadRequestException("Threshold values must be non-negative.");
    if (warningThreshold >= criticalThreshold) throw new BadRequestException("warningThreshold must be strictly less than criticalThreshold.");
  }

  async create(client: Pool | PoolClient | undefined, tenantId: string, actorId: string | null, dto: CreateAlertThresholdDto): Promise<AlertThresholdConfig> {
    this.assertValid(dto.warningThreshold, dto.criticalThreshold);

    const created = await this.repository.create(client, tenantId, dto.agentId, {
      metricName: dto.metricName,
      warningThreshold: dto.warningThreshold,
      criticalThreshold: dto.criticalThreshold,
      cooldownSeconds: dto.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS,
      createdBy: actorId,
    });

    this.recordAuditEvent(tenantId, actorId, "alert_threshold.created", created.id, dto.agentId, null, created);
    return created;
  }

  async findByAgentId(client: Pool | PoolClient | undefined, tenantId: string, agentId: string): Promise<AlertThresholdConfig[]> {
    return this.repository.findByAgentId(client, tenantId, agentId);
  }

  async update(client: Pool | PoolClient | undefined, tenantId: string, actorId: string | null, id: string, dto: UpdateAlertThresholdDto): Promise<AlertThresholdConfig> {
    const existing = await this.repository.findOne(client, tenantId, id);
    if (!existing) throw new NotFoundException(`Alert threshold ${id} not found.`);

    const nextWarning = dto.warningThreshold ?? existing.warningThreshold;
    const nextCritical = dto.criticalThreshold ?? existing.criticalThreshold;
    this.assertValid(nextWarning, nextCritical);

    const updated = await this.repository.update(client, tenantId, id, dto);
    if (!updated) throw new NotFoundException(`Alert threshold ${id} not found.`);

    this.recordAuditEvent(tenantId, actorId, "alert_threshold.updated", id, existing.agentId, existing, updated);
    return updated;
  }

  async delete(client: Pool | PoolClient | undefined, tenantId: string, actorId: string | null, id: string): Promise<void> {
    const existing = await this.repository.findOne(client, tenantId, id);
    if (!existing) throw new NotFoundException(`Alert threshold ${id} not found.`);

    await this.repository.delete(client, tenantId, id);
    this.recordAuditEvent(tenantId, actorId, "alert_threshold.deleted", id, existing.agentId, existing, null);
  }

  /**
   * AC: default thresholds automatically applied to newly registered
   * agents. Best-effort per metric — a duplicate-key conflict (a caller
   * raced this with their own explicit threshold creation) is swallowed
   * for that one metric rather than aborting the whole batch, since
   * every other metric's default should still apply.
   */
  async applyDefaultThresholds(client: Pool | PoolClient | undefined, tenantId: string, agentId: string): Promise<void> {
    for (const [metricName, { warning, critical }] of Object.entries(DEFAULT_THRESHOLDS) as Array<[AlertMetricName, { warning: number; critical: number }]>) {
      try {
        await this.repository.create(client, tenantId, agentId, { metricName, warningThreshold: warning, criticalThreshold: critical, cooldownSeconds: DEFAULT_COOLDOWN_SECONDS, createdBy: null });
      } catch {
        // Already has a threshold for this metric (explicit or a prior default) — leave it alone.
      }
    }
  }

  private recordAuditEvent(
    tenantId: string,
    actorId: string | null,
    action: string,
    thresholdId: string,
    agentId: string,
    previousValue: AlertThresholdConfig | null,
    newValue: AlertThresholdConfig | null,
  ): void {
    this.auditService
      .recordEvent({
        tenantId,
        actorId,
        action,
        resourceType: "alert_threshold_config",
        resourceId: thresholdId,
        details: { agentId, previousValue, newValue },
        dataClassification: DataClassification.INTERNAL,
      })
      .catch((err) => this.logger.warn(`failed to record ${action} audit event for threshold ${thresholdId}: ${err instanceof Error ? err.message : err}`));
  }
}
