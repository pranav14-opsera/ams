import { Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

export interface OnboardingProgress {
  tenantId: string;
  currentStep: number;
  stepData: Record<string, unknown>;
  completedSteps: number[];
  startedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

interface Row {
  tenant_id: string;
  current_step: number;
  step_data: Record<string, unknown>;
  completed_steps: number[];
  started_by: string | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}

function toDomain(row: Row): OnboardingProgress {
  return {
    tenantId: row.tenant_id,
    currentStep: row.current_step,
    stepData: row.step_data,
    completedSteps: row.completed_steps,
    startedBy: row.started_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

@Injectable()
export class OnboardingProgressRepository {
  async findByTenantId(client: Pool | PoolClient, tenantId: string): Promise<OnboardingProgress | null> {
    const result = await client.query<Row>("SELECT * FROM onboarding_progress WHERE tenant_id = $1", [tenantId]);
    return result.rows[0] ? toDomain(result.rows[0]) : null;
  }

  /**
   * Insert-or-merge: `expires_at` is set ONLY on first insert (see the
   * migration's own comment) — a later save must never push it out
   * further, so the UPDATE branch deliberately leaves it untouched.
   */
  async upsert(
    client: Pool | PoolClient,
    tenantId: string,
    actorId: string | null,
    currentStep: number,
    stepData: Record<string, unknown>,
    completedSteps: number[],
  ): Promise<OnboardingProgress> {
    const result = await client.query<Row>(
      `INSERT INTO onboarding_progress (tenant_id, current_step, step_data, completed_steps, started_by)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (tenant_id) DO UPDATE SET
         current_step = $2,
         step_data = onboarding_progress.step_data || $3::jsonb,
         completed_steps = (SELECT ARRAY(SELECT DISTINCT unnest(onboarding_progress.completed_steps || $4) ORDER BY 1)),
         updated_at = now()
       RETURNING *`,
      [tenantId, currentStep, JSON.stringify(stepData), completedSteps, actorId],
    );
    return toDomain(result.rows[0]);
  }

  /** Used by the "restart onboarding" edge case once a session has expired — a fresh row replaces the stale one rather than trying to merge into it. */
  async deleteByTenantId(client: Pool | PoolClient, tenantId: string): Promise<void> {
    await client.query("DELETE FROM onboarding_progress WHERE tenant_id = $1", [tenantId]);
  }
}
