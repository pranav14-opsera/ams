import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";
import { env } from "@/env";
import { expectNoA11yViolations } from "@/test/a11y/axe-setup";
import { OnboardingStepIndicator } from "./onboarding-step-indicator";
import { StepOrganizationSetup } from "./step-organization-setup";
import { StepSsoConfiguration } from "./step-sso-configuration";
import { StepScimProvisioning } from "./step-scim-provisioning";
import { StepTeamRbac } from "./step-team-rbac";
import { StepVerification } from "./step-verification";

const base = env.NEXT_PUBLIC_API_BASE_URL;
const server = setupServer(
  http.get(`${base}/api/v1/tenants/:tenantId/group-mappings`, () => HttpResponse.json([])),
  http.get(`${base}/api/v1/teams`, () => HttpResponse.json({ teams: [] })),
);

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("Onboarding wizard — axe accessibility (WCAG 2.1 AA)", () => {
  it("Step indicator has no critical/serious violations", async () => {
    const { container } = render(<OnboardingStepIndicator currentStep={2} completedSteps={[1]} skippedSteps={[]} />);
    await expectNoA11yViolations(container);
  });

  it("Step 1 (Organization Setup) has no critical/serious violations", async () => {
    const { container } = render(<StepOrganizationSetup tenant={null} onProvisioned={vi.fn()} />, { wrapper });
    await expectNoA11yViolations(container);
  });

  it("Step 2 (SSO Configuration) — SAML — has no critical/serious violations", async () => {
    const { container, findByLabelText } = render(<StepSsoConfiguration tenantId="t1" config={null} onConfigured={vi.fn()} />, { wrapper });
    await findByLabelText(/Platform role/);
    await expectNoA11yViolations(container);
  });

  it("Step 2 (SSO Configuration) — OIDC, with a saved config and test results shown — has no critical/serious violations", async () => {
    server.use(http.post(`${base}/api/v1/tenants/:tenantId/auth/sso/test`, () => HttpResponse.json({ success: true, diagnostics: { metadataFetch: "pass", certificateValidation: "pass", assertionParsing: "pass", groupMapping: "pass" }, errorMessage: null })));
    const { container, findByLabelText } = render(
      <StepSsoConfiguration tenantId="t1" config={{ id: "c1", protocol: "oidc", samlMetadataUrl: null, samlEntityId: null, oidcDiscoveryUrl: "https://idp.test/.well-known/openid-configuration", oidcClientId: "client-1" }} onConfigured={vi.fn()} />,
      { wrapper },
    );
    await findByLabelText(/Platform role/);
    await expectNoA11yViolations(container);
  });

  it("Step 3 (SCIM Provisioning) has no critical/serious violations", async () => {
    const { container } = render(<StepScimProvisioning tenantId="t1" onSkip={vi.fn()} onConfigured={vi.fn()} />, { wrapper });
    await expectNoA11yViolations(container);
  });

  it("Step 5 (Team & RBAC) has no critical/serious violations", async () => {
    const { container, findByLabelText } = render(<StepTeamRbac agentId={null} onComplete={vi.fn()} />, { wrapper });
    await findByLabelText(/Team name/);
    await expectNoA11yViolations(container);
  });

  it("Step 6 (Verification) with mixed pass/fail results has no critical/serious violations", async () => {
    server.use(
      http.get(`${base}/api/v1/onboarding/:tenantId/status`, () =>
        HttpResponse.json({
          checks: [
            { name: "sso_login", status: "pass", message: "OK" },
            { name: "agent_telemetry", status: "fail", message: "No agent active yet." },
          ],
          allPassed: false,
        }),
      ),
    );
    const { container, findByText } = render(<StepVerification tenantId="t1" onComplete={vi.fn()} />, { wrapper });
    await findByText("Failing");
    await expectNoA11yViolations(container);
  });
});
