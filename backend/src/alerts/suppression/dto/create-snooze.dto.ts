import { IsIn, IsString, IsUUID } from "class-validator";
import { SNOOZE_DURATIONS, type SnoozeDuration } from "../alert-suppression.types";

export class CreateSnoozeDto {
  @IsUUID()
  agentId!: string;

  @IsString()
  metricName!: string;

  @IsIn(SNOOZE_DURATIONS)
  duration!: SnoozeDuration;
}
