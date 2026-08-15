import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";

export interface AuditLogFilters {
  tenantId: string;
  startTime: Date;
  endTime: Date;
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  dataClassification?: string;
  correlationId?: string;
  /** Team-scoped callers (team_lead) are restricted to these actor_ids — resolved by AuditLogQueryService, never by the caller directly. undefined means no team restriction (org-wide access). */
  restrictToActorIds?: string[];
}

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  dataClassification: string;
  details: Record<string, unknown>;
  occurredAt: Date;
  recordHash: string;
}

export interface AuditLogPage {
  entries: AuditLogEntry[];
  /** Opaque keyset cursor for the next page — null when this is the last page. */
  nextCursor: string | null;
}

/**
 * WO-047's read path over WO-045's audit_events table. Uses KEYSET
 * (not OFFSET) pagination on the existing composite index
 * (tenant_id, occurred_at, action, data_classification) — an OFFSET-based
 * page 10,000 query would still have to scan and discard the first
 * 10,000×pageSize rows; keyset pagination seeks directly via the index
 * regardless of how deep into the result set the caller is, which is
 * what actually makes the AC's "<5s for a 12-month/500K+ row span"
 * target achievable.
 */
@Injectable()
export class AuditLogQueryRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findByFilters(filters: AuditLogFilters, limit: number, cursor: string | null, client?: Pool | PoolClient): Promise<AuditLogPage> {
    const executor = client ?? this.pool;
    const { clause, params } = this.buildWhereClause(filters, cursor);

    const result = await executor.query(
      `SELECT id, actor_id, action, resource_type, resource_id, data_classification, details, occurred_at, record_hash
       FROM audit_events
       WHERE ${clause}
       ORDER BY occurred_at DESC, id DESC
       LIMIT $${params.length + 1}`,
      [...params, limit + 1],
    );

    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const entries: AuditLogEntry[] = rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      dataClassification: row.data_classification,
      details: row.details,
      occurredAt: row.occurred_at,
      recordHash: row.record_hash,
    }));

    const nextCursor = hasMore ? this.encodeCursor(rows[rows.length - 1].occurred_at, rows[rows.length - 1].id) : null;
    return { entries, nextCursor };
  }

  async countByFilters(filters: AuditLogFilters, client?: Pool | PoolClient): Promise<number> {
    const executor = client ?? this.pool;
    const { clause, params } = this.buildWhereClause(filters, null);
    const result = await executor.query(`SELECT count(*)::int AS c FROM audit_events WHERE ${clause}`, params);
    return result.rows[0].c;
  }

  /** Streams every matching row (no LIMIT) in occurred_at order — used by the export worker, never by the paginated list endpoint. */
  async *streamByFilters(filters: AuditLogFilters, client: Pool | PoolClient, batchSize = 1000): AsyncGenerator<AuditLogEntry> {
    let cursor: string | null = null;
    for (;;) {
      const page = await this.findByFilters(filters, batchSize, cursor, client);
      for (const entry of page.entries) yield entry;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }

  private buildWhereClause(filters: AuditLogFilters, cursor: string | null): { clause: string; params: unknown[] } {
    const conditions: string[] = ["tenant_id = $1", "occurred_at >= $2", "occurred_at <= $3"];
    const params: unknown[] = [filters.tenantId, filters.startTime.toISOString(), filters.endTime.toISOString()];

    if (filters.actorId) {
      params.push(filters.actorId);
      conditions.push(`actor_id = $${params.length}`);
    }
    if (filters.action) {
      params.push(filters.action);
      conditions.push(`action = $${params.length}`);
    }
    if (filters.resourceType) {
      params.push(filters.resourceType);
      conditions.push(`resource_type = $${params.length}`);
    }
    if (filters.resourceId) {
      params.push(filters.resourceId);
      conditions.push(`resource_id = $${params.length}`);
    }
    if (filters.dataClassification) {
      params.push(filters.dataClassification);
      conditions.push(`data_classification = $${params.length}`);
    }
    if (filters.correlationId) {
      params.push(filters.correlationId);
      conditions.push(`details->>'correlation_id' = $${params.length}`);
    }
    if (filters.restrictToActorIds) {
      params.push(filters.restrictToActorIds);
      conditions.push(`actor_id = ANY($${params.length})`);
    }
    if (cursor) {
      const decoded = this.decodeCursor(cursor);
      params.push(decoded.occurredAt, decoded.id);
      conditions.push(`(occurred_at, id) < ($${params.length - 1}, $${params.length})`);
    }

    return { clause: conditions.join(" AND "), params };
  }

  private encodeCursor(occurredAt: Date, id: string): string {
    return Buffer.from(`${occurredAt.toISOString()}|${id}`).toString("base64url");
  }

  private decodeCursor(cursor: string): { occurredAt: string; id: string } {
    const [occurredAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    return { occurredAt, id };
  }
}
