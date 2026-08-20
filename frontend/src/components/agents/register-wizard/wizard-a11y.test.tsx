import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";
import { env } from "@/env";
import langchainSchema from "@/schemas/framework-connection/langchain.schema.json";
import restSchema from "@/schemas/framework-connection/rest.schema.json";
import type { FrameworkConnectionSchema } from "@/schemas/framework-connection/types";
import { server } from "@/test/msw/server";
import { expectNoA11yViolations } from "@/test/a11y/axe-setup";
import { MultiStepWizard } from "./multi-step-wizard";
import { SchemaFormRenderer } from "./schema-form-renderer";
import { StepAssignTeam } from "./step-assign-team";
import { StepConfigureConnection } from "./step-configure-connection";
import { StepSelectFramework } from "./step-select-framework";
import { StepValidateConfirm } from "./step-validate-confirm";

const langchain = langchainSchema as FrameworkConnectionSchema;
const rest = restSchema as FrameworkConnectionSchema;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("Register Agent wizard — axe accessibility (WCAG 2.1 AA)", () => {
  it("Step 1 (Select Framework) has no critical/serious violations", async () => {
    const { container } = render(
      <MultiStepWizard currentStep={1} onBack={vi.fn()} onNext={vi.fn()} canGoBack={false} canGoNext={false} isLastStep={false}>
        <StepSelectFramework selected={null} onSelect={vi.fn()} />
      </MultiStepWizard>,
    );
    await expectNoA11yViolations(container);
  });

  it("Step 2 (Configure Connection) — LangChain schema — has no critical/serious violations", async () => {
    const { container } = render(
      <MultiStepWizard currentStep={2} onBack={vi.fn()} onNext={vi.fn()} canGoBack canGoNext={false} isLastStep={false}>
        <StepConfigureConnection
          framework="langchain"
          agentName=""
          onAgentNameChange={vi.fn()}
          agentNameError={null}
          description=""
          onDescriptionChange={vi.fn()}
          connectionFieldValues={{}}
          fieldErrors={{}}
          onFieldChange={vi.fn()}
          onFieldErrorsChange={vi.fn()}
        />
      </MultiStepWizard>,
    );
    await expectNoA11yViolations(container);
  });

  it("Step 2 (Configure Connection) — REST schema, including the key-value editor — has no critical/serious violations", async () => {
    const { container } = render(<SchemaFormRenderer schema={rest} values={{ customHeaders: [{ key: "X-Api-Version", value: "2" }] }} errors={{}} onFieldChange={vi.fn()} onFieldErrorsChange={vi.fn()} idPrefix="rest" />);
    await expectNoA11yViolations(container);
  });

  it("Step 3 (Assign Team) has no critical/serious violations", async () => {
    server.use(http.get(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/teams`, () => HttpResponse.json({ teams: [{ id: "t1", name: "Platform Team", memberCount: 5 }] })));
    const { container, findByLabelText } = render(<StepAssignTeam teamId={null} onSelectTeam={vi.fn()} />, { wrapper });
    await findByLabelText(/^Team/);
    await expectNoA11yViolations(container);
  });

  it("Step 4 (Validate & Confirm) success screen has no critical/serious violations", async () => {
    server.use(
      http.get(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/agents/:id`, () =>
        HttpResponse.json({
          id: "agent-1",
          name: "Support Bot",
          framework: "generic_rest",
          lifecycleStatus: "active",
          team: { id: "t1", name: "Platform Team" },
          connectionValidation: { status: "success", message: "Connection validated successfully.", completedAt: "2026-08-20T12:00:00Z" },
          appliedPolicies: { rbac: ["agent_management:agent:read"], creditBudget: { amount: 100, currency: "credits" } },
        }),
      ),
    );
    const request = { name: "Support Bot", framework: "generic_rest" as const, teamId: "t1", connectionConfig: {} };
    const { container, findByText } = render(
      <StepValidateConfirm request={request} onFieldErrors={vi.fn()} onBackToConfigure={vi.fn()} onAgentCreated={vi.fn()} createdAgentId="agent-1" />,
      { wrapper },
    );
    await findByText(/Agent registered successfully/);
    await expectNoA11yViolations(container);
  });

  it("Step 4 (Validate & Confirm) validation-failure screen has no critical/serious violations", async () => {
    server.use(
      http.get(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/agents/:id`, () =>
        HttpResponse.json({
          id: "agent-1",
          name: "Support Bot",
          framework: "generic_rest",
          lifecycleStatus: "connecting",
          team: { id: "t1", name: "Platform Team" },
          connectionValidation: { status: "failed", message: "Could not reach endpoint.", completedAt: "2026-08-20T12:00:00Z" },
        }),
      ),
    );
    const request = { name: "Support Bot", framework: "generic_rest" as const, teamId: "t1", connectionConfig: {} };
    const { container, findByText } = render(
      <StepValidateConfirm request={request} onFieldErrors={vi.fn()} onBackToConfigure={vi.fn()} onAgentCreated={vi.fn()} createdAgentId="agent-1" />,
      { wrapper },
    );
    await findByText(/Connection validation failed/);
    await expectNoA11yViolations(container);
  });

  it("Step 1 with a field validation error present has no critical/serious violations", async () => {
    const { container } = render(
      <SchemaFormRenderer schema={langchain} values={{ apiEndpointUrl: "not-a-url" }} errors={{ apiEndpointUrl: "API Endpoint URL must be a valid URL (e.g. https://example.com)." }} onFieldChange={vi.fn()} onFieldErrorsChange={vi.fn()} idPrefix="lc" />,
    );
    await expectNoA11yViolations(container);
  });
});
