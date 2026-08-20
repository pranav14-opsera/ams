"use client";

import { useEffect, useRef } from "react";
import { orderedFieldNames } from "@/schemas/framework-connection/registry";
import type { FrameworkConnectionSchema } from "@/schemas/framework-connection/types";
import { validateFieldValue } from "./field-validation";
import { KeyValueEditor, type KeyValuePair } from "./key-value-editor";

export interface SchemaFormRendererProps {
  schema: FrameworkConnectionSchema;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  onFieldChange: (field: string, value: unknown) => void;
  onFieldErrorsChange: (errors: Record<string, string>) => void;
  idPrefix: string;
}

const DEBOUNCE_MS = 300; // edge_case: "real-time validation with debounce (300ms) shows inline error before form submission."

/**
 * WO-080's own JSON-schema-driven dynamic form renderer — technical_details'
 * literal schema-to-component mapping: string -> Input, string+format:uri ->
 * URL Input, string+format:password -> masked Input, enum -> Select, array
 * of objects -> KeyValueEditor, boolean -> Checkbox. Adding a framework is
 * purely a new schema file in schemas/framework-connection/ (registered in
 * registry.ts) — this component never branches on a specific framework
 * name, only on each property's own `type`/`format`/`x-widget`.
 */
export function SchemaFormRenderer({ schema, values, errors, onFieldChange, onFieldErrorsChange, idPrefix }: SchemaFormRendererProps) {
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    const timers = debounceTimers.current;
    return () => {
      for (const timer of Object.values(timers)) clearTimeout(timer);
    };
  }, []);

  function validateAndSetError(fieldName: string, value: unknown) {
    const property = schema.properties[fieldName]!;
    const error = validateFieldValue(property, schema.required.includes(fieldName), value);
    const next = { ...errors };
    if (error) next[fieldName] = error;
    else delete next[fieldName];
    onFieldErrorsChange(next);
  }

  function handleChange(fieldName: string, value: unknown) {
    onFieldChange(fieldName, value);
    const existing = debounceTimers.current[fieldName];
    if (existing) clearTimeout(existing);
    debounceTimers.current[fieldName] = setTimeout(() => validateAndSetError(fieldName, value), DEBOUNCE_MS);
  }

  function handleBlur(fieldName: string, value: unknown) {
    const existing = debounceTimers.current[fieldName];
    if (existing) clearTimeout(existing);
    validateAndSetError(fieldName, value);
  }

  return (
    <div className="flex flex-col gap-5">
      {orderedFieldNames(schema).map((fieldName) => {
        const property = schema.properties[fieldName]!;
        const fieldId = `${idPrefix}-${fieldName}`;
        const errorId = `${fieldId}-error`;
        const helpId = `${fieldId}-help`;
        const value = values[fieldName];
        const error = errors[fieldName];
        const isRequired = schema.required.includes(fieldName);

        if (property["x-widget"] === "keyvalue") {
          return (
            <KeyValueEditor
              key={fieldName}
              id={fieldId}
              label={property.title}
              pairs={(value as KeyValuePair[] | undefined) ?? []}
              onChange={(pairs) => handleChange(fieldName, pairs)}
            />
          );
        }

        if (property["x-widget"] === "select") {
          return (
            <div key={fieldName} className="flex flex-col gap-1">
              <label htmlFor={fieldId} className="text-sm font-medium">
                {property.title}
                {isRequired && <span aria-hidden="true"> *</span>}
              </label>
              {property.description && (
                <p id={helpId} className="text-muted-foreground text-sm">
                  {property.description}
                </p>
              )}
              <select
                id={fieldId}
                value={(value as string | undefined) ?? ""}
                required={isRequired}
                aria-required={isRequired}
                aria-invalid={Boolean(error)}
                aria-describedby={[property.description ? helpId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined}
                onChange={(e) => handleChange(fieldName, e.target.value)}
                onBlur={(e) => handleBlur(fieldName, e.target.value)}
                className="border-border h-9 rounded-md border bg-transparent px-2 text-sm"
              >
                <option value="" disabled>
                  Select {property.title.toLowerCase()}…
                </option>
                {(property.enum ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              {error && (
                <p id={errorId} role="alert" className="text-sm text-red-700">
                  {error}
                </p>
              )}
            </div>
          );
        }

        const inputType = property["x-widget"] === "password" ? "password" : property["x-widget"] === "url" ? "url" : "text";
        return (
          <div key={fieldName} className="flex flex-col gap-1">
            <label htmlFor={fieldId} className="text-sm font-medium">
              {property.title}
              {isRequired && <span aria-hidden="true"> *</span>}
            </label>
            {property.description && (
              <p id={helpId} className="text-muted-foreground text-sm">
                {property.description}
              </p>
            )}
            <input
              id={fieldId}
              type={inputType}
              // Credential fields are never autocompleted or persisted client-side (constraints: "the client never persists credentials").
              autoComplete={inputType === "password" ? "new-password" : "off"}
              value={(value as string | undefined) ?? ""}
              required={isRequired}
              aria-required={isRequired}
              aria-invalid={Boolean(error)}
              aria-describedby={[property.description ? helpId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined}
              onChange={(e) => handleChange(fieldName, e.target.value)}
              onBlur={(e) => handleBlur(fieldName, e.target.value)}
              className="border-border h-9 rounded-md border bg-transparent px-2 text-sm"
            />
            {error && (
              <p id={errorId} role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
