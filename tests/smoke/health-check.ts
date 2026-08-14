export interface SmokeTarget {
  name: string;
  url: string;
  paths: string[];
}

export interface SmokeResult {
  target: string;
  path: string;
  ok: boolean;
  status?: number;
  error?: string;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

// Acceptance criteria: "verify all critical API endpoints return expected
// responses within 5 seconds of deployment completion" — a single shared
// deadline across every target/path, not 5 seconds per request, so a slow
// first check can't silently eat the whole budget from the rest.
export async function runSmokeChecks(
  targets: SmokeTarget[],
  fetchImpl: FetchLike,
  deadlineMs: number,
): Promise<SmokeResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);

  try {
    const checks = targets.flatMap((target) =>
      target.paths.map(async (path): Promise<SmokeResult> => {
        try {
          const res = await fetchImpl(`${target.url}${path}`, { signal: controller.signal });
          return { target: target.name, path, ok: res.ok && res.status === 200, status: res.status };
        } catch (err) {
          return { target: target.name, path, ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    return await Promise.all(checks);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const raw = process.env.SMOKE_TARGETS;
  if (!raw) {
    console.error(
      "SMOKE_TARGETS is required — a JSON array of {name, url, paths}, e.g.\n" +
        '  [{"name":"backend","url":"https://api.dev.ams.internal","paths":["/health/live","/health/ready"]}]',
    );
    process.exitCode = 1;
    return;
  }

  const targets: SmokeTarget[] = JSON.parse(raw);
  const deadlineMs = Number(process.env.SMOKE_DEADLINE_MS ?? 5000);
  const results = await runSmokeChecks(targets, fetch, deadlineMs);

  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.target}${r.path} ${r.status ?? r.error}`);
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
