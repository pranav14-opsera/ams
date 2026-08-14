import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import Ajv, { type ValidateFunction } from "ajv";

interface OpenApiDoc {
  paths: Record<
    string,
    Record<
      string,
      {
        responses: Record<string, { content?: Record<string, { schema: object }> }>;
      }
    >
  >;
}

export interface ContractCheck {
  path: string;
  method: string;
  status: number;
  schema: object;
}

// Flattens an OpenAPI doc into one entry per (path, method, status) that
// declares a JSON response schema — the shape a contract test actually
// checks against a live response.
export function extractContractChecks(doc: OpenApiDoc): ContractCheck[] {
  const checks: ContractCheck[] = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      for (const [status, response] of Object.entries(operation.responses)) {
        const schema = response.content?.["application/json"]?.schema;
        if (schema) checks.push({ path, method: method.toUpperCase(), status: Number(status), schema });
      }
    }
  }
  return checks;
}

export interface ContractResult {
  path: string;
  method: string;
  ok: boolean;
  errors?: string;
}

type FetchLike = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;

export async function runContractChecks(
  baseUrl: string,
  checks: ContractCheck[],
  fetchImpl: FetchLike,
  ajv: Ajv,
): Promise<ContractResult[]> {
  const results: ContractResult[] = [];
  for (const check of checks) {
    const res = await fetchImpl(`${baseUrl}${check.path}`);
    if (res.status !== check.status) {
      results.push({ path: check.path, method: check.method, ok: false, errors: `expected status ${check.status}, got ${res.status}` });
      continue;
    }
    const validate: ValidateFunction = ajv.compile(check.schema);
    const body = await res.json();
    const ok = validate(body);
    results.push({ path: check.path, method: check.method, ok, errors: ok ? undefined : ajv.errorsText(validate.errors) });
  }
  return results;
}

async function main() {
  const baseUrl = process.env.CONTRACT_BASE_URL;
  const specPath = process.env.OPENAPI_SPEC_PATH ?? "backend/openapi.yaml";
  if (!baseUrl) {
    console.error("CONTRACT_BASE_URL is required (the live environment URL to validate against)");
    process.exitCode = 1;
    return;
  }

  const doc = load(readFileSync(specPath, "utf8")) as OpenApiDoc;
  const checks = extractContractChecks(doc);
  const ajv = new Ajv();
  const results = await runContractChecks(baseUrl, checks, fetch, ajv);

  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.method} ${r.path} ${r.errors ?? ""}`);
  }

  if (results.some((r) => !r.ok)) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
