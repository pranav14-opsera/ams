import { IsIn } from "class-validator";
import { FEEDBACK_TYPES, type FeedbackType } from "../alert-suppression.types";

export class SubmitFeedbackDto {
  @IsIn(FEEDBACK_TYPES)
  feedbackType!: FeedbackType;
}
