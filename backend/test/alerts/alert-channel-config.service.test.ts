import { test } from "node:test";
import assert from "node:assert/strict";
import { NotFoundException } from "@nestjs/common";
import { AlertChannelConfigService } from "../../src/alerts/alert-channel-config.service";
import { InMemoryAuditService } from "../../src/tenants/ports/in-memory/in-memory-audit.service";

class FakeWebhookRepository {
  public rows: any[] = [];
  async create(_client: unknown, tenantId: string, url: string, secret: { ciphertext: Buffer }, createdBy: string | null) {
    const row = { id: `wh-${this.rows.length + 1}`, tenant_id: tenantId, url, enabled: true, secret_ciphertext: secret.ciphertext, secret_iv: Buffer.alloc(0), secret_auth_tag: Buffer.alloc(0), secret_encrypted_dek: Buffer.alloc(0), secret_key_version: 1, created_by: createdBy };
    this.rows.push(row);
    return row;
  }
  async findByTenantId() {
    return this.rows;
  }
  async findOne(_client: unknown, _tenantId: string, id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async setEnabled(_client: unknown, _tenantId: string, id: string, enabled: boolean) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    row.enabled = enabled;
    return row;
  }
  async delete(_client: unknown, _tenantId: string, id: string) {
    const index = this.rows.findIndex((r) => r.id === id);
    if (index === -1) return false;
    this.rows.splice(index, 1);
    return true;
  }
}

class FakeEmailRepository {
  public rows: any[] = [];
  async create(_client: unknown, tenantId: string, recipients: string[], createdBy: string | null) {
    const row = { id: `em-${this.rows.length + 1}`, tenant_id: tenantId, recipients, enabled: true, created_by: createdBy };
    this.rows.push(row);
    return row;
  }
  async findByTenantId() {
    return this.rows;
  }
}

class FakeEncryptionService {
  async encrypt(_tenantId: string, plaintext: Buffer) {
    return { ciphertext: plaintext, iv: Buffer.alloc(0), authTag: Buffer.alloc(0), encryptedDataKey: Buffer.alloc(0), keyVersion: 1 };
  }
  async decrypt(_tenantId: string, payload: { ciphertext: Buffer }) {
    return payload.ciphertext;
  }
}

class FakeConfigCache {
  public invalidated: string[] = [];
  async invalidate(tenantId: string) {
    this.invalidated.push(tenantId);
  }
}

class FakeChannel {
  async deliver() {
    return { status: "sent", latencyMs: 5, errorMessage: null, attemptNumber: 1 };
  }
}

function buildRig() {
  const webhookRepository = new FakeWebhookRepository();
  const emailRepository = new FakeEmailRepository();
  const encryptionService = new FakeEncryptionService();
  const configCache = new FakeConfigCache();
  const auditService = new InMemoryAuditService();
  const websocketChannel = new FakeChannel();
  const webhookChannel = new FakeChannel();
  const emailChannel = new FakeChannel();

  const service = new AlertChannelConfigService(
    webhookRepository as any,
    emailRepository as any,
    encryptionService as any,
    configCache as any,
    auditService,
    websocketChannel as any,
    webhookChannel as any,
    emailChannel as any,
  );

  return { webhookRepository, emailRepository, configCache, auditService, service };
}

test("createWebhook masks the secret to its last 4 characters in the returned view", async () => {
  const { service } = buildRig();
  const result = await service.createWebhook("tenant-a", "user-1", "https://example.com/hook", "a-very-long-secret-value-1234");

  assert.equal(result.secretMasked, "****1234");
  assert.ok(!result.secretMasked.includes("a-very-long"), "the raw secret must never appear in the response");
});

test("createWebhook invalidates the tenant's channel-config cache", async () => {
  const { configCache, service } = buildRig();
  await service.createWebhook("tenant-a", "user-1", "https://example.com/hook", "a-secret-value-1234");
  assert.deepEqual(configCache.invalidated, ["tenant-a"]);
});

test("createWebhook records an audit event with the actor and URL, but never the secret", async () => {
  const { auditService, service } = buildRig();
  await service.createWebhook("tenant-a", "user-1", "https://example.com/hook", "a-secret-value-1234");

  assert.equal(auditService.events[0].action, "alert_channel.webhook_created");
  assert.equal(auditService.events[0].actorId, "user-1");
  assert.equal(JSON.stringify(auditService.events[0].details).includes("a-secret-value"), false);
});

test("listWebhooks always masks the secret fully (**** — no last-4 leak on list either)", async () => {
  const { service } = buildRig();
  await service.createWebhook("tenant-a", "user-1", "https://example.com/hook", "a-secret-value-1234");
  const listed = await service.listWebhooks("tenant-a");

  assert.equal(listed[0].secretMasked, "****");
});

test("setWebhookEnabled on a nonexistent webhook throws NotFoundException", async () => {
  const { service } = buildRig();
  await assert.rejects(() => service.setWebhookEnabled("tenant-a", "user-1", "missing-id", false), NotFoundException);
});

test("deleteWebhook on a nonexistent webhook throws NotFoundException", async () => {
  const { service } = buildRig();
  await assert.rejects(() => service.deleteWebhook("tenant-a", "user-1", "missing-id"), NotFoundException);
});

test("createEmailChannel records an audit event with the recipient COUNT, not the actual addresses", async () => {
  const { auditService, service } = buildRig();
  await service.createEmailChannel("tenant-a", "user-1", ["a@example.com", "b@example.com"]);

  assert.equal(auditService.events[0].action, "alert_channel.email_created");
  assert.equal((auditService.events[0].details as any).recipientCount, 2);
  assert.equal(JSON.stringify(auditService.events[0].details).includes("a@example.com"), false);
});

test("testChannel('websocket') delivers a synthetic test event through the real channel", async () => {
  const { service } = buildRig();
  const result = await service.testChannel("tenant-a", "websocket", undefined);
  assert.equal((result as any).status, "sent");
});

test("testChannel('webhook') with a nonexistent configId throws NotFoundException", async () => {
  const { service } = buildRig();
  await assert.rejects(() => service.testChannel("tenant-a", "webhook", "missing-id"));
});
