"use client";

import { resolveFrameworkSchema } from "@/schemas/framework-connection/registry";
import type { AgentFramework } from "@/types/dashboard";
import { SchemaFormRenderer } from "./schema-form-renderer";

export interface StepConfigureConnectionProps {
  framework: AgentFramework;
  agentName: string;
  onAgentNameChange: (name: string) => void;
  agentNameError: string | null;
  description: string;
  onDescriptionChange: (description: string) => void;
  connectionFieldValues: Record<string, unknown>;
  fieldErrors: Record<string, string>;
  onFieldChange: (field: string, value: unknown) => void;
  onFieldErrorsChange: (errors: Record<string, string>) => void;
}

/**
 * AC 3: "renders framework-specific configuration fields dynamically
 * based on a JSON schema definition for the selected framework, with
 * real-time field validation and contextual help text." edge_case:
 * "Framework schema loading failure... fallback to a generic key-value
 * configuration form" — resolveFrameworkSchema returning null (an
 * unregistered framework) is exactly that case.
 */
export function StepConfigureConnection({
  framework,
  agentName,
  onAgentNameChange,
  agentNameError,
  description,
  onDescriptionChange,
  connectionFieldValues,
  fieldErrors,
  onFieldChange,
  onFieldErrorsChange,
}: StepConfigureConnectionProps) {
  const schema = resolveFrameworkSchema(framework);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">Configure connection</h2>
        <p className="text-muted-foreground text-sm">Name your agent and provide its {schema?.title ?? framework} connection details.</p>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="agent-name" className="text-sm font-medium">
          Agent name <span aria-hidden="true">*</span>
        </label>
        <input
          id="agent-name"
          type="text"
          value={agentName}
          onChange={(e) => onAgentNameChange(e.target.value)}
          aria-required="true"
          aria-invalid={Boolean(agentNameError)}
          aria-describedby={agentNameError ? "agent-name-error" : undefined}
          className="border-border h-9 max-w-md rounded-md border bg-transparent px-2 text-sm"
        />
        {agentNameError && (
          <p id="agent-name-error" role="alert" className="text-sm text-red-700">
            {agentNameError}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="agent-description" className="text-sm font-medium">
          Description
        </label>
        <textarea
          id="agent-description"
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          maxLength={500}
          rows={2}
          className="border-border max-w-md rounded-md border bg-transparent px-2 py-1 text-sm"
        />
      </div>

      {schema ? (
        <SchemaFormRenderer
          schema={schema}
          values={connectionFieldValues}
          errors={fieldErrors}
          onFieldChange={onFieldChange}
          onFieldErrorsChange={onFieldErrorsChange}
          idPrefix="connection"
        />
      ) : (
        <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          No connection schema is available for this framework yet. Enter raw key/value configuration instead.
        </div>
      )}
    </div>
  );
}
