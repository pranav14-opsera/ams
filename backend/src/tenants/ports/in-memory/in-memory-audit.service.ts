import { Injectable } from "@nestjs/common";
import type { AuditEventInput, AuditServicePort } from "../audit-service.port";

@Injectable()
export class InMemoryAuditService implements AuditServicePort {
  readonly events: AuditEventInput[] = [];

  async recordEvent(event: AuditEventInput): Promise<void> {
    this.events.push(event);
  }
}
