import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertDeliveryService } from "../../src/alerts/alert-delivery.service";
import { InMemoryAuditService } from "../../src/tenants/ports/in-memory/in-memory-audit.service";
import type { AlertEvent } from "../../src/alerts/alert-threshold.types";

function makeAlertEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: "event-1",
    tenantId: "tenant-a",
    agentId: "agent-1",
    metricName: "error_rate",
    thresholdValue: 0.05,
    actualValue: 0.9,
    severity: "critical",
    breachTimestamp: new Date("2026-08-16T00:00:00Z"),
    detectionMethod: "threshold",
    statisticalEvidence: null,
    ...overrides,
  };
}

class FakeWebhookConfigRepository {
  public rows: any[] = [];
  async findByTenantId() {
    return this.rows;
  }
}
class FakeEmailConfigRepository {
  public rows: any[] = [];
  async findByTenantId() {
    return this.rows;
  }
}
class FakeConfigCache {
  public cached: unknown | null = null;
  async get() {
    return this.cached;
  }
  async set(_tenantId: string, value: unknown) {
    this.cached = value;
  }
}
class FakeEncryptionService {
  async decrypt(_tenantId: string, payload: { ciphertext: Buffer }) {
    return payload.ciphertext; // fixtures pass the raw secret as "ciphertext" for simplicity
  }
}
class FakeDeliveryLogRepository {
  public logged: any[] = [];
  public existing = false;
  async existsForAlertEvent() {
    return this.existing;
  }
  async record(_client: unknown, tenantId: string, alertEventId: string, fields: Record<string, unknown>) {
    const row = { tenantId, alertEventId, ...fields };
    this.logged.push(row);
    return row;
  }
}
class FakeChannel {
  public calls: unknown[] = [];
  public result = { status: "sent", latencyMs: 5, errorMessage: null, attemptNumber: 1 };
  async deliver(alertEvent: unknown, config: unknown) {
    this.calls.push({ alertEvent, config });
    return this.result;
  }
}

function buildRig() {
  const webhookConfigRepository = new FakeWebhookConfigRepository();
  const emailConfigRepository = new FakeEmailConfigRepository();
  const configCache = new FakeConfigCache();
  const encryptionService = new FakeEncryptionService();
  const deliveryLogRepository = new FakeDeliveryLogRepository();
  const websocketChannel = new FakeChannel();
  const webhookChannel = new FakeChannel();
  const emailChannel = new FakeChannel();
  const auditService = new InMemoryAuditService();

  const service = new AlertDeliveryService(
    webhookConfigRepository as any,
    emailConfigRepository as any,
    configCache as any,
    encryptionService as any,
    deliveryLogRepository as any,
    websocketChannel as any,
    webhookChannel as any,
    emailChannel as any,
    auditService,
  );

  return { webhookConfigRepository, emailConfigRepository, configCache, deliveryLogRepository, websocketChannel, webhookChannel, emailChannel, auditService, service };
}

test("with zero webhook/email channels configured, only websocket is dispatched", async () => {
  const { websocketChannel, webhookChannel, emailChannel, service } = buildRig();
  await service.deliver(makeAlertEvent());

  assert.equal(websocketChannel.calls.length, 1);
  assert.equal(webhookChannel.calls.length, 0);
  assert.equal(emailChannel.calls.length, 0);
});

test("dispatches to ALL enabled channels in parallel", async () => {
  const { webhookConfigRepository, emailConfigRepository, websocketChannel, webhookChannel, emailChannel, service } = buildRig();
  webhookConfigRepository.rows = [{ id: "wh-1", enabled: true, url: "http://example.com/hook", secret_ciphertext: Buffer.from("secret"), secret_iv: Buffer.alloc(0), secret_auth_tag: Buffer.alloc(0), secret_encrypted_dek: Buffer.alloc(0), secret_key_version: 1 }];
  emailConfigRepository.rows = [{ id: "em-1", enabled: true, recipients: ["ops@example.com"] }];

  await service.deliver(makeAlertEvent());

  assert.equal(websocketChannel.calls.length, 1);
  assert.equal(webhookChannel.calls.length, 1);
  assert.equal(emailChannel.calls.length, 1);
});

test("disabled channel configs are never dispatched to", async () => {
  const { webhookConfigRepository, webhookChannel, service } = buildRig();
  webhookConfigRepository.rows = [{ id: "wh-1", enabled: false, url: "http://example.com/hook", secret_ciphertext: Buffer.from("secret"), secret_iv: Buffer.alloc(0), secret_auth_tag: Buffer.alloc(0), secret_encrypted_dek: Buffer.alloc(0), secret_key_version: 1 }];

  await service.deliver(makeAlertEvent());
  assert.equal(webhookChannel.calls.length, 0);
});

test("idempotency: an alert event that already has delivery log entries is never re-dispatched", async () => {
  const { deliveryLogRepository, websocketChannel, service } = buildRig();
  deliveryLogRepository.existing = true;

  await service.deliver(makeAlertEvent());
  assert.equal(websocketChannel.calls.length, 0, "must not re-dispatch to any channel once delivery has already been attempted for this alert event");
});

test("every channel dispatch is recorded in the delivery log", async () => {
  const { deliveryLogRepository, service } = buildRig();
  await service.deliver(makeAlertEvent());

  assert.equal(deliveryLogRepository.logged.length, 1);
  assert.equal(deliveryLogRepository.logged[0].channelType, "websocket");
  assert.equal(deliveryLogRepository.logged[0].status, "sent");
});

test("every channel dispatch attempt is audit-logged", async () => {
  const { auditService, service } = buildRig();
  await service.deliver(makeAlertEvent());

  assert.equal(auditService.events.length, 1);
  assert.equal(auditService.events[0].action, "alert_delivery.attempted");
  assert.equal((auditService.events[0].details as any).channelType, "websocket");
});

test("channel configs are resolved from cache when present, without querying the repositories", async () => {
  const { webhookConfigRepository, configCache, service } = buildRig();
  configCache.cached = { webhooks: [], emails: [] };
  let queried = false;
  webhookConfigRepository.findByTenantId = async () => {
    queried = true;
    return [];
  };

  await service.deliver(makeAlertEvent());
  assert.equal(queried, false, "a cache hit must skip the repository query entirely");
});

test("one channel's delivery failure does not prevent other channels from being attempted", async () => {
  const { webhookConfigRepository, emailConfigRepository, webhookChannel, emailChannel, service } = buildRig();
  webhookConfigRepository.rows = [{ id: "wh-1", enabled: true, url: "http://example.com/hook", secret_ciphertext: Buffer.from("secret"), secret_iv: Buffer.alloc(0), secret_auth_tag: Buffer.alloc(0), secret_encrypted_dek: Buffer.alloc(0), secret_key_version: 1 }];
  emailConfigRepository.rows = [{ id: "em-1", enabled: true, recipients: ["ops@example.com"] }];
  webhookChannel.deliver = async () => {
    throw new Error("webhook channel exploded");
  };

  await assert.doesNotReject(() => service.deliver(makeAlertEvent()));
  assert.equal(emailChannel.calls.length, 1, "the email channel must still be attempted even though the webhook channel threw");
});
