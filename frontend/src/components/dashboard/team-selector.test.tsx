import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TeamSelector } from "./team-selector";
import { useAppStore } from "@/stores/app-store";
import { expectNoA11yViolations } from "@/test/a11y/axe-setup";

const TEAMS = [
  { id: "team-1", name: "Alpha" },
  { id: "team-2", name: "Bravo" },
];

function setRoles(roles: string[]) {
  useAppStore.setState((state) => ({ auth: { ...state.auth, roles } }));
}

describe("TeamSelector", () => {
  it("AC 6: renders a dropdown for an org-scoped role (platform_admin) when there is more than one team", () => {
    setRoles(["platform_admin"]);
    render(<TeamSelector teams={TEAMS} selectedTeamId="team-1" onChange={vi.fn()} />);
    expect(screen.getByLabelText("Select team")).toBeInTheDocument();
  });

  it("renders nothing at all for a team-scoped role (team_lead) — no selector to switch teams they can't access", () => {
    setRoles(["team_lead"]);
    const { container } = render(<TeamSelector teams={TEAMS} selectedTeamId="team-1" onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there is only one team, even for an org-scoped role (nothing to switch between)", () => {
    setRoles(["platform_admin"]);
    const { container } = render(<TeamSelector teams={TEAMS.slice(0, 1)} selectedTeamId="team-1" onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("has no axe-core accessibility violations", async () => {
    setRoles(["platform_admin"]);
    const { container } = render(<TeamSelector teams={TEAMS} selectedTeamId="team-1" onChange={vi.fn()} />);
    await expectNoA11yViolations(container);
  });
});
