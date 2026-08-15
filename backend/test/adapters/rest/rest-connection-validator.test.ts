import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { RestConnectionValidator } from "../../../src/adapters/rest/rest-connection-validator";

async function startServer(handler: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

test("validateConnection succeeds against a healthy endpoint (default expectedStatus 200)", async () => {
  const { server, url } = await startServer((_req, res) => {
    res.writeHead(200);
    res.end();
  });
  try {
    const result = await new RestConnectionValidator().validateConnection({ healthEndpoint: url });
    assert.deepEqual(result, { valid: true });
  } finally {
    server.close();
  }
});

test("validateConnection honors a custom expectedStatus", async () => {
  const { server, url } = await startServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  try {
    const result = await new RestConnectionValidator().validateConnection({ healthEndpoint: url, expectedStatus: 204 });
    assert.deepEqual(result, { valid: true });
  } finally {
    server.close();
  }
});

test("validateConnection fails when the response status doesn't match expectedStatus", async () => {
  const { server, url } = await startServer((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  try {
    const result = await new RestConnectionValidator().validateConnection({ healthEndpoint: url });
    assert.equal(result.valid, false);
    assert.match(result.reason!, /500/);
  } finally {
    server.close();
  }
});

test("validateConnection follows redirects (up to 3) and validates the final response", async () => {
  const { server, url } = await startServer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { Location: "/hop1" });
      res.end();
    } else if (req.url === "/hop1") {
      res.writeHead(302, { Location: "/hop2" });
      res.end();
    } else if (req.url === "/hop2") {
      res.writeHead(200);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const result = await new RestConnectionValidator().validateConnection({ healthEndpoint: `${url}/start` });
    assert.deepEqual(result, { valid: true });
  } finally {
    server.close();
  }
});

test("validateConnection stops following after the 3-redirect cap and reports the redirect response itself", async () => {
  const { server, url } = await startServer((req, res) => {
    const hop = Number((req.url ?? "/0").slice(1));
    res.writeHead(302, { Location: `/${hop + 1}` });
    res.end();
  });
  try {
    const result = await new RestConnectionValidator().validateConnection({ healthEndpoint: `${url}/0` });
    assert.equal(result.valid, false, "an infinite redirect chain must never be followed forever");
    assert.match(result.reason!, /302/);
  } finally {
    server.close();
  }
});

test("validateConnection fails against a genuinely unreachable endpoint", async () => {
  const result = await new RestConnectionValidator().validateConnection({ healthEndpoint: "http://127.0.0.1:1" });
  assert.equal(result.valid, false);
});

test("validateConnection rejects a config missing health_endpoint", async () => {
  const result = await new RestConnectionValidator().validateConnection({});
  assert.equal(result.valid, false);
  assert.match(result.reason!, /health_endpoint/);
});

test("getHealthProbe reports healthy:true with measured latency", async () => {
  const { server, url } = await startServer((_req, res) => {
    res.writeHead(200);
    res.end();
  });
  try {
    const result = await new RestConnectionValidator().getHealthProbe({ healthEndpoint: url });
    assert.equal(result.healthy, true);
    assert.ok(typeof result.latencyMs === "number");
  } finally {
    server.close();
  }
});
