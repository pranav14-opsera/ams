import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "@/env";
import scimTestFailureFixture from "@/test/fixtures/onboarding/scim-test-failure.json";
import scimTestSuccessFixture from "@/test/fixtures/onboarding/scim-test-success.json";
import { StepScimProvisioning } from "./step-scim-provisioning";

const base = env.NEXT_PUBLIC_API_BASE_URL;
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("StepScimProvisioning — optional step with Skip", () => {
  it("Skip is always available and calls onSkip without requiring a token to be generated first", async () => {
    const onSkip = vi.fn();
    const user = userEvent.setup();
    render(<StepScimProvisioning tenantId="t1" onSkip={onSkip} onConfigured={vi.fn()} />, { wrapper });
    await user.click(screen.getByRole("button", { name: /Skip/ }));
    expect(onSkip).toHaveBeenCalled();
  });

  it("generating a token shows it once and Test Provisioning surfaces a failure with skip guidance", async () => {
    server.use(
      http.post(`${base}/api/v1/tenants/:tenantId/scim/tokens`, () => HttpResponse.json({ id: "tok1", description: "Onboarding wizard", createdAt: "2026-08-20T00:00:00Z", token: "scim_abc123" }, { status: 201 })),
      http.post(`${base}/api/v1/tenants/:tenantId/scim/test`, () => HttpResponse.json(scimTestFailureFixture)),
    );
    const onConfigured = vi.fn();
    const user = userEvent.setup();
    render(<StepScimProvisioning tenantId="t1" onSkip={vi.fn()} onConfigured={onConfigured} />, { wrapper });

    await user.click(screen.getByRole("button", { name: /Generate SCIM Bearer Token/ }));
    expect(await screen.findByText("scim_abc123")).toBeInTheDocument();
    expect(onConfigured).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Test Provisioning/ }));
    await screen.findByText(/SCIM provisioning test failed/);
    expect(screen.getByText(/skip this step and configure SCIM later/)).toBeInTheDocument();
  });

  it("Test Provisioning shows a success banner when every diagnostic passes", async () => {
    server.use(
      http.post(`${base}/api/v1/tenants/:tenantId/scim/tokens`, () => HttpResponse.json({ id: "tok1", description: "Onboarding wizard", createdAt: "2026-08-20T00:00:00Z", token: "scim_abc123" }, { status: 201 })),
      http.post(`${base}/api/v1/tenants/:tenantId/scim/test`, () => HttpResponse.json(scimTestSuccessFixture)),
    );
    const user = userEvent.setup();
    render(<StepScimProvisioning tenantId="t1" onSkip={vi.fn()} onConfigured={vi.fn()} />, { wrapper });
    await user.click(screen.getByRole("button", { name: /Generate SCIM Bearer Token/ }));
    await screen.findByText("scim_abc123");
    await user.click(screen.getByRole("button", { name: /Test Provisioning/ }));
    expect(await screen.findByText(/SCIM provisioning validated successfully/)).toBeInTheDocument();
  });
});
