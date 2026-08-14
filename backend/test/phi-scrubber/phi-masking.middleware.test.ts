import { test } from "node:test";
import assert from "node:assert/strict";
import { PhiMaskingLogger } from "../../src/phi-scrubber/phi-masking.middleware";
import { PhiScrubberService } from "../../src/phi-scrubber/phi-scrubber.service";

// Verifies log output scrubbing by capturing what actually reaches
// stdout (Nest's ConsoleLogger writes via process.stdout.write /
// process.stderr.write directly, NOT console.log — found by testing:
// the first version of this test intercepted console.log and always saw
// empty output), rather than just asserting on the scrubber's own return
// value — the acceptance criteria's real claim is about "captured log
// output", i.e. what a log aggregator would actually receive.
function captureStdio(fn: () => void): string {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let captured = "";
  const capture = (chunk: any): boolean => {
    captured += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
  return captured;
}

test("log() scrubs a PHI-shaped string message before it reaches the console", () => {
  const logger = new PhiMaskingLogger(new PhiScrubberService());
  const output = captureStdio(() => logger.log("Processing patient with SSN 123-45-6789"));
  assert.ok(output.includes("[MASKED]"));
  assert.ok(!output.includes("123-45-6789"));
});

test("log() scrubs PHI fields inside an object argument", () => {
  const logger = new PhiMaskingLogger(new PhiScrubberService());
  const output = captureStdio(() => logger.log({ event: "tenant.created", patient_id: "12345" }));
  assert.ok(output.includes("[MASKED]"));
  assert.ok(!output.includes("12345"));
});

test("error() scrubs PHI in both the message and additional context args", () => {
  const logger = new PhiMaskingLogger(new PhiScrubberService());
  const output = captureStdio(() =>
    logger.error("failed to process record for patient_id lookup", { patient_id: "99999", stack: "..." }),
  );
  assert.ok(!output.includes("99999"));
});

test("non-PHI log content passes through unscrubbed", () => {
  const logger = new PhiMaskingLogger(new PhiScrubberService());
  const output = captureStdio(() => logger.log("Server started on port 3000"));
  assert.ok(output.includes("Server started on port 3000"));
});
