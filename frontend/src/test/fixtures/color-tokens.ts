// Mirrors globals.css's :root / .dark token values exactly (shadcn's HSL-triple
// convention: "H S% L%"). Keep in sync manually if globals.css's palette ever
// changes — this manifest exists so the contrast checker (a plain TS/Vitest
// unit test, no browser/DOM needed) can verify every pair without parsing CSS.
export interface ColorTokens {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
}

export const LIGHT_TOKENS: ColorTokens = {
  background: "0 0% 100%",
  foreground: "240 10% 3.9%",
  card: "0 0% 100%",
  cardForeground: "240 10% 3.9%",
  popover: "0 0% 100%",
  popoverForeground: "240 10% 3.9%",
  primary: "240 5.9% 10%",
  primaryForeground: "0 0% 98%",
  secondary: "240 4.8% 95.9%",
  secondaryForeground: "240 5.9% 10%",
  muted: "240 4.8% 95.9%",
  mutedForeground: "240 3.8% 42%",
  accent: "240 4.8% 95.9%",
  accentForeground: "240 5.9% 10%",
  destructive: "0 84.2% 45%",
  destructiveForeground: "0 0% 98%",
  border: "240 5.9% 90%",
  input: "240 5.9% 90%",
  ring: "240 5.9% 10%",
};

export const DARK_TOKENS: ColorTokens = {
  background: "240 10% 3.9%",
  foreground: "0 0% 98%",
  card: "240 10% 3.9%",
  cardForeground: "0 0% 98%",
  popover: "240 10% 3.9%",
  popoverForeground: "0 0% 98%",
  primary: "0 0% 98%",
  primaryForeground: "240 5.9% 10%",
  secondary: "240 3.7% 15.9%",
  secondaryForeground: "0 0% 98%",
  muted: "240 3.7% 15.9%",
  mutedForeground: "240 5% 64.9%",
  accent: "240 3.7% 15.9%",
  accentForeground: "0 0% 98%",
  destructive: "0 62.8% 30.6%",
  destructiveForeground: "0 0% 98%",
  border: "240 3.7% 15.9%",
  input: "240 3.7% 15.9%",
  ring: "240 4.9% 83.9%",
};

/** Background/foreground pairs that must meet the AC's 4.5:1 normal-text contrast ratio. */
export const TEXT_PAIRS: Array<[keyof ColorTokens, keyof ColorTokens]> = [
  ["background", "foreground"],
  ["card", "cardForeground"],
  ["popover", "popoverForeground"],
  ["primary", "primaryForeground"],
  ["secondary", "secondaryForeground"],
  ["muted", "mutedForeground"],
  ["accent", "accentForeground"],
  ["destructive", "destructiveForeground"],
];
