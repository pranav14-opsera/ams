import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthController } from "../../src/health.controller";

function fakePool(queryImpl: () => Promise<any>) {
  return { query: queryImpl } as any;
}

test("live returns ok without touching the database", () => {
  const controller = new HealthController(fakePool(async () => { throw new Error("must not be called"); }));
  assert.deepEqual(controller.live(), { status: "ok" });
});

test("ready returns ok without touching the database", () => {
  const controller = new HealthController(fakePool(async () => { throw new Error("must not be called"); }));
  assert.deepEqual(controller.ready(), { status: "ok" });
});

test("startup returns ok when the database is reachable", async () => {
  const controller = new HealthController(fakePool(async () => ({ rows: [{ "?column?": 1 }] })));
  assert.deepEqual(await controller.startup(), { status: "ok" });
});

test("startup returns 503 when the database is unreachable", async () => {
  const controller = new HealthController(fakePool(async () => { throw new Error("connection refused"); }));
  await assert.rejects(
    () => controller.startup(),
    (err: any) => {
      assert.equal(err.getStatus(), 503);
      assert.equal(err.getResponse().status, "not_ready");
      return true;
    },
  );
});
