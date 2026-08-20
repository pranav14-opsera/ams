import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { env } from "@/env";
import { LifecycleTransitionError, useLifecycleTransitionMutation } from "./useLifecycleTransitionMutation";
import transitionSuccess from "@/test/fixtures/agents/lifecycle-transition-success.json";
import transitionConflict from "@/test/fixtures/agents/lifecycle-transition-conflict.json";
import transitionForbidden from "@/test/fixtures/agents/lifecycle-transition-forbidden.json";

const base = env.NEXT_PUBLIC_API_BASE_URL;
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useLifecycleTransitionMutation", () => {
  it("PATCHes /api/v1/agents/{id}/lifecycle with the target status and resolves with the updated agent", async () => {
    let capturedBody: unknown;
    server.use(
      http.patch(`${base}/api/v1/agents/:id/lifecycle`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(transitionSuccess);
      }),
    );

    const { result } = renderHook(() => useLifecycleTransitionMutation(), { wrapper });
    result.current.mutate({ agentId: "10000000-0000-0000-0000-000000000002", targetStatus: "paused" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({ targetStatus: "paused", justification: undefined });
    expect(result.current.data?.lifecycleStatus).toBe("paused");
  });

  it("surfaces a 409 conflict as a LifecycleTransitionError", async () => {
    server.use(http.patch(`${base}/api/v1/agents/:id/lifecycle`, () => HttpResponse.json(transitionConflict, { status: 409 })));

    const { result } = renderHook(() => useLifecycleTransitionMutation(), { wrapper });
    result.current.mutate({ agentId: "10000000-0000-0000-0000-000000000003", targetStatus: "paused" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(LifecycleTransitionError);
    expect((result.current.error as LifecycleTransitionError).status).toBe(409);
  });

  it("surfaces a 403 as a LifecycleTransitionError", async () => {
    server.use(http.patch(`${base}/api/v1/agents/:id/lifecycle`, () => HttpResponse.json(transitionForbidden, { status: 403 })));

    const { result } = renderHook(() => useLifecycleTransitionMutation(), { wrapper });
    result.current.mutate({ agentId: "10000000-0000-0000-0000-000000000002", targetStatus: "paused" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as LifecycleTransitionError).status).toBe(403);
  });

  it("includes a justification when transitioning to retired", async () => {
    let capturedBody: unknown;
    server.use(
      http.patch(`${base}/api/v1/agents/:id/lifecycle`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ ...transitionSuccess, lifecycleStatus: "retired" });
      }),
    );

    const { result } = renderHook(() => useLifecycleTransitionMutation(), { wrapper });
    result.current.mutate({ agentId: "10000000-0000-0000-0000-000000000002", targetStatus: "retired", justification: "No longer needed" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({ targetStatus: "retired", justification: "No longer needed" });
  });
});
