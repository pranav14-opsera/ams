import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { DataClassification } from "../../classification/data-classification.enum";
import { AUDIT_SERVICE, type AuditServicePort } from "../../tenants/ports/audit-service.port";
import { AlertEventRepository } from "../alert-event.repository";
import { FalsePositiveFeedbackRepository } from "./false-positive-feedback.repository";
import type { FalsePositiveFeedback, FeedbackType, PatternFeedbackCounts } from "./alert-suppression.types";

/** AC: one-click confirm/dismiss feedback, recorded immutably and audited. */
@Injectable()
export class AlertFeedbackService {
  constructor(
    private readonly feedbackRepository: FalsePositiveFeedbackRepository,
    private readonly eventRepository: AlertEventRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  async submitFeedback(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    actorId: string | null,
    alertEventId: string,
    feedbackType: FeedbackType,
  ): Promise<FalsePositiveFeedback> {
    const alertEvent = await this.eventRepository.findById(client, tenantId, alertEventId);
    if (!alertEvent) throw new Error(`alert event ${alertEventId} not found for tenant ${tenantId}`);

    const feedback = await this.feedbackRepository.submit(client, tenantId, alertEvent.agentId, alertEventId, alertEvent.metricName, feedbackType, actorId);

    // Best-effort audit — not run in the same transaction as the feedback write (client here may be a plain Pool, not a PoolClient the audit port could share atomicity with).
    await this.auditService
      .recordEvent({
        tenantId,
        actorId,
        action: "alert.feedback_submitted",
        resourceType: "alert_event",
        resourceId: alertEventId,
        details: { feedbackType, agentId: alertEvent.agentId, metricName: alertEvent.metricName },
        dataClassification: DataClassification.INTERNAL,
      })
      .catch(() => undefined);

    return feedback;
  }

  async getPatternFeedback(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, metricName: string, windowDays?: number): Promise<PatternFeedbackCounts> {
    return this.feedbackRepository.getPatternFeedback(client, tenantId, agentId, metricName, windowDays);
  }
}
