import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from "class-validator";
import { Transform } from "class-transformer";
import { AGENT_FRAMEWORKS, type AgentFramework } from "../../agents/dto/create-agent.dto";
import { AGENT_LIFECYCLE_STATUSES, type AgentLifecycleStatus } from "../../agents/dto/list-agents-query.dto";
import { AGENT_HEALTH_STATUSES, type AgentHealthStatus } from "../health-status.util";

// Matches list-agents-query.dto.ts's own convention exactly (same
// tsx-run-tests-can't-use-@Type reasoning documented there).
const toNumber = ({ value }: { value: unknown }) => (value === undefined || value === "" ? undefined : Number(value));

export class ListAgentHealthQueryDto {
  @IsOptional()
  @IsUUID()
  teamId?: string;

  @IsOptional()
  @IsIn(AGENT_FRAMEWORKS)
  framework?: AgentFramework;

  @IsOptional()
  @IsIn(AGENT_LIFECYCLE_STATUSES)
  lifecycleStatus?: AgentLifecycleStatus;

  /** Unified health status (computeHealthStatus's output), distinct from the raw lifecycleStatus filter above. */
  @IsOptional()
  @IsIn(AGENT_HEALTH_STATUSES)
  status?: AgentHealthStatus;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  // WO-058: raised from 200 to 1000 — this WO's own scaling target is
  // 500+ concurrent agents per tenant, and HealthMetricsPublisherService
  // fetches the full fleet snapshot for the live WebSocket push (not a
  // paginated REST page), so the cap needs headroom above that target,
  // not just below it.
  @Max(1000)
  limit?: number;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(0)
  offset?: number;
}
