import { IsIn, IsString, MaxLength, ValidateIf } from "class-validator";
import { AGENT_LIFECYCLE_STATUSES, type AgentLifecycleStatus } from "./list-agents-query.dto";
import { JUSTIFICATION_REQUIRED_STATUSES } from "../lifecycle-state-machine";

export class LifecycleTransitionDto {
  @IsIn(AGENT_LIFECYCLE_STATUSES)
  targetStatus!: AgentLifecycleStatus;

  // Required only for the irreversible-ish targets (retired/decommissioned)
  // — @ValidateIf skips this property's decorators entirely for every
  // other target, so it stays genuinely optional there rather than merely
  // "optional but validated if present".
  @ValidateIf((dto: LifecycleTransitionDto) => JUSTIFICATION_REQUIRED_STATUSES.includes(dto.targetStatus))
  @IsString()
  @MaxLength(1000)
  justification?: string;
}
