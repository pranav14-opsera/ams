import { test } from "node:test";
import assert from "node:assert/strict";
import { runSmokeChecks, type SmokeTarget } from "../smoke/health-check";

test("runSmokeChecks passes when every path returns 200", async () => {
  const targets: SmokeTarget[] = [{ name: "backend", url: "http://backend.internal", paths: ["/health/live", "/health/ready"] }];
  const results = await runSmokeChecks(targets, async () => ({ ok: true, status: 200 }), 5000);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok));
});

test("runSmokeChecks fails a target that returns a non-200 status", async () => {
  const targets: SmokeTarget[] = [{ name: "backend", url: "http://backend.internal", paths: ["/health/live"] }];
  const results = await runSmokeChecks(targets, async () => ({ ok: false, status: 503 }), 5000);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].status, 503);
});

test("runSmokeChecks fails a target whose request throws", async () => {
  const targets: SmokeTarget[] = [{ name: "backend", url: "http://backend.internal", paths: ["/health/live"] }];
  const results = await runSmokeChecks(
    targets,
    async () => {
      throw new Error("connection refused");
    },
    5000,
  );
  assert.equal(results[0].ok, false);
  assert.match(results[0].error ?? "", /connection refused/);
});

test("runSmokeChecks checks multiple targets independently", async () => {
  const targets: SmokeTarget[] = [
    { name: "backend", url: "http://backend.internal", paths: ["/health/live"] },
    { name: "frontend", url: "http://frontend.internal", paths: ["/"] },
  ];
  let calls = 0;
  const results = await runSmokeChecks(
    targets,
    async (url) => {
      calls++;
      return { ok: !url.includes("frontend"), status: url.includes("frontend") ? 500 : 200 };
    },
    5000,
  );
  assert.equal(calls, 2);
  assert.equal(results.find((r) => r.target === "backend")?.ok, true);
  assert.equal(results.find((r) => r.target === "frontend")?.ok, false);
});
