import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { LangChainConnectionValidator } from "../../../src/adapters/langchain/langchain-connection-validator";

async function startServer(handler: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

test("validateConnection succeeds against a genuinely reachable, healthy endpoint", async () => {
  const { server, url } = await startServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  try {
    const validator = new LangChainConnectionValidator();
    const result = await validator.validateConnection({ endpointUrl: url });
    assert.deepEqual(result, { valid: true });
  } finally {
    server.close();
  }
});

test("validateConnection fails when the endpoint responds with a non-2xx status", async () => {
  const { server, url } = await startServer((_req, res) => {
    res.writeHead(503);
    res.end("unavailable");
  });
  try {
    const validator = new LangChainConnectionValidator();
    const result = await validator.validateConnection({ endpointUrl: url });
    assert.equal(result.valid, false);
    assert.match(result.reason!, /503/);
  } finally {
    server.close();
  }
});

test("validateConnection fails when the endpoint is genuinely unreachable (connection refused)", async () => {
  const validator = new LangChainConnectionValidator();
  const result = await validator.validateConnection({ endpointUrl: "http://127.0.0.1:1" });
  assert.equal(result.valid, false);
  assert.ok(result.reason);
});

test("validateConnection rejects a config missing endpointUrl", async () => {
  const validator = new LangChainConnectionValidator();
  const result = await validator.validateConnection({});
  assert.equal(result.valid, false);
  assert.match(result.reason!, /endpointUrl/);
});

test("validateConnection sends the apiKey as a Bearer Authorization header when provided", async () => {
  let receivedAuth: string | undefined;
  const { server, url } = await startServer((req, res) => {
    receivedAuth = req.headers.authorization;
    res.writeHead(200);
    res.end();
  });
  try {
    const validator = new LangChainConnectionValidator();
    await validator.validateConnection({ endpointUrl: url, apiKey: "secret-key-123" });
    assert.equal(receivedAuth, "Bearer secret-key-123");
  } finally {
    server.close();
  }
});

test("getHealthProbe reports healthy:true with a measured latency for a reachable endpoint", async () => {
  const { server, url } = await startServer((_req, res) => {
    res.writeHead(200);
    res.end();
  });
  try {
    const validator = new LangChainConnectionValidator();
    const result = await validator.getHealthProbe({ endpointUrl: url });
    assert.equal(result.healthy, true);
    assert.ok(typeof result.latencyMs === "number" && result.latencyMs >= 0);
  } finally {
    server.close();
  }
});

test("getHealthProbe reports healthy:false for an unreachable endpoint", async () => {
  const validator = new LangChainConnectionValidator();
  const result = await validator.getHealthProbe({ endpointUrl: "http://127.0.0.1:1" });
  assert.equal(result.healthy, false);
});
