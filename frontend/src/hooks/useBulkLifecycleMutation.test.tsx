import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { env } from "@/env";
import { BulkLifecycleError, useBulkLifecycleMutation } from "./useBulkLifecycleMutation";
import bulkSuccess from "@/test/fixtures/agents/bulk-lifecycle-success.json";
import bulkPartialFailure from "@/test/fixtures/agents/bulk-lifecycle-partial-failure.json";
import bulkFullFailure from "@/test/fixtures/agents/bulk-lifecycle-full-failure.json";

const base = env.NEXT_PUBLIC_API_BASE_URL;
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useBulkLifecycleMutation", () => {
  it("POSTs /api/v1/agents/bulk-lifecycle with agentIds and targetStatus, resolving with a full-success result", async () => {
    let capturedBody: unknown;
    server.use(
      http.post(`${base}/api/v1/agents/bulk-lifecycle`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(bulkSuccess);
      }),
    );

    const { result } = renderHook(() => useBulkLifecycleMutation(), { wrapper });
    result.current.mutate({ agentIds: ["a0001aaaa-0000-0000-0000-000000000000", "a0002aaaa-0000-0000-0000-000000000000", "a0003aaaa-0000-0000-0000-000000000000"], targetStatus: "retired" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({
      agentIds: ["a0001aaaa-0000-0000-0000-000000000000", "a0002aaaa-0000-0000-0000-000000000000", "a0003aaaa-0000-0000-0000-000000000000"],
      targetStatus: "retired",
      justification: undefined,
    });
    expect(result.current.data?.successCount).toBe(3);
    expect(result.current.data?.failureCount).toBe(0);
  });

  it("resolves (not rejects) a 200 response carrying a partial failure — per-agent results distinguish success from failure", async () => {
    server.use(http.post(`${base}/api/v1/agents/bulk-lifecycle`, () => HttpResponse.json(bulkPartialFailure)));

    const { result } = renderHook(() => useBulkLifecycleMutation(), { wrapper });
    result.current.mutate({ agentIds: ["a0001aaaa-0000-0000-0000-000000000000", "a0002aaaa-0000-0000-0000-000000000000", "a0003aaaa-0000-0000-0000-000000000000"], targetStatus: "retired" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.successCount).toBe(2);
    expect(result.current.data?.failureCount).toBe(1);
    expect(result.current.data?.results.filter((r) => r.status === "failed")).toHaveLength(1);
  });

  it("resolves a full-failure bulk result the same way — every agent reports status: 'failed'", async () => {
    server.use(http.post(`${base}/api/v1/agents/bulk-lifecycle`, () => HttpResponse.json(bulkFullFailure)));

    const { result } = renderHook(() => useBulkLifecycleMutation(), { wrapper });
    result.current.mutate({ agentIds: ["a0001aaaa-0000-0000-0000-000000000000", "a0002aaaa-0000-0000-0000-000000000000"], targetStatus: "paused" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.successCount).toBe(0);
    expect(result.current.data?.failureCount).toBe(2);
  });

  it("surfaces a top-level 400 (e.g. batch-size validation) as a BulkLifecycleError", async () => {
    server.use(
      http.post(`${base}/api/v1/agents/bulk-lifecycle`, () =>
        HttpResponse.json({ error: "VALIDATION_ERROR", message: "Maximum 50 agents per bulk operation", request_id: "req-1" }, { status: 400 }),
      ),
    );

    const { result } = renderHook(() => useBulkLifecycleMutation(), { wrapper });
    result.current.mutate({ agentIds: ["a1"], targetStatus: "paused" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(BulkLifecycleError);
    expect((result.current.error as BulkLifecycleError).status).toBe(400);
  });
});
