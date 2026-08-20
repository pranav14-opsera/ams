import { setupServer } from "msw/node";
import { wizardHandlers } from "./handlers";

/** Node-side MSW server for the wizard's own integration tests (testing_strategy: "Integration tests using MSW mock POST /api/v1/agents and GET /api/v1/agents/{id}"). Each test file owns its own listen/resetHandlers/close lifecycle rather than a global setup — this codebase's other API-hitting tests use a plain `vi.stubGlobal("fetch", ...)` mock (see useAgentRegistryQuery.test.tsx) and this stays opt-in so it never interferes with those. */
export const server = setupServer(...wizardHandlers);
