import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import langchainSchema from "@/schemas/framework-connection/langchain.schema.json";
import restSchema from "@/schemas/framework-connection/rest.schema.json";
import type { FrameworkConnectionSchema } from "@/schemas/framework-connection/types";
import { SchemaFormRenderer } from "./schema-form-renderer";

const langchain = langchainSchema as FrameworkConnectionSchema;
const rest = restSchema as FrameworkConnectionSchema;

describe("SchemaFormRenderer", () => {
  it("renders LangChain's schema fields with the documented widget types", () => {
    render(<SchemaFormRenderer schema={langchain} values={{}} errors={{}} onFieldChange={vi.fn()} onFieldErrorsChange={vi.fn()} idPrefix="lc" />);

    expect(screen.getByLabelText(/API Endpoint URL/)).toHaveAttribute("type", "url");
    expect(screen.getByLabelText(/API Key \/ Token/)).toHaveAttribute("type", "password");
    expect(screen.getByLabelText(/LangSmith Project ID/)).toHaveAttribute("type", "text");
    expect(screen.getByLabelText(/Telemetry Callback URL/)).toHaveAttribute("type", "url");
    expect(screen.getByLabelText(/Framework Version/)).toBeInstanceOf(HTMLSelectElement);
  });

  it("renders fields in x-order (API Endpoint URL before API Key before LangSmith Project ID)", () => {
    render(<SchemaFormRenderer schema={langchain} values={{}} errors={{}} onFieldChange={vi.fn()} onFieldErrorsChange={vi.fn()} idPrefix="lc" />);
    const labels = screen.getAllByText(/API Endpoint URL|API Key|LangSmith Project ID/, { selector: "label" }).map((el) => el.textContent);
    expect(labels[0]).toMatch(/API Endpoint URL/);
    expect(labels[1]).toMatch(/API Key/);
    expect(labels[2]).toMatch(/LangSmith Project ID/);
  });

  it("renders the REST schema's authMethod as a select with the documented enum options", () => {
    render(<SchemaFormRenderer schema={rest} values={{}} errors={{}} onFieldChange={vi.fn()} onFieldErrorsChange={vi.fn()} idPrefix="rest" />);
    const select = screen.getByLabelText(/Authentication Method/) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value).filter(Boolean);
    expect(options).toEqual(["api_key", "oauth", "hmac"]);
  });

  it("renders the REST schema's optional customHeaders as a key-value editor", () => {
    render(<SchemaFormRenderer schema={rest} values={{}} errors={{}} onFieldChange={vi.fn()} onFieldErrorsChange={vi.fn()} idPrefix="rest" />);
    expect(screen.getByText("Custom Headers")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add header/i })).toBeInTheDocument();
  });

  it("calls onFieldChange immediately on input, and validates (via onFieldErrorsChange) after the debounce", async () => {
    vi.useFakeTimers();
    const onFieldChange = vi.fn();
    const onFieldErrorsChange = vi.fn();
    render(<SchemaFormRenderer schema={langchain} values={{}} errors={{}} onFieldChange={onFieldChange} onFieldErrorsChange={onFieldErrorsChange} idPrefix="lc" />);

    fireEvent.change(screen.getByLabelText(/API Endpoint URL/), { target: { value: "x" } });
    expect(onFieldChange).toHaveBeenCalledWith("apiEndpointUrl", "x");
    expect(onFieldErrorsChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(350);
    expect(onFieldErrorsChange).toHaveBeenCalled();
    const lastCall = onFieldErrorsChange.mock.calls.at(-1)![0];
    expect(lastCall.apiEndpointUrl).toMatch(/valid URL/);

    vi.useRealTimers();
  });

  it("validates immediately on blur, without waiting for the debounce", () => {
    const onFieldErrorsChange = vi.fn();
    render(<SchemaFormRenderer schema={langchain} values={{ apiEndpointUrl: "not-a-url" }} errors={{}} onFieldChange={vi.fn()} onFieldErrorsChange={onFieldErrorsChange} idPrefix="lc" />);

    const input = screen.getByLabelText(/API Endpoint URL/);
    input.focus();
    input.blur();

    expect(onFieldErrorsChange).toHaveBeenCalled();
    const lastCall = onFieldErrorsChange.mock.calls.at(-1)![0];
    expect(lastCall.apiEndpointUrl).toMatch(/valid URL/);
  });

  it("surfaces contextual help text for each field via its description", () => {
    render(<SchemaFormRenderer schema={langchain} values={{}} errors={{}} onFieldChange={vi.fn()} onFieldErrorsChange={vi.fn()} idPrefix="lc" />);
    expect(screen.getByText(/Used to authenticate control-plane calls/)).toBeInTheDocument();
  });
});
