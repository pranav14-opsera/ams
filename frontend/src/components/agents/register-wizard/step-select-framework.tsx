"use client";

import { Bot, Globe, Users, Workflow, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { FRAMEWORK_OPTIONS } from "@/schemas/framework-connection/frameworks";
import type { AgentFramework } from "@/types/dashboard";

// Same framework -> icon vocabulary as WO-079's FrameworkBadge, so a
// framework reads identically in the wizard and the registry table.
const FRAMEWORK_ICON: Record<AgentFramework, LucideIcon> = {
  langchain: Workflow,
  crewai: Users,
  autogen: Bot,
  generic_rest: Globe,
};

export interface StepSelectFrameworkProps {
  selected: AgentFramework | null;
  onSelect: (framework: AgentFramework) => void;
}

/** AC 2: "framework options... as selectable cards with framework icon, name, and brief description; selecting a framework advances to Step 2." */
export function StepSelectFramework({ selected, onSelect }: StepSelectFrameworkProps) {
  return (
    <div>
      <h2 className="text-lg font-semibold">Select a framework</h2>
      <p className="text-muted-foreground mb-4 text-sm">Choose the framework your agent is built with.</p>
      <div role="radiogroup" aria-label="Agent framework" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {FRAMEWORK_OPTIONS.map((option) => {
          const Icon = FRAMEWORK_ICON[option.id];
          const isSelected = selected === option.id;
          return (
            <Card
              key={option.id}
              role="radio"
              aria-checked={isSelected}
              aria-disabled={!option.available}
              tabIndex={option.available ? 0 : -1}
              onClick={() => option.available && onSelect(option.id)}
              onKeyDown={(e) => {
                if (!option.available) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(option.id);
                }
              }}
              className={cn(
                "cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
                isSelected && "ring-primary ring-2",
                !option.available && "cursor-not-allowed opacity-60",
              )}
            >
              <CardHeader className="flex-row items-center gap-3 space-y-0">
                <Icon aria-hidden="true" className="size-5" />
                <CardTitle className="flex-1">{option.label}</CardTitle>
                {option.phase === "phase-2" && <Badge variant="neutral">Phase 2</Badge>}
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">{option.description}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
