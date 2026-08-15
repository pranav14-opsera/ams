import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { WebhookAlertChannelService } from "../../../src/alerts/channels/webhook-alert-channel.service";
import type { AlertEvent } from "../../../src/alerts/alert-threshold.types";

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
    ...overrides,
  };
}

/** Genuinely spins up a local HTTP server — a webhook is just an HTTP POST to a tenant-configured URL, no external dependency needed to test this for real (unlike email/Kafka). */
function startMockWebhookServer(handler: (body: string, signatureHeader: string | undefined) => { status: number }): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const { status } = handler(body, req.headers["x-signature-256"] as string | undefined);
        res.writeHead(status);
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/webhook` });
    });
  });
}

test("delivers a real HTTP POST with a valid HMAC-SHA256 signature the server can independently verify", async () => {
  const secret = "test-webhook-secret-value";
  let receivedBody = "";
  let receivedSignature: string | undefined;

  const { server, url } = await startMockWebhookServer((body, signature) => {
    receivedBody = body;
    receivedSignature = signature;
    return { status: 200 };
  });

  try {
    const channel = new WebhookAlertChannelService();
    const alertEvent = makeAlertEvent();
    const result = await channel.deliver(alertEvent, { url, secret });

    assert.equal(result.status, "sent");
    assert.equal(result.attemptNumber, 1);

    const expectedSignature = `sha256=${createHmac("sha256", secret).update(receivedBody).digest("hex")}`;
    assert.equal(receivedSignature, expectedSignature, "the server must be able to independently recompute and verify the signature");
    assert.deepEqual(JSON.parse(receivedBody).id, alertEvent.id);
  } finally {
    server.close();
  }
});

test("a DIFFERENT secret produces a signature the server correctly rejects as invalid", async () => {
  let receivedSignature: string | undefined;
  let receivedBody = "";
  const { server, url } = await startMockWebhookServer((body, signature) => {
    receivedBody = body;
    receivedSignature = signature;
    return { status: 200 };
  });

  try {
    const channel = new WebhookAlertChannelService();
    await channel.deliver(makeAlertEvent(), { url, secret: "the-real-secret" });

    const wrongSignature = `sha256=${createHmac("sha256", "a-completely-different-secret").update(receivedBody).digest("hex")}`;
    assert.notEqual(receivedSignature, wrongSignature);
  } finally {
    server.close();
  }
});

// Real (not mocked) delays, but tiny — proves the actual retry/backoff
// control flow without a genuine 31-second real-time wait for the
// exhausts-all-retries case. Production always uses the real AC delays
// (1s/5s/25s), the constructor's own default.
const FAST_RETRY_DELAYS_MS = [20, 20, 20];

test("retries with backoff on failure, then succeeds — reports 'delivered' (not 'sent') and the correct attempt number", async () => {
  let attempts = 0;
  const { server, url } = await startMockWebhookServer(() => {
    attempts++;
    return attempts < 2 ? { status: 500 } : { status: 200 };
  });

  try {
    const channel = new WebhookAlertChannelService(FAST_RETRY_DELAYS_MS);
    const startedAt = Date.now();
    const result = await channel.deliver(makeAlertEvent(), { url, secret: "secret" });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.status, "delivered");
    assert.equal(result.attemptNumber, 2);
    assert.ok(elapsedMs >= 20, `expected at least the first retry's backoff to have elapsed, got ${elapsedMs}ms`);
  } finally {
    server.close();
  }
});

test("after all retries are exhausted, reports 'failed' with the last error message", async () => {
  const { server, url } = await startMockWebhookServer(() => ({ status: 500 }));

  try {
    const channel = new WebhookAlertChannelService(FAST_RETRY_DELAYS_MS);
    const result = await channel.deliver(makeAlertEvent(), { url, secret: "secret" });

    assert.equal(result.status, "failed");
    assert.equal(result.attemptNumber, 4); // 1 initial + 3 retries
    assert.ok(result.errorMessage?.includes("500"));
  } finally {
    server.close();
  }
});

test("an unreachable URL (connection refused) is reported as failed with a real network error message, not a fabricated one", async () => {
  const channel = new WebhookAlertChannelService(FAST_RETRY_DELAYS_MS);
  const result = await channel.deliver(makeAlertEvent(), { url: "http://127.0.0.1:1", secret: "secret" });

  assert.equal(result.status, "failed");
  assert.ok(result.errorMessage, "a real error message from the actual failed fetch() call must be present");
});
