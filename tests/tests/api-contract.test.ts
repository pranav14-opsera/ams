import { test } from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import { extractContractChecks, runContractChecks } from "../contract/api-contract";

const SAMPLE_DOC = {
  paths: {
    "/health/live": {
      get: {
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["ok"] } } },
              },
            },
          },
        },
      },
    },
  },
};

test("extractContractChecks flattens one entry per path/method/status", () => {
  const checks = extractContractChecks(SAMPLE_DOC);
  assert.equal(checks.length, 1);
  assert.deepEqual(
    { path: checks[0].path, method: checks[0].method, status: checks[0].status },
    { path: "/health/live", method: "GET", status: 200 },
  );
});

test("runContractChecks passes when the live response matches the schema", async () => {
  const checks = extractContractChecks(SAMPLE_DOC);
  const results = await runContractChecks(
    "http://backend.internal",
    checks,
    async () => ({ status: 200, json: async () => ({ status: "ok" }) }),
    new Ajv(),
  );
  assert.equal(results[0].ok, true);
});

test("runContractChecks fails when the response body violates the schema", async () => {
  const checks = extractContractChecks(SAMPLE_DOC);
  const results = await runContractChecks(
    "http://backend.internal",
    checks,
    async () => ({ status: 200, json: async () => ({ status: "degraded" }) }), // not in the enum
    new Ajv(),
  );
  assert.equal(results[0].ok, false);
  assert.match(results[0].errors ?? "", /status/);
});

test("runContractChecks fails when the response status doesn't match the spec", async () => {
  const checks = extractContractChecks(SAMPLE_DOC);
  const results = await runContractChecks(
    "http://backend.internal",
    checks,
    async () => ({ status: 500, json: async () => ({}) }),
    new Ajv(),
  );
  assert.equal(results[0].ok, false);
  assert.match(results[0].errors ?? "", /expected status 200, got 500/);
});
