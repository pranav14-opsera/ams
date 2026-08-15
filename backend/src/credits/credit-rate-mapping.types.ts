export interface CreditRateMapping {
  id: string;
  tenantId: string;
  actionType: string;
  creditsPerUnit: number;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
}

export interface TeamCreditLimit {
  id: string;
  tenantId: string;
  teamId: string;
  hardCap: number | null;
}
