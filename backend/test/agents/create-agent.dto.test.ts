import { test } from "node:test";
import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateAgentDto } from "../../src/agents/dto/create-agent.dto";
import { ListAgentsQueryDto } from "../../src/agents/dto/list-agents-query.dto";

test("accepts a valid payload", async () => {
  const dto = plainToInstance(CreateAgentDto, { name: "My Agent", framework: "langchain", connectionConfig: { apiKey: "x" } });
  assert.equal((await validate(dto)).length, 0);
});

test("rejects a missing name", async () => {
  const dto = plainToInstance(CreateAgentDto, { framework: "langchain", connectionConfig: {} });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "name"));
});

test("rejects an invalid framework enum value", async () => {
  const dto = plainToInstance(CreateAgentDto, { name: "x", framework: "not-a-real-framework", connectionConfig: {} });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "framework"));
});

test("accepts every documented framework value (langchain/crewai/autogen/generic_rest)", async () => {
  for (const framework of ["langchain", "crewai", "autogen", "generic_rest"]) {
    const dto = plainToInstance(CreateAgentDto, { name: "x", framework, connectionConfig: {} });
    assert.equal((await validate(dto)).length, 0, `${framework} must be accepted`);
  }
});

test("rejects a malformed teamId (not a UUID)", async () => {
  const dto = plainToInstance(CreateAgentDto, { name: "x", framework: "langchain", connectionConfig: {}, teamId: "not-a-uuid" });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "teamId"));
});

test("rejects a missing connectionConfig", async () => {
  const dto = plainToInstance(CreateAgentDto, { name: "x", framework: "langchain" });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "connectionConfig"));
});

test("ListAgentsQueryDto accepts an empty query (all filters optional)", async () => {
  const dto = plainToInstance(ListAgentsQueryDto, {});
  assert.equal((await validate(dto)).length, 0);
});

test("ListAgentsQueryDto rejects an invalid lifecycleStatus", async () => {
  const dto = plainToInstance(ListAgentsQueryDto, { lifecycleStatus: "not-a-status" });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "lifecycleStatus"));
});

test("ListAgentsQueryDto rejects a limit above 200", async () => {
  const dto = plainToInstance(ListAgentsQueryDto, { limit: 500 });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "limit"));
});

test("ListAgentsQueryDto rejects a negative offset", async () => {
  const dto = plainToInstance(ListAgentsQueryDto, { offset: -1 });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "offset"));
});
