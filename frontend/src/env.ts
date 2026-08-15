import { z } from "zod";

// AC: "typed env schema... with placeholders for API_BASE_URL and
// WS_BASE_URL; no secrets are committed." Only NEXT_PUBLIC_-prefixed
// variables are ever inlined into the static export's client bundle
// (Next.js's own build-time replacement rule) — every variable this
// schema validates is one the client is meant to see, never a secret.
const envSchema = z.object({
  // Placeholders (AC): this scaffold has no real backend deployment yet —
  // these defaults keep `next build`'s static export working out of the
  // box in dev/CI; a real deployment overrides both via build-time
  // NEXT_PUBLIC_* env vars (see frontend/Dockerfile's ARG/ENV pair).
  NEXT_PUBLIC_API_BASE_URL: z.string().url().default("http://localhost:3001"),
  NEXT_PUBLIC_WS_BASE_URL: z.string().url().default("ws://localhost:3001"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse({
    NEXT_PUBLIC_API_BASE_URL: source.NEXT_PUBLIC_API_BASE_URL,
    NEXT_PUBLIC_WS_BASE_URL: source.NEXT_PUBLIC_WS_BASE_URL,
    NODE_ENV: source.NODE_ENV,
  });

  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }

  return parsed.data;
}

export const env = loadEnv();
