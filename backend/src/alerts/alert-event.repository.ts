import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import type { AlertEvent, AlertSeverity, DetectionMethod, StatisticalEvidence } from "./alert-threshold.types";

interface AlertEventRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  metric_name: string;
  threshold_value: string;
  actual_value: string;
  severity: AlertSeverity;
  breach_timestamp: Date;
  detection_method: DetectionMethod;
  statistical_evidence: StatisticalEvidence | null;
}

function toDomain(row: AlertEventRow): AlertEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    metricName: row.metric_name,
    thresholdValue: Number(row.threshold_value),
    actualValue: Number(row.actual_value),
    severity: row.severity,
    breachTimestamp: row.breach_timestamp,
    detectionMethod: row.detection_method,
    statisticalEvidence: row.statistical_evidence,
  };
}

/** Immutable — INSERT and SELECT only, no update()/delete() method exists (matches migration 046's own doc comment on alert_events). */
@Injectable()
export class AlertEventRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async create(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    agentId: string,
    fields: {
      metricName: string;
      thresholdValue: number;
      actualValue: number;
      severity: AlertSeverity;
      breachTimestamp: Date;
      detectionMethod?: DetectionMethod;
      statisticalEvidence?: StatisticalEvidence;
    },
  ): Promise<AlertEvent> {
    const executor = client ?? this.pool;
    const result = await executor.query<AlertEventRow>(
      `INSERT INTO alert_events (tenant_id, agent_id, metric_name, threshold_value, actual_value, severity, breach_timestamp, detection_method, statistical_evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        tenantId,
        agentId,
        fields.metricName,
        fields.thresholdValue,
        fields.actualValue,
        fields.severity,
        fields.breachTimestamp,
        fields.detectionMethod ?? "threshold",
        fields.statisticalEvidence ? JSON.stringify(fields.statisticalEvidence) : null,
      ],
    );
    return toDomain(result.rows[0]);
  }

  /** Cooldown check: the most recent alert for this exact agent+metric, or null if none has ever fired. */
  async findMostRecent(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, metricName: string): Promise<AlertEvent | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<AlertEventRow>(
      "SELECT * FROM alert_events WHERE tenant_id = $1 AND agent_id = $2 AND metric_name = $3 ORDER BY breach_timestamp DESC LIMIT 1",
      [tenantId, agentId, metricName],
    );
    return result.rows[0] ? toDomain(result.rows[0]) : null;
  }
}
