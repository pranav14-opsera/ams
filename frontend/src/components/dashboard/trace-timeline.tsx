"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AgentExecutionTrace } from "@/types/dashboard";

const MASK_TOKEN = "[MASKED]"; // matches PhiScrubberService's MASK_TOKEN (backend/src/phi-scrubber/phi-patterns.ts) exactly — this is what a scrubbed field looks like by the time it reaches this component.

/** Renders text with every "[MASKED]" occurrence visually distinguished, so a PHI-scrubbed value clearly reads as "something was removed here" rather than looking like ordinary (possibly truncated) content. */
function renderWithMaskHighlight(text: string, keyPrefix: string) {
  return text.split(MASK_TOKEN).flatMap((segment, index, all) => {
    const piece = <span key={`${keyPrefix}-text-${index}`}>{segment}</span>;
    if (index === all.length - 1) return [piece];
    return [
      piece,
      <mark key={`${keyPrefix}-mask-${index}`} className="rounded bg-yellow-200 px-1 font-mono text-xs text-yellow-900">
        {MASK_TOKEN}
      </mark>,
    ];
  });
}

/** AC: recent execution traces as a timeline, step-by-step breakdown with tool invocations and duration, PHI-masked values clearly styled. Backend TraceService already masks PHI before this ever renders — this component never re-checks for PHI, it just renders whatever the API returned. */
export function TraceTimeline({ traces }: { traces: AgentExecutionTrace[] }) {
  if (traces.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        No recent execution traces.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-4" aria-label="Execution traces">
      {traces.map((trace) => (
        <li key={trace.id}>
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2">
              <CardTitle>{new Date(trace.startedAt).toLocaleString()}</CardTitle>
              <Badge variant={trace.status === "failed" ? "error" : trace.status === "running" ? "degraded" : "active"}>{trace.status}</Badge>
            </CardHeader>
            <CardContent>
              <ol className="flex flex-col gap-2 border-l pl-4">
                {trace.steps.map((step, index) => (
                  <li key={`${trace.id}-${index}`} className="text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">
                        {step.stepName}
                        {step.toolName ? ` (${step.toolName})` : ""}
                      </span>
                      <span className="text-muted-foreground">{step.durationMs}ms</span>
                    </div>
                    <p className={step.status === "error" ? "text-red-700" : "text-muted-foreground"}>
                      {renderWithMaskHighlight(step.inputSummary, `${trace.id}-${index}-in`)} →{" "}
                      {renderWithMaskHighlight(step.outputSummary, `${trace.id}-${index}-out`)}
                    </p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </li>
      ))}
    </ol>
  );
}
