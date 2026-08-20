import { describe, expect, it } from "vitest";
import langchainSchema from "@/schemas/framework-connection/langchain.schema.json";
import restSchema from "@/schemas/framework-connection/rest.schema.json";
import type { FrameworkConnectionSchema } from "@/schemas/framework-connection/types";
import { isSchemaValid, validateFieldValue, validateSchemaValues } from "./field-validation";

const langchain = langchainSchema as FrameworkConnectionSchema;
const rest = restSchema as FrameworkConnectionSchema;

describe("validateFieldValue", () => {
  it("flags a required field left empty", () => {
    const error = validateFieldValue(langchain.properties.apiEndpointUrl!, true, "");
    expect(error).toMatch(/required/);
  });

  it("allows an empty optional field", () => {
    const error = validateFieldValue(langchain.properties.langsmithProjectId!, false, "");
    expect(error).toBeNull();
  });

  it("rejects a malformed URL for a format:uri field", () => {
    const error = validateFieldValue(langchain.properties.apiEndpointUrl!, true, "not-a-url");
    expect(error).toMatch(/valid URL/);
  });

  it("accepts a well-formed https URL", () => {
    const error = validateFieldValue(langchain.properties.apiEndpointUrl!, true, "https://agent.example.com");
    expect(error).toBeNull();
  });

  it("rejects a REST healthCheckEndpoint that doesn't start with /", () => {
    const error = validateFieldValue(rest.properties.healthCheckEndpoint!, true, "health");
    expect(error).toMatch(/start with/);
  });

  it("accepts a REST healthCheckEndpoint starting with /", () => {
    const error = validateFieldValue(rest.properties.healthCheckEndpoint!, true, "/health");
    expect(error).toBeNull();
  });

  it("rejects a value outside the enum for a select field", () => {
    const error = validateFieldValue(rest.properties.authMethod!, true, "basic_auth");
    expect(error).toMatch(/must be one of/);
  });

  it("accepts a value inside the enum for a select field", () => {
    const error = validateFieldValue(rest.properties.authMethod!, true, "oauth");
    expect(error).toBeNull();
  });
});

describe("validateSchemaValues / isSchemaValid", () => {
  it("reports every missing required field for the LangChain schema", () => {
    const errors = validateSchemaValues(langchain, {});
    expect(Object.keys(errors).sort()).toEqual(["apiEndpointUrl", "apiKey", "callbackUrl", "frameworkVersion"].sort());
    expect(isSchemaValid(langchain, {})).toBe(false);
  });

  it("is valid once every required LangChain field is present and well-formed", () => {
    const values = {
      apiEndpointUrl: "https://agent.example.com",
      apiKey: "sk-test-123",
      callbackUrl: "https://ams.example.com/callback",
      frameworkVersion: "0.3.x",
    };
    expect(isSchemaValid(langchain, values)).toBe(true);
  });

  it("does not require the REST schema's optional customHeaders field", () => {
    const values = {
      baseUrl: "https://agent.example.com",
      authMethod: "api_key",
      healthCheckEndpoint: "/health",
      telemetryWebhookUrl: "https://ams.example.com/webhook",
    };
    expect(isSchemaValid(rest, values)).toBe(true);
  });
});
