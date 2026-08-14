import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScimFilter } from "../../src/scim/scim-filter.parser";

test("parses eq on userName into a parameterized equality clause", () => {
  const result = parseScimFilter(`userName eq "john@example.com"`, 2);
  assert.equal(result.whereClause, "email = $2");
  assert.equal(result.param, "john@example.com");
});

test("parses eq on externalId", () => {
  const result = parseScimFilter(`externalId eq "ext-123"`, 1);
  assert.equal(result.whereClause, "external_id = $1");
  assert.equal(result.param, "ext-123");
});

test("parses co (contains) on displayName", () => {
  const result = parseScimFilter(`displayName co "smith"`, 3);
  assert.equal(result.whereClause, "display_name ILIKE '%' || $3 || '%'");
  assert.equal(result.param, "smith");
});

test("parses sw (starts with)", () => {
  const result = parseScimFilter(`userName sw "john"`, 1);
  assert.equal(result.whereClause, "email ILIKE $1 || '%'");
});

test("parses ew (ends with)", () => {
  const result = parseScimFilter(`userName ew "example.com"`, 1);
  assert.equal(result.whereClause, "email ILIKE '%' || $1");
});

test("parses ne (not equal)", () => {
  const result = parseScimFilter(`userName ne "john@example.com"`, 1);
  assert.equal(result.whereClause, "email != $1");
});

test("parses active eq true into the status column", () => {
  const result = parseScimFilter(`active eq true`, 2);
  assert.equal(result.whereClause, "status = $2");
  assert.equal(result.param, "active");
});

test("parses active eq false into the status column", () => {
  const result = parseScimFilter(`active eq false`, 2);
  assert.equal(result.param, "deactivated");
});

test("rejects active with an operator other than eq", () => {
  assert.throws(() => parseScimFilter(`active co true`, 1));
});

test("rejects filtering on an unsupported attribute", () => {
  assert.throws(() => parseScimFilter(`password eq "hunter2"`, 1), (err: any) => {
    assert.equal(err.getStatus(), 400);
    return true;
  });
});

test("rejects a malformed filter expression entirely", () => {
  assert.throws(() => parseScimFilter(`this is not a filter`, 1));
});

test("is case-insensitive on attribute and operator names", () => {
  const result = parseScimFilter(`UserName EQ "john@example.com"`, 1);
  assert.equal(result.whereClause, "email = $1");
});

test("the compared value is NEVER interpolated into the SQL string — always the bound parameter", () => {
  const maliciousValue = `x'; DROP TABLE users; --`;
  const result = parseScimFilter(`userName eq "${maliciousValue}"`, 1);
  assert.ok(!result.whereClause.includes("DROP TABLE"), "the where clause must only ever contain the column/operator template, never the value");
  assert.equal(result.param, maliciousValue, "the raw value is preserved for the bound parameter — never string-escaped or filtered");
});
