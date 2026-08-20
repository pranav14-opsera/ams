import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/env";
import { useAppStore } from "@/stores/app-store";
import agentActiveFixture from "@/test/fixtures/wizard/agent-active.json";
import agentValidationFailedFixture from "@/test/fixtures/wizard/agent-validation-failed.json";
import createAgentConflictFixture from "@/test/fixtures/wizard/create-agent-conflict.json";
import { server } from "@/test/msw/server";
import RegisterAgentPage from "./page";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

async function selectFrameworkAndFillLangChain(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("radio", { name: /LangChain/ }));

  await user.type(screen.getByLabelText(/Agent name/), "Support Bot");
  await user.type(screen.getByLabelText(/API Endpoint URL/), "https://agent.example.com");
  await user.type(screen.getByLabelText(/API Key/), "sk-test-123");
  await user.type(screen.getByLabelText(/Telemetry Callback URL/), "https://ams.example.com/callback");
  await user.selectOptions(screen.getByLabelText(/Framework Version/), "0.3.x");
}

describe("Register Agent wizard — end-to-end flow (MSW)", () => {
  beforeEach(() => {
    useAppStore.setState({ auth: { userId: "u1", tenantId: "t1", roles: ["platform_admin"], permissions: ["agent_management:agent:create"], token: "jwt-abc" } });
  });

  it("happy path: framework -> configure -> team -> validate -> success screen", async () => {
    server.use(
      http.get(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/agents/:id`, () => HttpResponse.json(agentActiveFixture)),
    );

    const user = userEvent.setup();
    render(<RegisterAgentPage />, { wrapper });

    await selectFrameworkAndFillLangChain(user);
    await user.click(screen.getByRole("button", { name: /^Next$/ }));

    // Step 3: Assign Team.
    await screen.findByLabelText(/^Team/);
    await user.selectOptions(screen.getByLabelText(/^Team/), "Platform Team (5 members)");
    await user.click(screen.getByRole("button", { name: /Continue to Validate & Confirm/ }));

    // Step 4: submits, polls, and lands on the success screen.
    await waitFor(() => expect(screen.getByText(/Agent registered successfully/)).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.getByText("Support Bot")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View in Registry/ })).toHaveAttribute("href", "/agents/registry");
    expect(screen.getByText(/5000 credits/)).toBeInTheDocument();
  });

  it("duplicate agent name (409) shows a conflict banner and offers a way back to Configure Connection", async () => {
    server.use(http.post(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/agents`, () => HttpResponse.json(createAgentConflictFixture, { status: 409 })));

    const user = userEvent.setup();
    render(<RegisterAgentPage />, { wrapper });

    await selectFrameworkAndFillLangChain(user);
    await user.click(screen.getByRole("button", { name: /^Next$/ }));
    await screen.findByLabelText(/^Team/);
    await user.selectOptions(screen.getByLabelText(/^Team/), "Platform Team (5 members)");
    await user.click(screen.getByRole("button", { name: /Continue to Validate & Confirm/ }));

    await waitFor(() => expect(screen.getByText(/Go back and choose a different agent name/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Back to Configure Connection/ })).toBeInTheDocument();
  });

  it("a connection validation failure surfaces the server's remediation message and a Retry option", async () => {
    server.use(http.get(`${env.NEXT_PUBLIC_API_BASE_URL}/api/v1/agents/:id`, () => HttpResponse.json(agentValidationFailedFixture)));

    const user = userEvent.setup();
    render(<RegisterAgentPage />, { wrapper });

    await selectFrameworkAndFillLangChain(user);
    await user.click(screen.getByRole("button", { name: /^Next$/ }));
    await screen.findByLabelText(/^Team/);
    await user.selectOptions(screen.getByLabelText(/^Team/), "Platform Team (5 members)");
    await user.click(screen.getByRole("button", { name: /Continue to Validate & Confirm/ }));

    await waitFor(() => expect(screen.getByText(/Connection validation failed/)).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.getByText(/Could not reach endpoint/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Back to Configure Connection/ })).toBeInTheDocument();
  });

  it("a non-admin caller sees a permission message instead of the wizard", () => {
    useAppStore.setState({ auth: { userId: "u2", tenantId: "t1", roles: ["agent_operator"], permissions: [], token: "jwt-abc" } });
    render(<RegisterAgentPage />, { wrapper });
    expect(screen.getByRole("alert")).toHaveTextContent(/don't have permission/);
    expect(screen.queryByRole("radio", { name: /LangChain/ })).not.toBeInTheDocument();
  });

  it("the REST framework's Next button stays disabled until every required field is valid", async () => {
    const user = userEvent.setup();
    render(<RegisterAgentPage />, { wrapper });

    await user.click(screen.getByRole("radio", { name: /Generic REST/ }));
    await user.type(screen.getByLabelText(/Agent name/), "Support Bot");
    expect(screen.getByRole("button", { name: /^Next$/ })).toBeDisabled();

    await user.type(screen.getByLabelText(/Base URL/), "https://agent.example.com");
    await user.selectOptions(screen.getByLabelText(/Authentication Method/), "api_key");
    await user.type(screen.getByLabelText(/Health Check Endpoint/), "/health");
    await user.type(screen.getByLabelText(/Telemetry Webhook URL/), "https://ams.example.com/webhook");

    await waitFor(() => expect(screen.getByRole("button", { name: /^Next$/ })).toBeEnabled());
  });

  it("CrewAI/AutoGen cards are visible but disabled (Phase 1 only selects LangChain/REST)", () => {
    render(<RegisterAgentPage />, { wrapper });
    const crewAiCard = screen.getByRole("radio", { name: /CrewAI/ });
    expect(crewAiCard).toHaveAttribute("aria-disabled", "true");
  });
});
