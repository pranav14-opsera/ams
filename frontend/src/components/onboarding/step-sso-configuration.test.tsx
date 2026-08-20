import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "@/env";
import ssoTestFailureFixture from "@/test/fixtures/onboarding/sso-test-failure.json";
import ssoTestSuccessFixture from "@/test/fixtures/onboarding/sso-test-success.json";
import { StepSsoConfiguration } from "./step-sso-configuration";

const base = env.NEXT_PUBLIC_API_BASE_URL;
const server = setupServer(http.get(`${base}/api/v1/tenants/:tenantId/group-mappings`, () => HttpResponse.json([])));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("StepSsoConfiguration — protocol-conditional rendering", () => {
  it("defaults to SAML fields and hides OIDC-only fields", async () => {
    render(<StepSsoConfiguration tenantId="t1" config={null} onConfigured={vi.fn()} />, { wrapper });
    expect(await screen.findByLabelText(/IdP metadata URL/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Entity ID/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Discovery URL/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Client secret/)).not.toBeInTheDocument();
  });

  it("switching to OIDC swaps in Discovery URL / Client ID / Client secret and hides SAML-only fields", async () => {
    const user = userEvent.setup();
    render(<StepSsoConfiguration tenantId="t1" config={null} onConfigured={vi.fn()} />, { wrapper });
    await user.click(screen.getByRole("radio", { name: "OIDC" }));

    expect(screen.getByLabelText(/Discovery URL/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Client ID/)).toBeInTheDocument();
    const secretInput = screen.getByLabelText(/Client secret/);
    expect(secretInput).toHaveAttribute("type", "password");
    expect(screen.queryByLabelText(/IdP metadata URL/)).not.toBeInTheDocument();
  });

  it("the group-to-role mapping dropdown offers all 5 platform roles", async () => {
    render(<StepSsoConfiguration tenantId="t1" config={null} onConfigured={vi.fn()} />, { wrapper });
    const select = await screen.findByLabelText(/Platform role/);
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(["Platform Administrator", "Team Lead", "Agent Operator", "Finance Manager", "Compliance Officer"]);
  });

  it("Test SSO Connection is disabled until a configuration has been saved", () => {
    render(<StepSsoConfiguration tenantId="t1" config={null} onConfigured={vi.fn()} />, { wrapper });
    expect(screen.getByRole("button", { name: /Test SSO Connection/ })).toBeDisabled();
  });

  it("Test SSO Connection is enabled once a configuration exists and shows a failure with per-check diagnostics", async () => {
    server.use(http.post(`${base}/api/v1/tenants/:tenantId/auth/sso/test`, () => HttpResponse.json(ssoTestFailureFixture)));
    const user = userEvent.setup();
    render(
      <StepSsoConfiguration
        tenantId="t1"
        config={{ id: "cfg1", protocol: "saml", samlMetadataUrl: "https://idp.test/metadata", samlEntityId: "ams-platform", oidcDiscoveryUrl: null, oidcClientId: null }}
        onConfigured={vi.fn()}
      />,
      { wrapper },
    );
    const testButton = screen.getByRole("button", { name: /Test SSO Connection/ });
    expect(testButton).toBeEnabled();
    await user.click(testButton);

    expect(await screen.findByText(/SSO connection test failed/)).toBeInTheDocument();
    expect(screen.getByText(ssoTestFailureFixture.errorMessage)).toBeInTheDocument();
  });

  it("Test SSO Connection shows a success banner when every diagnostic passes", async () => {
    server.use(http.post(`${base}/api/v1/tenants/:tenantId/auth/sso/test`, () => HttpResponse.json(ssoTestSuccessFixture)));
    const user = userEvent.setup();
    render(
      <StepSsoConfiguration
        tenantId="t1"
        config={{ id: "cfg1", protocol: "oidc", samlMetadataUrl: null, samlEntityId: null, oidcDiscoveryUrl: "https://idp.test/.well-known/openid-configuration", oidcClientId: "client-1" }}
        onConfigured={vi.fn()}
      />,
      { wrapper },
    );
    await user.click(screen.getByRole("button", { name: /Test SSO Connection/ }));
    expect(await screen.findByText(/SSO connection validated successfully/)).toBeInTheDocument();
  });
});
