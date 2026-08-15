import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { AuditLogQueryDto } from "../../../src/audit/query/dto/audit-log-query.dto";

async function validateDto(plain: Record<string, unknown>) {
  const dto = plainToInstance(AuditLogQueryDto, plain);
  return validate(dto);
}

test("a query with only the required time range is valid", async () => {
  const errors = await validateDto({ startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-31T23:59:59Z" });
  assert.equal(errors.length, 0);
});

test("startTime is required", async () => {
  const errors = await validateDto({ endTime: "2026-01-31T23:59:59Z" });
  assert.ok(errors.some((e) => e.property === "startTime"));
});

test("endTime is required", async () => {
  const errors = await validateDto({ startTime: "2026-01-01T00:00:00Z" });
  assert.ok(errors.some((e) => e.property === "endTime"));
});

test("startTime/endTime must be valid ISO 8601", async () => {
  const errors = await validateDto({ startTime: "not-a-date", endTime: "2026-01-31T23:59:59Z" });
  assert.ok(errors.some((e) => e.property === "startTime"));
});

test("actorId must be a valid UUID when present", async () => {
  const errors = await validateDto({ startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-31T23:59:59Z", actorId: "not-a-uuid" });
  assert.ok(errors.some((e) => e.property === "actorId"));
});

test("dataClassification must be one of the 4 known tiers", async () => {
  const errors = await validateDto({ startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-31T23:59:59Z", dataClassification: "top-secret" });
  assert.ok(errors.some((e) => e.property === "dataClassification"));
});

test("limit must be between 1 and 1000", async () => {
  const tooLow = await validateDto({ startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-31T23:59:59Z", limit: "0" });
  assert.ok(tooLow.some((e) => e.property === "limit"));
  const tooHigh = await validateDto({ startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-31T23:59:59Z", limit: "1001" });
  assert.ok(tooHigh.some((e) => e.property === "limit"));
  const valid = await validateDto({ startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-31T23:59:59Z", limit: "500" });
  assert.equal(valid.length, 0);
});

test("all optional filters can be provided together and pass", async () => {
  const errors = await validateDto({
    startTime: "2026-01-01T00:00:00Z",
    endTime: "2026-01-31T23:59:59Z",
    actorId: randomUUID(),
    action: "user.login",
    resourceType: "session",
    resourceId: "abc-123",
    dataClassification: "internal",
    correlationId: "corr-1",
    cursor: "opaque-cursor",
    limit: "50",
  });
  assert.equal(errors.length, 0);
});
