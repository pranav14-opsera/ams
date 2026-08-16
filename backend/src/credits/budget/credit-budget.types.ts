export interface OrganizationCreditPool {
  id: string;
  tenantId: string;
  totalCredits: number;
  effectiveMonth: number;
  effectiveYear: number;
}

export interface CreditBudget {
  id: string;
  tenantId: string;
  teamId: string;
  allocatedCredits: number;
  alertThreshold75: boolean;
  alertThreshold90: boolean;
  hardCap: number | null;
  effectiveMonth: number;
  effectiveYear: number;
  createdBy: string | null;
}

export interface AllocateBudgetRequest {
  teamId: string;
  allocatedCredits: number;
  alertThreshold75: boolean;
  alertThreshold90: boolean;
  hardCap: number | null;
  effectiveMonth: number;
  effectiveYear: number;
  justification: string | null;
}

export interface TeamBudgetSummary {
  teamId: string;
  allocatedCredits: number;
  consumedCredits: number;
  remainingCredits: number;
  consumptionPercentage: number | null;
  alertThreshold75: boolean;
  alertThreshold90: boolean;
  hardCap: number | null;
  effectiveMonth: number;
  effectiveYear: number;
  /** null when there's no meaningful recent consumption trend to project from (e.g. zero usage in the last 30 days). */
  projectedExhaustionDate: string | null;
}
