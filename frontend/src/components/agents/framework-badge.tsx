import { Bot, Globe, HelpCircle, Users, Workflow, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { AgentFramework } from "@/types/dashboard";

const FRAMEWORK_LABEL: Record<AgentFramework, string> = {
  langchain: "LangChain",
  crewai: "CrewAI",
  autogen: "AutoGen",
  generic_rest: "REST",
};

const FRAMEWORK_ICON: Record<AgentFramework, LucideIcon> = {
  langchain: Workflow,
  crewai: Users,
  autogen: Bot,
  generic_rest: Globe,
};

export interface FrameworkBadgeProps {
  /** A raw string, not AgentFramework — edge case (per WO-079's own edge_cases): Phase 2 framework values (or any future/unrecognized adapter type) must render a generic fallback badge rather than crash. */
  framework: string;
}

/**
 * AC: "a visually distinct framework badge (icon + label)" for LangChain,
 * CrewAI, AutoGen, and REST, "with a generic fallback for unknown types."
 */
export function FrameworkBadge({ framework }: FrameworkBadgeProps) {
  const isKnown = framework in FRAMEWORK_LABEL;
  const Icon = isKnown ? FRAMEWORK_ICON[framework as AgentFramework] : HelpCircle;
  const label = isKnown ? FRAMEWORK_LABEL[framework as AgentFramework] : framework || "Unknown";

  return (
    <Badge variant="neutral" className="inline-flex items-center gap-1">
      <Icon aria-hidden="true" className="h-3 w-3" />
      {label}
    </Badge>
  );
}
