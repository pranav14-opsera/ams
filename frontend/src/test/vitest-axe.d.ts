import type { AxeMatchers } from "vitest-axe";

declare module "vitest" {
  // T must match Vitest's own Assertion<T> arity for declaration merging
  // to apply, even though AxeMatchers itself doesn't use it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Assertion<T = unknown> extends AxeMatchers {}
}
