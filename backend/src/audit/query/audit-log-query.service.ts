import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { PermissionName } from "../../rbac/rbac.constants";
import { COLD_STORAGE_ADAPTER, type ColdStorageAdapterPort } from "../retention/cold-storage-adapter.port";
import { ColdStorageManifestRepository } from "../retention/cold-storage-manifest.repository";
import type { AuditLogEntry, AuditLogPage } from "./audit-log-query.repository";
import { AuditLogQueryRepository } from "./audit-log-query.repository";
import type { AuditLogQueryDto } from "./dto/audit-log-query.dto";

const DEFAULT_PAGE_LIMIT = 100;

export interface AuditLogCallerContext {
  tenantId: string;
  actorId: string;
  permissions: string[];
}

/**
 * WO-047's RBAC scoping decision layer, sitting ABOVE RbacGuard's own
 * gate (which only proves the caller holds view_org OR view_team — see
 * @RequireAnyPermission on AuditLogController). This resolves WHICH of
 * the two the caller actually has, and for view_team-only callers
 * (team_lead), narrows the query to their own team's members' actor_ids
 * — the audit_events table itself has no team_id column, so this is
 * done by resolving team membership first, then filtering by actor_id,
 * rather than a join the schema doesn't support.
 */
@Injectable()
export class AuditLogQueryService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly repository: AuditLogQueryRepository,
    @Inject(COLD_STORAGE_ADAPTER) private readonly coldStorage: ColdStorageAdapterPort,
    private readonly manifestRepository: ColdStorageManifestRepository,
  ) {}

  async query(caller: AuditLogCallerContext, dto: AuditLogQueryDto, client?: PoolClient): Promise<AuditLogPage & { restrictedToTeamScope: boolean; coldStorageQueried: boolean }> {
    const restrictToActorIds = caller.permissions.includes(PermissionName.AUDIT_LOGS_VIEW_ORG) ? undefined : await this.resolveTeamMemberActorIds(caller.tenantId, caller.actorId, client);
    const startTime = new Date(dto.startTime);
    const endTime = new Date(dto.endTime);
    const limit = dto.limit ?? DEFAULT_PAGE_LIMIT;

    const filters = {
      tenantId: caller.tenantId,
      startTime,
      endTime,
      actorId: dto.actorId,
      action: dto.action,
      resourceType: dto.resourceType,
      resourceId: dto.resourceId,
      dataClassification: dto.dataClassification,
      correlationId: dto.correlationId,
      restrictToActorIds,
    };

    const page = await this.repository.findByFilters(filters, limit, dto.cursor ?? null, client);

    if (!dto.cold_storage) {
      return { ...page, restrictedToTeamScope: restrictToActorIds !== undefined, coldStorageQueried: false };
    }

    // Query federation (WO-049): merge hot-storage results with any
    // cold-tiered archives whose period overlaps the requested range. This
    // is a single-shot merge, not incrementally keyset-paginated across
    // both sources — a request with cold_storage=true always re-scans
    // every overlapping archive and returns at most `limit` merged rows
    // for THIS call; dto.cursor only ever continues the hot-storage side.
    // See AUDIT_RETENTION.md for why: cold storage in this sandbox is a
    // flat NDJSON archive per partition (no index to seek into), so true
    // cross-source keyset pagination would need a real columnar/indexed
    // cold store (Parquet + Athena in production) this environment
    // doesn't have.
    const coldEntries = await this.queryColdStorage(filters);
    const merged = [...page.entries, ...coldEntries].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : a.id < b.id ? 1 : -1)).slice(0, limit);

    return { entries: merged, nextCursor: page.nextCursor, restrictedToTeamScope: restrictToActorIds !== undefined, coldStorageQueried: true };
  }

  private async queryColdStorage(filters: {
    tenantId: string;
    startTime: Date;
    endTime: Date;
    actorId?: string;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    dataClassification?: string;
    correlationId?: string;
    restrictToActorIds?: string[];
  }): Promise<AuditLogEntry[]> {
    const manifests = await this.manifestRepository.findOverlappingUnpurged(filters.startTime, filters.endTime);
    const entries: AuditLogEntry[] = [];

    for (const manifest of manifests) {
      for await (const row of this.coldStorage.readArchive(manifest.storageKey)) {
        if (row.tenant_id !== filters.tenantId) continue;
        const occurredAt = new Date(row.occurred_at as string);
        if (occurredAt < filters.startTime || occurredAt > filters.endTime) continue;
        if (filters.actorId && row.actor_id !== filters.actorId) continue;
        if (filters.action && row.action !== filters.action) continue;
        if (filters.resourceType && row.resource_type !== filters.resourceType) continue;
        if (filters.resourceId && row.resource_id !== filters.resourceId) continue;
        if (filters.dataClassification && row.data_classification !== filters.dataClassification) continue;
        if (filters.correlationId && (row.details as Record<string, unknown> | null)?.correlation_id !== filters.correlationId) continue;
        if (filters.restrictToActorIds && !filters.restrictToActorIds.includes(row.actor_id as string)) continue;

        entries.push({
          id: row.id as string,
          actorId: (row.actor_id as string) ?? null,
          action: row.action as string,
          resourceType: row.resource_type as string,
          resourceId: (row.resource_id as string) ?? null,
          dataClassification: row.data_classification as string,
          details: (row.details as Record<string, unknown>) ?? {},
          occurredAt,
          recordHash: row.record_hash as string,
        });
      }
    }
    return entries;
  }

  /** All user ids belonging to any team the caller themselves belongs to — a team_lead's "team scope" is every member of their own team(s), not just themselves. */
  private async resolveTeamMemberActorIds(tenantId: string, callerActorId: string, client?: PoolClient): Promise<string[]> {
    const executor = client ?? this.pool;
    const teamIds = await executor.query("SELECT team_id FROM team_members WHERE tenant_id = $1 AND user_id = $2", [tenantId, callerActorId]);
    if (teamIds.rows.length === 0) return [callerActorId]; // not on any team: scoped to just their own actions

    const memberIds = await executor.query(
      "SELECT DISTINCT user_id FROM team_members WHERE tenant_id = $1 AND team_id = ANY($2)",
      [tenantId, teamIds.rows.map((r: { team_id: string }) => r.team_id)],
    );
    return memberIds.rows.map((r: { user_id: string }) => r.user_id);
  }
}
