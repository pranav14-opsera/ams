# Production Deployment Gate Checklist

Required before approving a production deployment. Both the **Engineering
Lead** and **Security Lead** must independently confirm every item below —
neither approval substitutes for the other, per WO-007's acceptance
criteria (two named roles, not "any two approvers").

## Engineering Lead

- [ ] All CI checks passed on the release tag (build, scan, accessibility)
- [ ] No open Sev1/Sev2 incidents referencing this service
- [ ] Migration scripts (if any) reviewed and are forward-compatible with the currently-deployed version (zero-downtime rollout)
- [ ] Rollback plan confirmed: previous image tag identified and reachable in ECR
- [ ] Blue-green canary analysis thresholds (WO-010) reviewed for this release

## Security Lead

- [ ] All five parallel security scans (WO-008) show zero new critical/high findings
- [ ] Accessibility scan (WO-009) shows no new WCAG 2.1 AA violations
- [ ] Container images are signed (WO-012) and signature verification is enabled on the deploy target
- [ ] No secrets or credentials appear in the build artifacts or logs
- [ ] Any new external dependency introduced since the last production release has been reviewed

## Both

- [ ] Change is documented (PR description, linked work order) for SOC 2 audit evidence
- [ ] Deployment window does not conflict with an active change freeze
