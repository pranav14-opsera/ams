import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TeamUsageSummary } from "@/types/dashboard";

function formatCredits(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function formatUtilization(utilizationPct: number | null): string {
  if (utilizationPct === null) return "Not budgeted";
  return `${utilizationPct}%`;
}

/** AC 2: team KPIs — team credit balance, team consumption (current period), team burn rate, agent count, budget utilization percentage, with a color-coded utilization indicator. */
export function TeamUsageKPICards({ summary }: { summary: TeamUsageSummary }) {
  const { balance, burnRate, agentCount } = summary;
  const utilizationColor = balance.utilizationPct === null ? undefined : balance.utilizationPct >= 90 ? "text-red-700" : balance.utilizationPct >= 75 ? "text-amber-600" : "text-green-700";

  const tiles: Array<{ key: string; label: string; value: string; valueColor?: string }> = [
    { key: "balance", label: "Team Credit Balance", value: formatCredits(balance.remaining) },
    { key: "consumed", label: "Consumed (Period)", value: formatCredits(balance.consumed) },
    { key: "burn-rate", label: "Burn Rate", value: `${formatCredits(burnRate.creditsPerDay)} / day` },
    { key: "agent-count", label: "Agent Count", value: formatCredits(agentCount) },
    { key: "utilization", label: "Budget Utilization", value: formatUtilization(balance.utilizationPct), valueColor: utilizationColor },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5" role="group" aria-label={`${summary.team.name} usage summary`}>
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
