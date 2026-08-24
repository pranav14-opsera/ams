# Pre-Commit Security Scan — C:\Users\prana\ams

**Date:** 2026-08-24
**Verdict:** ✅ SAFE TO COMMIT — 0 new findings introduced by this commit's staged changes (WO-082, commit `d2f7be1` + the opsera scan-report doc).

## Summary

| Severity | Count | New | Existing |
|----------|-------|-----|----------|
| Critical | 41    | 0   | 41       |
| High     | 259   | 0   | 259      |
| Medium   | 233   | 0   | 233      |
| Low      | 16    | 0   | 16       |
| **Total**| **634** | **0** | **634** |

**Risk score:** 100/100 (Critical Risk) — driven entirely by pre-existing findings below; none touch this commit's diff.

## Findings by category

- **gitleaks** (18 total, 0 new): 17 in `frontend/.next/`/`frontend/out/` build artifacts (not git-tracked); 1 pre-existing accepted false positive (`frontend/src/components/dashboard/health-history-chart.tsx:45`, recharts `dataKey` prop). Scoped re-run (`--source backend`) finds 7 more, all in `backend/test/fixtures/*` (SAML test key, JWT fixtures, encryption sample payloads) — all pre-existing, accepted in every prior WO's own reconciliation doc.
  - Remediation: none required — none are real secrets or in files this commit touches.
- **grype** (553 dependency matches: 41 critical, 259 high, 233 medium, 16 low, 4 unknown): whole `node_modules` tree across both packages — this WO added zero new dependencies (no `package.json` diff), so every match is pre-existing drift. `npm audit --omit=dev` in both `backend` and `frontend` (production deps only): 0 vulnerabilities.
  - Remediation: dependency-upgrade backlog item, unrelated to this WO's own scope.
- **semgrep** (`.semgrep.yml`'s `raw-sql-missing-tenant-filter` rule, repo-wide): 0 findings, including every file this commit touches (`backend/src/onboarding/*`, `backend/src/auth/sso-test.controller.ts`, `backend/src/scim/scim-test.controller.ts`, `backend/src/credits/budget/*`).
  - Remediation: none required.
- **checkov** (84 failed checks, `infrastructure/terraform/**` and `infrastructure/kubernetes/admission/tests/**`): pre-existing IaC findings, zero overlap with this commit's diff (this commit touches no Terraform/Kubernetes files).
  - Remediation: IaC hardening backlog, out of this WO's scope.
- **hadolint** (`backend/Dockerfile`, `frontend/Dockerfile` — neither modified by this commit): 0 findings.

## Remediation ownership

All 634 findings are pre-existing (dependency-tree CVEs, IaC hardening items, and two long-accepted fixture/false-positive gitleaks hits already documented across this session's prior work orders). No remediation required as a condition of this commit.
