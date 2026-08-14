import { Injectable } from "@nestjs/common";
import { MASK_TOKEN, PLATFORM_DEFAULT_PHI_PATTERNS, type PhiPatternSet } from "./phi-patterns";
import { mergeWithTenantOverrides } from "./tenant-phi-pattern-overrides";

const MAX_DEPTH = 20; // guards against pathological/cyclic-looking input rather than recursing forever

// Recursively walks and masks PHI in any JSON-shaped value: deep-clones
// (never mutates the caller's object — a log call or an in-flight event
// must not have its original payload altered out from under it),
// replacing a field's value with [MASKED] whenever EITHER that field's
// name matches a known PHI field pattern OR the value itself matches a
// known PHI value shape (SSN/MRN/DOB), regardless of the field's name.
// The same pass handles structured (objects/arrays) and unstructured
// (plain strings, e.g. a log message) content by treating a bare string
// input as a single unnamed field checked only against value patterns.
@Injectable()
export class PhiScrubberService {
  scrub(value: unknown, tenantSettings?: Record<string, unknown> | null, patterns: PhiPatternSet = PLATFORM_DEFAULT_PHI_PATTERNS): unknown {
    const effectivePatterns = tenantSettings ? mergeWithTenantOverrides(patterns, tenantSettings) : patterns;
    return this.walk(value, undefined, effectivePatterns, 0);
  }

  /** Convenience for unstructured content (log messages, free-text error details) — masks any PHI-shaped substring, not just an exact full-string match. */
  scrubText(text: string, tenantSettings?: Record<string, unknown> | null, patterns: PhiPatternSet = PLATFORM_DEFAULT_PHI_PATTERNS): string {
    const effectivePatterns = tenantSettings ? mergeWithTenantOverrides(patterns, tenantSettings) : patterns;
    let result = text;
    for (const valuePattern of effectivePatterns.valuePatterns) {
      // The value patterns are anchored (^...$) for scrub()'s exact
      // whole-value field checks — found via testing that reusing them
      // as-is here means they never match, since ^/$ anchor to the
      // ENTIRE string, not a substring inside a longer log message like
      // "SSN 123-45-6789". Strip the anchors for substring scanning.
      const unanchoredSource = valuePattern.source.replace(/^\^/, "").replace(/\$$/, "");
      const flags = valuePattern.flags.includes("g") ? valuePattern.flags : `${valuePattern.flags}g`;
      const global = new RegExp(unanchoredSource, flags);
      result = result.replace(global, MASK_TOKEN);
    }
    return result;
  }

  private walk(value: unknown, fieldName: string | undefined, patterns: PhiPatternSet, depth: number): unknown {
    if (depth > MAX_DEPTH) return value;

    if (fieldName !== undefined && patterns.fieldNamePatterns.some((p) => p.test(fieldName))) {
      return MASK_TOKEN;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.walk(item, fieldName, patterns, depth + 1));
    }

    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
      const result: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        result[key] = this.walk(nested, key, patterns, depth + 1);
      }
      return result;
    }

    if (typeof value === "string" && patterns.valuePatterns.some((p) => p.test(value))) {
      return MASK_TOKEN;
    }

    return value;
  }
}
