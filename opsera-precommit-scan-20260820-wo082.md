# Pre-Commit Security Scan — ams (WO-082)

Date: 2026-08-20
Verdict: **SAFE TO COMMIT** — 0 new findings introduced by this commit's staged changes.

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 18 |
| Medium | 0 |
| Low | 0 |
| **Total** | **18** |

| | Count |
|---|---|
| New (this commit's staged changes) | 0 |
| Existing (pre-existing, already committed or build artifacts) | 18 |

Risk score: 68.3/100 (High Risk) — driven entirely by pre-existing/build-artifact findings below, none touched by this commit.

## Findings by category

- **gitleaks (18 total, 0 new):**
  - 17 findings are gitleaks matching entropy-based secret patterns inside `frontend/.next/` build cache and `frontend/out/` static export output — both build artifacts, not git-tracked source, and not part of this commit's diff.
  - 1 finding is the pre-existing, previously-accepted false positive in `frontend/src/components/dashboard/health-history-chart.tsx` (a recharts `dataKey` prop, not a secret) — documented as accepted in every prior WO's own reconciliation doc this session; unchanged by this commit.
  - A separate, scoped `gitleaks detect --source backend --no-git` run (this repo's own established convention, matching prior WOs) found 7 findings, all in `backend/test/fixtures/*` — pre-existing accepted test fixtures (a SAML test private key, JWT test fixtures, encryption sample payloads), also documented as accepted in every prior WO's reconciliation doc. None are in files this commit touches.
- **npm audit (0 findings, both packages):** `backend`: 0 vulnerabilities across 452 dependencies. `frontend`: 0 vulnerabilities across 885 dependencies.
- **semgrep (0 findings):** `.semgrep.yml`'s own `raw-sql-missing-tenant-filter` rule run against the full repo — 0 matches, including every new/modified file in this commit (`backend/src/onboarding/*`, `backend/src/auth/sso-test.controller.ts`, `backend/src/scim/scim-test.controller.ts`, `backend/src/credits/budget/*`, and the corresponding frontend hooks/components) confirmed individually as well.
- **grype / checkov / hadolint:** not applicable — this repo has no Dockerfiles, Terraform, or Kubernetes manifests for checkov/hadolint to scan; grype's own dependency-vulnerability coverage is superseded by the per-package `npm audit` runs above, which returned 0 vulnerabilities.

## Remediation

No remediation required — every finding is either a known-accepted test fixture / false positive documented across this session's prior work orders, or build-artifact noise never committed to git. No action taken; nothing changed by this pre-commit scan.
