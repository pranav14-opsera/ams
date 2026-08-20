"use client";

import { Button } from "@/components/ui/button";

export interface KeyValuePair {
  key: string;
  value: string;
}

export interface KeyValueEditorProps {
  id: string;
  label: string;
  pairs: KeyValuePair[];
  onChange: (pairs: KeyValuePair[]) => void;
}

/** Schema-to-component mapping: `array of {key,value} objects` -> this editor (technical_details' own literal mapping) — Generic REST's optional custom headers. */
export function KeyValueEditor({ id, label, pairs, onChange }: KeyValueEditorProps) {
  function updatePair(index: number, field: "key" | "value", value: string) {
    const next = pairs.map((pair, i) => (i === index ? { ...pair, [field]: value } : pair));
    onChange(next);
  }

  function removePair(index: number) {
    onChange(pairs.filter((_, i) => i !== index));
  }

  function addPair() {
    onChange([...pairs, { key: "", value: "" }]);
  }

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{label}</legend>
      {pairs.length === 0 && <p className="text-muted-foreground text-sm">No custom headers added.</p>}
      {pairs.map((pair, index) => (
        <div key={index} className="flex items-center gap-2">
          <label className="sr-only" htmlFor={`${id}-key-${index}`}>
            Header name {index + 1}
          </label>
          <input
            id={`${id}-key-${index}`}
            type="text"
            placeholder="Header name"
            value={pair.key}
            onChange={(e) => updatePair(index, "key", e.target.value)}
            className="border-border h-9 flex-1 rounded-md border bg-transparent px-2 text-sm"
          />
          <label className="sr-only" htmlFor={`${id}-value-${index}`}>
            Header value {index + 1}
          </label>
          <input
            id={`${id}-value-${index}`}
            type="text"
            placeholder="Header value"
            value={pair.value}
            onChange={(e) => updatePair(index, "value", e.target.value)}
            className="border-border h-9 flex-1 rounded-md border bg-transparent px-2 text-sm"
          />
          <Button type="button" variant="ghost" size="sm" onClick={() => removePair(index)} aria-label={`Remove header ${index + 1}`}>
            Remove
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={addPair} className="self-start">
        Add header
      </Button>
    </fieldset>
  );
}
