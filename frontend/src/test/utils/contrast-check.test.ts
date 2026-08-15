import { describe, expect, it } from "vitest";
import { DARK_TOKENS, LIGHT_TOKENS, TEXT_PAIRS, type ColorTokens } from "@/test/fixtures/color-tokens";
import { contrastRatio, parseHsl, relativeLuminance, WCAG_AA_NORMAL_TEXT } from "./contrast-check";

describe("parseHsl", () => {
  it("parses a shadcn-style HSL triple", () => {
    expect(parseHsl("240 5.9% 10%")).toEqual({ h: 240, s: 5.9, l: 10 });
  });

  it("throws on a malformed value", () => {
    expect(() => parseHsl("not a color")).toThrow(/Cannot parse HSL token/);
  });
});

describe("relativeLuminance", () => {
  it("black has ~0 luminance and white has ~1", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
    expect(relativeLuminance({ r: 1, g: 1, b: 1 })).toBeCloseTo(1, 5);
  });
});

describe("contrastRatio", () => {
  it("black vs. white is the maximum possible ratio, 21:1", () => {
    expect(contrastRatio("0 0% 0%", "0 0% 100%")).toBeCloseTo(21, 1);
  });

  it("a color against itself is 1:1 (no contrast)", () => {
    expect(contrastRatio("240 5.9% 10%", "240 5.9% 10%")).toBeCloseTo(1, 5);
  });

  it("is order-independent", () => {
    const a = contrastRatio("0 0% 0%", "0 0% 100%");
    const b = contrastRatio("0 0% 100%", "0 0% 0%");
    expect(a).toBeCloseTo(b, 10);
  });
});

describe("WO-052 AC: every design-token text pair meets WCAG 2.1 AA (4.5:1) in both light and dark mode", () => {
  function checkAllPairs(tokens: ColorTokens, mode: string) {
    for (const [bgKey, fgKey] of TEXT_PAIRS) {
      const ratio = contrastRatio(tokens[bgKey], tokens[fgKey]);
      it(`${mode}: ${String(bgKey)}/${String(fgKey)} is >= ${WCAG_AA_NORMAL_TEXT}:1 (actual: ${ratio.toFixed(2)}:1)`, () => {
        expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
      });
    }
  }

  checkAllPairs(LIGHT_TOKENS, "light");
  checkAllPairs(DARK_TOKENS, "dark");
});
