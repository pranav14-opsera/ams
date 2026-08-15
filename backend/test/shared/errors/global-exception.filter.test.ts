import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import { GlobalExceptionFilter } from "../../../src/shared/errors/global-exception.filter";

function fakeRes() {
  const state: { status?: number; body?: unknown } = {};
  return { status(code: number) { state.status = code; return this; }, json(body: unknown) { state.body = body; }, state };
}

function fakeHost(req: Record<string, unknown>, res: ReturnType<typeof fakeRes>): ArgumentsHost {
  return { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ArgumentsHost;
}

function fakeReq(overrides: Record<string, unknown> = {}) {
  return { headers: {}, path: "/api/v1/tenants", originalUrl: "/api/v1/tenants", method: "GET", ...overrides };
}

test("maps every documented HTTP status to its WO-029 error code", () => {
  const filter = new GlobalExceptionFilter();
  const cases: [HttpException, number, string][] = [
    [new BadRequestException("bad"), 400, "validation_error"],
    [new UnauthorizedException(), 401, "authentication_required"],
    [new NotFoundException("nope"), 404, "not_found"],
    [new ConflictException("dup"), 409, "conflict"],
    [new UnprocessableEntityException("nope"), 422, "unprocessable"],
    [new ServiceUnavailableException(), 503, "service_unavailable"],
  ];

  for (const [exception, expectedStatus, expectedCode] of cases) {
    const res = fakeRes();
    filter.catch(exception, fakeHost(fakeReq(), res));
    assert.equal(res.state.status, expectedStatus, `status for ${expectedCode}`);
    assert.equal((res.state.body as any).error, expectedCode, `error code for ${expectedStatus}`);
  }
});

test("a raw (non-HttpException) thrown Error becomes a generic 500 internal_error — never reflecting the original message", () => {
  const filter = new GlobalExceptionFilter();
  const res = fakeRes();
  const internalDetail = "connection to db-primary.internal port 5432 failed: password authentication rejected";
  filter.catch(new Error(internalDetail), fakeHost(fakeReq(), res));

  assert.equal(res.state.status, 500);
  const body = res.state.body as any;
  assert.equal(body.error, "internal_error");
  assert.equal(body.message, "An unexpected error occurred.");
  assert.ok(!JSON.stringify(body).includes("db-primary.internal"), "must never leak internal infrastructure details or the original error message");
});

test("a non-Error thrown value (e.g. a rejected promise with a string) is still handled safely as a 500", () => {
  const filter = new GlobalExceptionFilter();
  const res = fakeRes();
  filter.catch("just a string, not an Error", fakeHost(fakeReq(), res));

  assert.equal(res.state.status, 500);
  assert.equal((res.state.body as any).error, "internal_error");
});

test("never includes a stack trace field in the response body", () => {
  const filter = new GlobalExceptionFilter();
  const res = fakeRes();
  const err = new Error("boom");
  filter.catch(err, fakeHost(fakeReq(), res));

  assert.ok(!("stack" in (res.state.body as any)));
});

test("a single-field validation error extracts the field name and uses the class-validator message directly", () => {
  const filter = new GlobalExceptionFilter();
  const res = fakeRes();
  filter.catch(new BadRequestException({ message: ["email must be an email"] }), fakeHost(fakeReq(), res));

  const body = res.state.body as any;
  assert.equal(body.message, "email must be an email");
  assert.equal(body.field, "email");
  assert.equal(body.details, undefined);
});

test("a multi-field validation error uses a generic top-level message and lists every field's message in details", () => {
  const filter = new GlobalExceptionFilter();
  const res = fakeRes();
  filter.catch(new BadRequestException({ message: ["email must be an email", "name should not be empty"] }), fakeHost(fakeReq(), res));

  const body = res.state.body as any;
  assert.equal(body.message, "Validation failed.");
  assert.deepEqual(body.details, ["email must be an email", "name should not be empty"]);
  assert.equal(body.field, undefined);
});

test("the request_id in the response matches the X-Request-ID header (WO-026 gateway correlation)", () => {
  const filter = new GlobalExceptionFilter();
  const res = fakeRes();
  filter.catch(new NotFoundException("nope"), fakeHost(fakeReq({ headers: { "x-request-id": "gateway-supplied-id" } }), res));

  assert.equal((res.state.body as any).request_id, "gateway-supplied-id");
});

test("generates a fresh request_id when no X-Request-ID header is present, never leaving it blank", () => {
  const filter = new GlobalExceptionFilter();
  const res = fakeRes();
  filter.catch(new NotFoundException("nope"), fakeHost(fakeReq(), res));

  const requestId = (res.state.body as any).request_id;
  assert.ok(requestId && requestId.length > 0);
});

test("SCIM routes (/scim/v2/*) are passed through with their own RFC 7644 shape, untouched", () => {
  const filter = new GlobalExceptionFilter();
  const res = fakeRes();
  const scimException = new HttpException({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], detail: "No user with id x.", status: "404" }, HttpStatus.NOT_FOUND);

  filter.catch(scimException, fakeHost(fakeReq({ path: "/scim/v2/Users/x" }), res));

  assert.equal(res.state.status, 404);
  assert.deepEqual(res.state.body, { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], detail: "No user with id x.", status: "404" });
});

test("an already-structured HttpException body (e.g. a service's own object payload) is normalized onto the WO-029 envelope without losing its own fields", () => {
  const filter = new GlobalExceptionFilter();
  const res = fakeRes();
  filter.catch(new ConflictException({ existingId: "abc-123" }), fakeHost(fakeReq(), res));

  const body = res.state.body as any;
  assert.equal(body.error, "conflict");
  assert.equal(body.existingId, "abc-123", "the service's own extra field must survive normalization");
  assert.ok(body.request_id);
});

test("this filter never itself throws unhandled — a hardcoded fallback response is returned even when this filter's own request-parsing logic fails", () => {
  const filter = new GlobalExceptionFilter();
  const res = fakeRes();
  // Every property access throws — simulates this filter's OWN logic
  // failing on a genuinely malformed request object, not an
  // unrecoverable broken response object (nothing could recover from that).
  const poisonedReq = new Proxy(
    {},
    {
      get() {
        throw new Error("request object is poisoned");
      },
    },
  );

  assert.doesNotThrow(() => filter.catch(new NotFoundException("nope"), fakeHost(poisonedReq as any, res)));
  assert.equal(res.state.status, 500);
  assert.equal((res.state.body as any).error, "internal_error");
});
