import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Logger, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { AlertThresholdService } from "../alerts/alert-threshold.service";
import { CalibrationService } from "../anomaly-detection/calibration.service";
import { QualityScoreService } from "../quality-score/quality-score.service";
import { PermissionName } from "../rbac/rbac.constants";
import { RequirePermission } from "../rbac/require-permission.decorator";
import { AgentsService } from "./agents.service";
import { BulkLifecycleService } from "./bulk-lifecycle.service";
import { ConnectionValidationService } from "./connection-validation.service";
import { CreateAgentDto } from "./dto/create-agent.dto";
import { BulkLifecycleDto } from "./dto/bulk-lifecycle.dto";
import { LifecycleTransitionDto } from "./dto/lifecycle-transition.dto";
import { ListAgentsQueryDto } from "./dto/list-agents-query.dto";
import { UpdateAgentDto } from "./dto/update-agent.dto";
import { LifecycleService } from "./lifecycle.service";

@Controller("api/v1/agents")
export class AgentsController {
  private readonly logger = new Logger(AgentsController.name);

  constructor(
    private readonly agentsService: AgentsService,
    private readonly lifecycleService: LifecycleService,
    private readonly bulkLifecycleService: BulkLifecycleService,
    private readonly alertThresholdService: AlertThresholdService,
    private readonly calibrationService: CalibrationService,
    private readonly qualityScoreService: QualityScoreService,
    private readonly connectionValidationService: ConnectionValidationService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(PermissionName.AGENT_CREATE)
  async create(@Body() dto: CreateAgentDto, @Req() req: Request) {
    const agent = await this.agentsService.create(req.tenantDbClient, req.tenantId!, req.actorId ?? null, dto);
    // AC: default thresholds auto-applied to newly registered agents.
    // Awaited (so they genuinely exist by the time this response
    // returns, not racing it) but never lets a threshold-creation
    // failure fail agent registration itself — same "side-effect never
    // blocks the primary operation" convention as this codebase's
    // audit/metrics recording elsewhere.
    try {
      await this.alertThresholdService.applyDefaultThresholds(req.tenantDbClient, req.tenantId!, agent.id);
    } catch (err) {
      this.logger.warn(`failed to apply default alert thresholds for agent ${agent.id}: ${err instanceof Error ? err.message : err}`);
    }
    // WO-061 AC: calibration starts on agent registration — same best-effort, never-blocks-registration posture as the threshold defaults above.
    try {
      await this.calibrationService.startCalibration(req.tenantDbClient, req.tenantId!, agent.id);
    } catch (err) {
      this.logger.warn(`failed to start anomaly-detection calibration for agent ${agent.id}: ${err instanceof Error ? err.message : err}`);
    }
    // WO-063 AC: quality-score baseline calibration starts on agent registration — same best-effort, never-blocks-registration posture as the two try/catch blocks above.
    try {
      await this.qualityScoreService.startCalibration(req.tenantDbClient, req.tenantId!, agent.id);
    } catch (err) {
      this.logger.warn(`failed to start quality-score calibration for agent ${agent.id}: ${err instanceof Error ? err.message : err}`);
    }
    // WO-080 AC: "connection validation... completes within 60 seconds
    // with real-time progress feedback" — deliberately NOT awaited (this
    // route's own AC 10 needs the response itself within 5 seconds,
    // regardless of how long the target endpoint takes to answer). The
    // wizard's Step 4 polls GET /api/v1/agents/{id} to observe the
    // outcome this records. Same fire-and-forget `.catch()` convention as
    // AdapterHealthSchedulerService's own health-probe tick.
    this.connectionValidationService
      .validate(req.tenantId!, req.actorId ?? null, agent.id, dto.framework, dto.connectionConfig)
      .catch((err) => this.logger.warn(`connection validation failed to run for agent ${agent.id}: ${err instanceof Error ? err.message : err}`));
    return agent;
  }

  @Get()
  @RequirePermission(PermissionName.AGENT_READ)
  async findAll(@Query() query: ListAgentsQueryDto, @Req() req: Request) {
    const result = await this.agentsService.findAll(req.tenantDbClient, req.tenantId!, query, req.actorId ?? null);
    // WO-079's Agent Registry page api_contract: { data, pagination: { page, pageSize, total, totalPages } }.
    // Reshaped at the controller boundary only — AgentsService/AgentsRepository keep their
    // existing { agents, total, limit, offset } shape (other callers, e.g. bulk-lifecycle's
    // filter resolution, and this codebase's own service-level tests, depend on it).
    const page = Math.floor(result.offset / result.limit) + 1;
    return {
      data: result.agents,
      pagination: {
        page,
        pageSize: result.limit,
        total: result.total,
        totalPages: Math.ceil(result.total / result.limit),
      },
    };
  }

  @Get(":id")
  @RequirePermission(PermissionName.AGENT_READ)
  async findOne(@Param("id") id: string, @Req() req: Request) {
    return this.agentsService.findOne(req.tenantDbClient, req.tenantId!, id);
  }

  // WO-080 edge_case: "Connection validation timeout/failure... 'Retry'
  // option" — re-runs the same fire-and-forget validation this agent's
  // own creation kicked off, against its already-stored connectionConfig.
  @Post(":id/retry-validation")
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission(PermissionName.AGENT_CREATE)
  async retryValidation(@Param("id") id: string, @Req() req: Request) {
    const { agent, framework, connectionConfig } = await this.agentsService.prepareRetryValidation(req.tenantDbClient, req.tenantId!, id);
    this.connectionValidationService
      .validate(req.tenantId!, req.actorId ?? null, id, framework, connectionConfig)
      .catch((err) => this.logger.warn(`connection validation retry failed to run for agent ${id}: ${err instanceof Error ? err.message : err}`));
    return agent;
  }

  @Patch(":id")
  @RequirePermission(PermissionName.AGENT_UPDATE)
  async update(@Param("id") id: string, @Body() dto: UpdateAgentDto, @Req() req: Request) {
    return this.agentsService.update(req.tenantDbClient, req.tenantId!, req.actorId ?? null, id, dto);
  }

  @Delete(":id")
  @RequirePermission(PermissionName.AGENT_DELETE)
  async remove(@Param("id") id: string, @Req() req: Request) {
    return this.agentsService.remove(req.tenantDbClient, req.tenantId!, req.actorId ?? null, id);
  }

  @Patch(":id/lifecycle")
  @RequirePermission(PermissionName.AGENT_LIFECYCLE_CONTROL)
  async transitionLifecycle(@Param("id") id: string, @Body() dto: LifecycleTransitionDto, @Req() req: Request) {
    const result = await this.lifecycleService.transition(req.tenantDbClient, req.tenantId!, req.actorId ?? null, id, dto.targetStatus, dto.justification);
    return { ...result.agent, warning: result.warning };
  }

  @Post("bulk-lifecycle")
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PermissionName.AGENT_BULK_LIFECYCLE_CONTROL)
  async bulkTransitionLifecycle(@Body() dto: BulkLifecycleDto, @Req() req: Request) {
    return this.bulkLifecycleService.execute(req.tenantDbClient, req.tenantId!, req.actorId ?? null, dto);
  }
}
