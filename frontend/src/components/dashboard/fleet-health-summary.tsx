import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { FleetHealthSummary as FleetHealthSummaryData } from "@/types/dashboard";

const SUMMARY_TILES: Array<{ key: keyof FleetHealthSummaryData; label: string; valueColor?: string }> = [
  { key: "totalAgents", label: "Total Agents" },
  { key: "activePct", label: "Healthy %", valueColor: "text-green-700" },
  { key: "degradedPct", label: "Degraded %", valueColor: "text-amber-700" },
  { key: "errorPct", label: "Error %", valueColor: "text-red-700" },
];

/** Progressive-disclosure entry point (AC): aggregate counts first, individual agent detail (AgentHealthCard/table) below. */
export function FleetHealthSummary({ summary }: { summary: FleetHealthSummaryData }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4" role="group" aria-label="Fleet health summary">
      {SUMMARY_TILES.map((tile) => (
        <Card key={tile.key}>
          <CardHeader>
            <CardTitle>{tile.label}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-semibold ${tile.valueColor ?? ""}`}>
              {summary[tile.key]}
              {tile.key !== "totalAgents" ? "%" : ""}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
