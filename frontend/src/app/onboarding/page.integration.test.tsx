import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";
import progressStep4Fixture from "@/test/fixtures/onboarding/progress-step4.json";
import progressExpiredFixture from "@/test/fixtures/onboarding/progress-expired.json";
import tenantProvisionedFixture from "@/test/fixtures/onboarding/tenant-provisioned.json";
import OnboardingPage from "./page";

const base = env.NEXT_PUBLIC_API_BASE_URL;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const defaultHandlers = [
  http.post(`${base}/api/v1/tenants`, () => HttpResponse.json(tenantProvisionedFixture, { status: 201 })),
  http.get(`${base}/api/v1/tenants/:tenantId/group-mappings`, () => HttpResponse.json([])),
  http.post(`${base}/api/v1/tenants/:tenantId/auth/sso/configure`, () => HttpResponse.json({ id: "cfg1", protocol: "oidc", samlMetadataUrl: null, samlEntityId: null, oidcDiscoveryUrl: "https://idp.test/.well-known/openid-configuration", oidcClientId: "client-1", redirectUri: "https://app.test/api/v1/auth/oidc/callback" })),
  http.post(`${base}/api/v1/onboarding/:tenantId/progress`, () => HttpResponse.json({ saved: true, updatedAt: "2026-08-20T00:00:00Z" })),
  http.get(`${base}/api/v1/onboarding/:tenantId/progress`, () => new HttpResponse(null, { status: 404 })),
];

const server = setupServer(...defaultHandlers);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers(...defaultHandlers));
afterAll(() => server.close());

beforeEach(() => {
  useAppStore.setState({ auth: { userId: "u1", tenantId: null, roles: ["platform_admin"], permissions: [], token: "jwt-abc" } });
});

describe("Onboarding wizard — end-to-end flow (MSW)", () => {
  it("Step 1 provisions the tenant, Step 2 saves SSO config, Steps 3 and 4 can be skipped, and progress is auto-persisted along the way", async () => {
    const user = userEvent.setup();
    render(<OnboardingPage />, { wrapper });

    await user.type(screen.getByLabelText(/Organization name/), "Acme Health");
    await user.type(screen.getByLabelText(/Primary admin contact email/), "admin@acme.test");
    await user.click(screen.getByRole("button", { name: "Provision Organization" }));
    await user.click(await screen.findByRole("button", { name: "Confirm and Provision" }));

    // Step 2: SSO Configuration.
    await screen.findByRole("heading", { name: "SSO Configuration" });
    await user.click(screen.getByRole("radio", { name: "OIDC" }));
    await user.type(screen.getByLabelText(/Discovery URL/), "https://idp.test/.well-known/openid-configuration");
    await user.type(screen.getByLabelText(/^Client ID/), "client-1");
    await user.type(screen.getByLabelText(/Client secret/), "shh-secret");
    await user.click(screen.getByRole("button", { name: "Save SSO Configuration" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue to SCIM Provisioning" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Continue to SCIM Provisioning" }));

    // Step 3: SCIM — skip it.
    await screen.findByText("SCIM Provisioning (optional)");
    await user.click(screen.getByRole("button", { name: /Skip — configure SCIM later/ }));

    // Step 4: First Agent — skip it.
    await screen.findByText("First Agent Registration");
    await user.click(screen.getByRole("button", { name: /Skip — I will register agents later/ }));

    // Step 5: Team & RBAC reached — skipped steps show in the indicator.
    await screen.findByText("Team & RBAC Setup");
    expect(screen.getByText(/SCIM Provisioning/).closest("li")).toHaveTextContent("skipped");
    expect(screen.getByText(/First Agent/).closest("li")).toHaveTextContent("skipped");
  });

  it("shows a 'Welcome back' message and resumes from the persisted step when progress already exists", async () => {
    useAppStore.setState({ auth: { userId: "u1", tenantId: "tenant-1", roles: ["platform_admin"], permissions: [], token: "jwt-abc" } });
    server.use(http.get(`${base}/api/v1/onboarding/:tenantId/progress`, () => HttpResponse.json(progressStep4Fixture)));

    render(<OnboardingPage />, { wrapper });

    expect(await screen.findByText(/Welcome back — resuming from Step 4/)).toBeInTheDocument();
    expect(await screen.findByText("First Agent Registration")).toBeInTheDocument();
  });

  it("displays an expiration message and offers to restart when the persisted session is past its 7-day window", async () => {
    useAppStore.setState({ auth: { userId: "u1", tenantId: "tenant-1", roles: ["platform_admin"], permissions: [], token: "jwt-abc" } });
    server.use(http.get(`${base}/api/v1/onboarding/:tenantId/progress`, () => HttpResponse.json(progressExpiredFixture)));

    render(<OnboardingPage />, { wrapper });

    expect(await screen.findByText(/Onboarding session expired/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart Onboarding" })).toBeInTheDocument();
  });
});
