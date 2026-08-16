export const CREDIT_ALERT_THRESHOLD_LEVELS = [75, 90] as const;
export type CreditAlertThresholdLevel = (typeof CREDIT_ALERT_THRESHOLD_LEVELS)[number];

export interface CreditAlert {
  id: string;
  tenantId: string;
  teamId: string;
  thresholdLevel: CreditAlertThresholdLevel;
  consumptionPercentage: number;
  effectiveMonth: number;
  effectiveYear: number;
  generatedAt: Date;
}

export interface CreditAlertPayload {
  teamId: string;
  teamName: string;
  thresholdLevel: CreditAlertThresholdLevel;
  allocatedCredits: number;
  consumedCredits: number;
  remainingCredits: number;
  consumptionPercentage: number;
  projectedExhaustionDate: string | null;
  recommendedAction: string;
}
