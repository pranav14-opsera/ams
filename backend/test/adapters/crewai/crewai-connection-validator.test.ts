import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { CrewAiConnectionValidator } from "../../../src/adapters/crewai/crewai-connection-validator";

async function startServer(handler: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

test("validateConnection succeeds when the crew config endpoint returns a valid crew structure", async () => {
  const { server, url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ crew: { name: "Research Crew", agents: ["researcher"] } }));
  });
  try {
    const result = await new CrewAiConnectionValidator().validateConnection({ crewConfigEndpoint: url });
    assert.deepEqual(result, { valid: true });
  } finally {
    server.close();
  }
});

test("validateConnection fails when the response body lacks a crew structure", async () => {
  const { server, url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });
  try {
    const result = await new CrewAiConnectionValidator().validateConnection({ crewConfigEndpoint: url });
    assert.equal(result.valid, false);
    assert.match(result.reason!, /crew structure/);
  } finally {
    server.close();
  }
});

test("validateConnection fails on a non-2xx response", async () => {
  const { server, url } = await startServer((_req, res) => {
    res.writeHead(503);
    res.end();
  });
  try {
    const result = await new CrewAiConnectionValidator().validateConnection({ crewConfigEndpoint: url });
    assert.equal(result.valid, false);
    assert.match(result.reason!, /503/);
  } finally {
    server.close();
  }
});

test("validateConnection fails against a genuinely unreachable endpoint", async () => {
  const result = await new CrewAiConnectionValidator().validateConnection({ crewConfigEndpoint: "http://127.0.0.1:1" });
  assert.equal(result.valid, false);
});

test("validateConnection rejects a config missing crewConfigEndpoint", async () => {
  const result = await new CrewAiConnectionValidator().validateConnection({});
  assert.equal(result.valid, false);
  assert.match(result.reason!, /crewConfigEndpoint/);
});

test("getHealthProbe reports healthy:true with measured latency", async () => {
  const { server, url } = await startServer((_req, res) => {
    res.writeHead(200);
    res.end();
  });
  try {
    const result = await new CrewAiConnectionValidator().getHealthProbe({ crewConfigEndpoint: url });
    assert.equal(result.healthy, true);
    assert.ok(typeof result.latencyMs === "number");
  } finally {
    server.close();
  }
});
