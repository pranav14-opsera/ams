import { test } from "node:test";
import assert from "node:assert/strict";
import { QualityScoreLockService } from "../../src/quality-score/quality-score-lock.service";

const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !REDIS_AVAILABLE;

test("real Redis: a second concurrent acquire attempt is rejected while the first holder still holds the lock", { skip }, async () => {
  const a = new QualityScoreLockService();
  const b = new QualityScoreLockService();
  try {
    const releaseA = await a.acquire();
    assert.ok(releaseA, "first acquirer should succeed");

    const releaseB = await b.acquire();
    assert.equal(releaseB, null, "second acquirer must be rejected while the lock is held");

    await releaseA!();
  } finally {
    await a.onModuleDestroy();
    await b.onModuleDestroy();
  }
});

test("real Redis: after release, a new acquire attempt succeeds", { skip }, async () => {
  const a = new QualityScoreLockService();
  const b = new QualityScoreLockService();
  try {
    const releaseA = await a.acquire();
    await releaseA!();

    const releaseB = await b.acquire();
    assert.ok(releaseB, "acquire should succeed once the prior holder released");
    await releaseB!();
  } finally {
    await a.onModuleDestroy();
    await b.onModuleDestroy();
  }
});

test("real Redis: releasing after another instance already reacquired the lock (past TTL) doesn't delete THEIR lock", { skip }, async () => {
  const a = new QualityScoreLockService();
  const b = new QualityScoreLockService();
  const c = new QualityScoreLockService();
  try {
    const releaseA = await a.acquire();
    assert.ok(releaseA);

    // Simulate A's lock having already expired and B acquiring fresh, by manually clearing then re-acquiring as B.
    await releaseA!();
    const releaseB = await b.acquire();
    assert.ok(releaseB);

    // A's (now-stale) release call must be a no-op — it no longer holds the current token.
    await releaseA!();

    const releaseC = await c.acquire();
    assert.equal(releaseC, null, "B's lock must still be held — A's stale release must not have deleted it");
    await releaseB!();
  } finally {
    await a.onModuleDestroy();
    await b.onModuleDestroy();
    await c.onModuleDestroy();
  }
});
