// WCAG 2.1 AA ruleset — the acceptance criteria's exact standard, no more
// (wcag2aaa/best-practice rules are stricter than what's required and would
// generate noise unrelated to the compliance bar this scan enforces).
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21aa"] as const;

// axe-core's impact levels, mapped to this pipeline's block/warn behavior.
// "critical"/"serious" are axe's own vocabulary; BLOCKING here is which of
// those actually fail the pipeline per the acceptance criteria ("critical
// violations block, serious are warnings only").
export const BLOCKING_IMPACTS = ["critical"] as const;
export const WARNING_IMPACTS = ["serious"] as const;

export const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
] as const;
