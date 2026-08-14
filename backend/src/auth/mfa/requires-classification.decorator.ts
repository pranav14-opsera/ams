import { SetMetadata } from "@nestjs/common";
import { DataClassification } from "../../classification/data-classification.enum";

export const CLASSIFICATION_METADATA_KEY = "requiresClassification";

/** Route-level metadata declaring the data classification tier (WO-016) of the resource a handler serves — read by MfaStepUpGuard to decide whether MFA elevation is required before allowing the request through. */
export const RequiresClassification = (tier: DataClassification) => SetMetadata(CLASSIFICATION_METADATA_KEY, tier);
