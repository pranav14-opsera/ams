import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "@/env";
import verificationAllPassFixture from "@/test/fixtures/onboarding/verification-all-pass.json";
import verificationMixedFixture from "@/test/fixtures/onboarding/verification-mixed.json";
import { StepVerification } from "./step-verification";

const base = env.NEXT_PUBLIC_API_BASE_URL;
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("StepVerification — checklist status computation", () => {
  it("renders a green Passing indicator for every check when allPassed is true, and enables Complete Onboarding", async () => {
    server.use(http.get(`${base}/api/v1/onboarding/:tenantId/status`, () => HttpResponse.json(verificationAllPassFixture)));
    render(<StepVerification tenantId="t1" onComplete={vi.fn()} />, { wrapper });

    await screen.findAllByText("Passing");
    expect(screen.getAllByText("Passing")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Complete Onboarding" })).toBeEnabled();
  });

  it("renders mixed pass/fail indicators and disables Complete Onboarding while any check fails", async () => {
    server.use(http.get(`${base}/api/v1/onboarding/:tenantId/status`, () => HttpResponse.json(verificationMixedFixture)));
    render(<StepVerification tenantId="t1" onComplete={vi.fn()} />, { wrapper });

    await screen.findAllByText("Passing");
    expect(screen.getAllByText("Passing")).toHaveLength(2);
    expect(screen.getAllByText("Failing")).toHaveLength(2);
    expect(screen.getByText(/No agent has reached Active status yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete Onboarding" })).toBeDisabled();
  });
});
