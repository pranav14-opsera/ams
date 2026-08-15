import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

describe("loadEnv", () => {
  it("accepts a valid environment and returns typed values", () => {
    const env = loadEnv({
      NEXT_PUBLIC_API_BASE_URL: "https://api.example.com",
      NEXT_PUBLIC_WS_BASE_URL: "wss://ws.example.com",
      NODE_ENV: "production",
    });

    expect(env.NEXT_PUBLIC_API_BASE_URL).toBe("https://api.example.com");
    expect(env.NEXT_PUBLIC_WS_BASE_URL).toBe("wss://ws.example.com");
    expect(env.NODE_ENV).toBe("production");
  });

  it("falls back to the documented placeholder defaults when unset", () => {
    const env = loadEnv({});
    expect(env.NEXT_PUBLIC_API_BASE_URL).toBe("http://localhost:3001");
    expect(env.NEXT_PUBLIC_WS_BASE_URL).toBe("ws://localhost:3001");
    expect(env.NODE_ENV).toBe("development");
  });

  it("rejects a malformed URL", () => {
    expect(() => loadEnv({ NEXT_PUBLIC_API_BASE_URL: "not-a-url" })).toThrow(/Invalid environment configuration/);
  });

  it("rejects an invalid NODE_ENV value", () => {
    expect(() => loadEnv({ NODE_ENV: "staging" })).toThrow(/Invalid environment configuration/);
  });
});
