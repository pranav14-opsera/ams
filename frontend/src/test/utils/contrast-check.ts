/**
 * WCAG 2.1 contrast ratio checker, operating directly on the same
 * "H S% L%" HSL triples globals.css defines its design tokens as (shadcn's
 * own convention) — no DOM/browser APIs, so this runs the exact same way
 * under Vitest+jsdom as it would in a real browser.
 */

export interface HslColor {
  h: number;
  s: number;
  l: number;
}

/** Parses a token value like "240 5.9% 10%" (shadcn's HSL-triple convention, no hsl() wrapper, no commas) into its components. */
export function parseHsl(value: string): HslColor {
  const match = /^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(value.trim());
  if (!match) throw new Error(`Cannot parse HSL token: "${value}"`);
  const [, h, s, l] = match;
  return { h: Number(h), s: Number(s), l: Number(l) };
}

function hslToRgb({ h, s, l }: HslColor): { r: number; g: number; b: number } {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const hPrime = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hPrime % 2) - 1));
  const m = lNorm - c / 2;

  let [r1, g1, b1] = [0, 0, 0];
  if (hPrime >= 0 && hPrime < 1) [r1, g1, b1] = [c, x, 0];
  else if (hPrime < 2) [r1, g1, b1] = [x, c, 0];
  else if (hPrime < 3) [r1, g1, b1] = [0, c, x];
  else if (hPrime < 4) [r1, g1, b1] = [0, x, c];
  else if (hPrime < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];

  return { r: r1 + m, g: g1 + m, b: b1 + m };
}

function channelLuminance(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 relative luminance (0 = black, 1 = white) for an sRGB color already in the 0-1 range. */
export function relativeLuminance(color: { r: number; g: number; b: number }): number {
  return 0.2126 * channelLuminance(color.r) + 0.7152 * channelLuminance(color.g) + 0.0722 * channelLuminance(color.b);
}

/** WCAG 2.1 contrast ratio between two HSL-triple token values — always >= 1, order-independent. */
export function contrastRatio(a: string, b: string): number {
  const lumA = relativeLuminance(hslToRgb(parseHsl(a)));
  const lumB = relativeLuminance(hslToRgb(parseHsl(b)));
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** AC: "4.5:1 for normal text, 3:1 for large text and UI components." */
export const WCAG_AA_NORMAL_TEXT = 4.5;
export const WCAG_AA_LARGE_TEXT_OR_UI = 3;
