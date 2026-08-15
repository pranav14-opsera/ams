import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuditExportJob } from "./audit-export-job.repository";
import { AuditExportJobRepository } from "./audit-export-job.repository";
import { AuditExportWorkerService } from "./audit-export-worker.service";
import type { CreateAuditExportDto } from "./dto/create-audit-export.dto";

const MAX_CONCURRENT_EXPORTS_PER_TENANT = 5; // AC: "checks concurrent export limit (max 5 per tenant)"

@Injectable()
export class AuditExportService {
  private readonly logger = new Logger(AuditExportService.name);

  constructor(
    private readonly jobRepository: AuditExportJobRepository,
    private readonly worker: AuditExportWorkerService,
  ) {}

  async requestExport(tenantId: string, requestedBy: string, dto: CreateAuditExportDto, client?: PoolClient): Promise<AuditExportJob> {
    const activeCount = await this.jobRepository.countActive(tenantId, client);
    if (activeCount >= MAX_CONCURRENT_EXPORTS_PER_TENANT) {
      throw new BadRequestException(`This tenant already has ${activeCount} export(s) pending or processing — the maximum concurrent limit is ${MAX_CONCURRENT_EXPORTS_PER_TENANT}.`);
    }

    const job = await this.jobRepository.create(tenantId, requestedBy, { ...dto }, client);

    // Fire-and-forget: the worker runs OUTSIDE this request's lifecycle
    // (see AuditExportWorkerService's own doc comment for why it can't
    // reuse this request's client) — the controller returns 202 with the
    // job id immediately, per this WO's own AC.
    this.worker
      .run(
        job.id,
        {
          tenantId,
          startTime: new Date(dto.startTime),
          endTime: new Date(dto.endTime),
          actorId: dto.actorId,
          action: dto.action,
          resourceType: dto.resourceType,
          resourceId: dto.resourceId,
          dataClassification: dto.dataClassification,
          correlationId: dto.correlationId,
        },
        requestedBy,
      )
      .catch((err) => this.logger.error(`unhandled error running export job ${job.id}: ${err instanceof Error ? err.message : err}`));

    return job;
  }

  async getJob(tenantId: string, jobId: string, client?: PoolClient): Promise<AuditExportJob | null> {
    return this.jobRepository.findById(tenantId, jobId, client);
  }
}
