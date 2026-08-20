import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "@/env";
import { StepOrganizationSetup } from "./step-organization-setup";

const base = env.NEXT_PUBLIC_API_BASE_URL;
const server = setupServer(
  http.post(`${base}/api/v1/tenants`, () => HttpResponse.json({ tenantId: "t1", name: "Acme Health", region: "us", status: "active", provisionedAt: "2026-08-20T00:00:00Z" }, { status: 201 })),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("StepOrganizationSetup — data residency permanence", () => {
  it("requires confirmation before provisioning, since data residency is a permanent choice", async () => {
    const onProvisioned = vi.fn();
    const user = userEvent.setup();
    render(<StepOrganizationSetup tenant={null} onProvisioned={onProvisioned} />, { wrapper });

    await user.type(screen.getByLabelText(/Organization name/), "Acme Health");
    await user.type(screen.getByLabelText(/Primary admin contact email/), "admin@acme.test");
    await user.click(screen.getByRole("button", { name: "Provision Organization" }));

    expect(await screen.findByText(/This choice is/)).toBeInTheDocument();
    expect(onProvisioned).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirm and Provision" }));
    // The component itself is stateless about "provisioned or not" — its
    // parent (the onboarding page) owns that via the `tenant` prop, set
    // from this callback's argument.
    await vi.waitFor(() => expect(onProvisioned).toHaveBeenCalledWith(expect.objectContaining({ id: "t1", dataResidencyRegion: "us" })));
  });

  it("renders read-only, with no region selector at all, once a tenant has already been provisioned — the residency choice cannot be revisited", () => {
    render(<StepOrganizationSetup tenant={{ id: "t1", name: "Acme Health", slug: "acme-health", dataResidencyRegion: "us" }} onProvisioned={vi.fn()} />, { wrapper });

    expect(screen.getByText(/Your organization has been provisioned/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Provision Organization" })).not.toBeInTheDocument();
  });
});
