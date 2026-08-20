# Pre-Commit Security Scan — ams (2026-08-20)

**Verdict:** SAFE TO COMMIT — 0 new findings introduced by this change (WO-080).

## Summary

| Severity | Count | New (this diff) | Existing (pre-existing) |
|----------|-------|------------------|--------------------------|
| Critical | 41    | 0                | 41                       |
| High     | 258   | 0                | 258                      |
| Medium   | 233   | 0                | 233                      |
| Low      | 16    | 0                | 16                       |
| **Total**| **552** | **0**          | **552**                 |

Risk score (whole-repo, pre-existing): 100/100 (Critical Risk) — driven entirely by pre-existing findings in `infrastructure/terraform/**`, `infrastructure/kubernetes/**`, and the full `node_modules` dependency tree (grype), none of which this work order touches.

## Scope-relevant detail (WO-080's own changed files)

- **gitleaks** (`backend`, `frontend/src`): 8 findings total, all in pre-existing test fixtures (`backend/test/fixtures/auth/saml-idp-keypair.ts`, `backend/test/fixtures/encryption-sample-payloads.json`, `backend/test/fixtures/jwt-fixtures.json`) and one pre-existing recharts `dataKey` false positive (`frontend/src/components/dashboard/health-history-chart.tsx`) — none in any file this WO added or modified.
- **semgrep** (`.semgrep.yml`, scoped to `backend/src/teams`, `backend/src/agents`, `frontend/src/schemas`, `frontend/src/hooks`, `frontend/src/components/agents`, `frontend/src/app/agents/register`, and again repo-wide): **0 findings**.
- **checkov** (repo-wide IaC scan): 84 failed checks, all in `infrastructure/terraform/**`, `infrastructure/kubernetes/admission/tests/**`, and `backend/openapi.yaml` — zero touch any file in this WO's diff.
- **hadolint** (`backend/Dockerfile`, `frontend/Dockerfile` — neither modified by this WO): 0 findings.
- **grype** (repo-wide dependency scan): 552 matches across the full `node_modules` tree (both packages) — the new devDependency this WO adds, `msw@^2`, has **zero** matches of its own.
- **npm audit --omit=dev** (production dependencies only, both packages): **0 vulnerabilities**.

## Remediation ownership

All 552 findings are pre-existing, whole-repo findings outside this work order's scope (IaC hardening, dependency-tree CVEs unrelated to code this WO touched, and the two long-accepted fixture/false-positive gitleaks hits called out in this session's own established baseline). No remediation is required as a condition of this commit.
