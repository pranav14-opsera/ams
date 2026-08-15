// Platform-default PHI detection patterns. Two independent signals are
// used together (a field matching by NAME is masked regardless of its
// value's shape; a value matching one of these regexes is masked
// regardless of what its field happens to be called) — a single scrubber
// relying on only one of these would miss either a PHI value sitting in
// an oddly-named field, or a non-PHI value sitting in a well-named one
// (e.g. patient_id: null).

export const DEFAULT_PHI_FIELD_NAME_PATTERNS: readonly RegExp[] = [
  /patient[_-]?id/i,
  /patient[_-]?name/i,
  /medical[_-]?record([_-]?number)?/i,
  /\bmrn\b/i,
  /\bssn\b/i,
  /social[_-]?security/i,
  /diagnos(is|es)/i,
  /\bdob\b/i,
  /date[_-]?of[_-]?birth/i,
  /\be-?mail\b/i,
  /\bphone([_-]?number)?\b/i,
  /\bicd[_-]?10\b/i,
];

export const DEFAULT_PHI_VALUE_PATTERNS: readonly RegExp[] = [
  /^\d{3}-\d{2}-\d{4}$/, // SSN: 123-45-6789
  /^[A-Z]{0,3}\d{6,10}$/, // MRN: a handful of letters + 6-10 digits, e.g. MRN0012345
  /^\d{4}-\d{2}-\d{2}$/, // DOB: ISO 8601 date, YYYY-MM-DD
  /^\d{2}\/\d{2}\/\d{4}$/, // DOB: MM/DD/YYYY
  // ICD-10-CM: a letter (excluding U, reserved for special/provisional
  // codes) + 2 digits, optionally followed by a decimal point and 1-4
  // further alphanumeric characters, e.g. "Z00.00", "E11.9", "S72.001A".
  /^[A-TV-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/i,
  // Email address.
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  // US phone number: (555) 123-4567, 555-123-4567, 555.123.4567, 5551234567.
  /^\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}$/,
];

export const MASK_TOKEN = "[MASKED]";

export interface PhiPatternSet {
  fieldNamePatterns: readonly RegExp[];
  valuePatterns: readonly RegExp[];
}

export const PLATFORM_DEFAULT_PHI_PATTERNS: PhiPatternSet = Object.freeze({
  fieldNamePatterns: DEFAULT_PHI_FIELD_NAME_PATTERNS,
  valuePatterns: DEFAULT_PHI_VALUE_PATTERNS,
});
