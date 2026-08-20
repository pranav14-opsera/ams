import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { OrgUsageSummary } from "@/types/dashboard";

function formatCredits(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function formatExhaustionDate(balance: OrgUsageSummary["balance"], burnRate: OrgUsageSummary["burnRate"]): string {
  // edge_cases: "tenant at exactly 100% of credit cap ... projected exhaustion shows 'Budget exhausted'."
  if (balance.remaining <= 0) return "Budget exhausted";
  if (!burnRate.projectedExhaustionDate) return "Not projected (no recent usage)";
  return new Date(burnRate.projectedExhaustionDate).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * AC: five KPI cards — total credit balance, credits consumed (current
 * billing period), burn rate, active agent count, projected exhaustion
 * date. Progressive-disclosure entry point (AC), same shadcn/ui Card
 * shape as FleetHealthSummary (WO-056) — aggregate numbers first, trend/
 * breakdown detail below in the page composition.
 */
export function OrgUsageKPICards({ summary }: { summary: OrgUsageSummary }) {
  const { balance, burnRate, activeAgents } = summary;
  const exhaustionLabel = formatExhaustionDate(balance, burnRate);

  const tiles: Array<{ key: string; label: string; value: string; valueColor?: string }> = [
    { key: "balance", label: "Total Credit Balance", value: formatCredits(balance.total) },
    { key: "consumed", label: "Credits Consumed (Period)", value: formatCredits(balance.consumed) },
    { key: "burn-rate", label: "Burn Rate", value: `${formatCredits(burnRate.creditsPerDay)} / day` },
    { key: "active-agents", label: "Active Agents", value: formatCredits(activeAgents) },
    {
      key: "exhaustion",
      label: "Projected Exhaustion",
      value: exhaustionLabel,
      valueColor: balance.remaining <= 0 ? "text-red-700" : undefined,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5" role="group" aria-label="Organization usage summary">
      {tiles.map((tile) => (
        <Card key={tile.key}>
          <CardHeader>
            <CardTitle>{tile.label}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-semibold ${tile.valueColor ?? ""}`} aria-label={`${tile.label}: ${tile.value}`}>
              {tile.value}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
