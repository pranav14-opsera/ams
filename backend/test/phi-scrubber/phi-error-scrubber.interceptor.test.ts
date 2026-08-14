import { test } from "node:test";
import assert from "node:assert/strict";
import { BadRequestException, type CallHandler, type ExecutionContext } from "@nestjs/common";
import { lastValueFrom, of, throwError } from "rxjs";
import { PhiErrorScrubberInterceptor } from "../../src/phi-scrubber/phi-error-scrubber.interceptor";
import { PhiScrubberService } from "../../src/phi-scrubber/phi-scrubber.service";

function handlerReturning(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

function handlerThrowing(err: unknown): CallHandler {
  return { handle: () => throwError(() => err) };
}

const fakeContext = {} as ExecutionContext;

test("scrubs PHI out of a successful response body (e.g. trace display data)", async () => {
  const interceptor = new PhiErrorScrubberInterceptor(new PhiScrubberService());
  const result = await lastValueFrom(interceptor.intercept(fakeContext, handlerReturning({ trace: "ok", patient_id: "12345" })));
  assert.deepEqual(result, { trace: "ok", patient_id: "[MASKED]" });
});

test("scrubs PHI out of an HttpException's response body, preserving the status code", async () => {
  const interceptor = new PhiErrorScrubberInterceptor(new PhiScrubberService());
  const original = new BadRequestException({ message: "invalid request", patient_id: "12345", ssn: "123-45-6789" });

  await assert.rejects(
    () => lastValueFrom(interceptor.intercept(fakeContext, handlerThrowing(original))),
    (err: any) => {
      assert.equal(err.getStatus(), 400);
      const response = err.getResponse();
      assert.equal(response.patient_id, "[MASKED]");
      assert.equal(response.ssn, "[MASKED]");
      assert.equal(response.message, "invalid request"); // non-PHI fields untouched
      return true;
    },
  );
});

test("scrubs a PHI-shaped plain-string exception message", async () => {
  const interceptor = new PhiErrorScrubberInterceptor(new PhiScrubberService());
  const original = new BadRequestException("lookup failed for SSN 123-45-6789");

  await assert.rejects(
    () => lastValueFrom(interceptor.intercept(fakeContext, handlerThrowing(original))),
    (err: any) => {
      assert.ok(!err.message.includes("123-45-6789"));
      assert.ok(err.message.includes("[MASKED]"));
      return true;
    },
  );
});

test("a non-HTTP error's message is scrubbed too, not just HttpExceptions", async () => {
  const interceptor = new PhiErrorScrubberInterceptor(new PhiScrubberService());
  const original = new Error("crash while processing patient_id lookup, SSN was 123-45-6789");

  await assert.rejects(
    () => lastValueFrom(interceptor.intercept(fakeContext, handlerThrowing(original))),
    (err: any) => {
      assert.ok(!err.message.includes("123-45-6789"));
      return true;
    },
  );
});
