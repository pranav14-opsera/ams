# Forge Shipping Engine pipeline (WO-007)

`pipeline.yaml` is the pipeline's source of truth: source → build → scan
(placeholder, WO-008/WO-009) → push → gate → deploy (placeholder, WO-010).

## Connector gap — disclosed, not worked around

Creating a live, Forge-orchestrated pipeline execution requires a GitHub
connector and an AWS connector actually authorized for this project. The
only connectors visible in this Forge tenant belong to other users'
personal test accounts (e.g. "Hema githun", "SrinivasanAWS-Sales") —
wiring this project's build/push/deploy to someone else's connector would
push real container images and attempt real deployments against
infrastructure this project has no authorization to touch. Every step in
`pipeline.yaml` that needs a connector is marked `connectorId: null`.

Until a project-specific connector exists, the build stage runs for real
via `.github/workflows/build-and-push.yml` (Docker build only — no ECR
push, since that needs the AWS connector this environment doesn't have).

## Branch protection — documented, not enabled

`infrastructure/terraform/github/main.tf` declares the 2-approval branch
protection this WO's acceptance criteria ask for, as Terraform config —
but it is **not applied**. This project is currently being built out
across many work orders in rapid, unattended succession (implement → PR
→ merge, repeated) with no second human reviewer in the loop; enabling a
real 2-approval requirement now would immediately block every subsequent
PR in that sequence. This was raised explicitly and the decision was to
keep it as a reviewable, not-yet-applied deliverable — apply it once the
work order pace slows to a normal human-reviewed cadence.

## Verification performed

- `.forge/pipeline.yaml`: hand-validated against the acceptance criteria's
  stage list; Forge's actual schema validation requires the connector this
  environment doesn't have (see above)
- `infrastructure/terraform/github`: `terraform fmt`/`tflint` clean; not
  applied (see above)
- **Frontend and backend builds verified for real**, not just written:
  - `npm run typecheck` (TypeScript strict mode) passes cleanly on both,
    and was confirmed to actually catch a deliberately introduced type
    error (`Type 'string' is not assignable to type 'number'`) before the
    error was removed
  - `next build` (with `output: "export"`) actually ran and produced
    static output; `nest build` actually ran and produced `dist/`
  - Both `Dockerfile`s pass `hadolint` with zero findings
  - Docker itself isn't available in this local environment — the actual
    `docker build` runs for real in CI (`.github/workflows/build-and-push.yml`),
    verified by watching that workflow run, not assumed
- ECR push / Forge-orchestrated end-to-end pipeline run: not executed —
  no project-specific AWS/GitHub connector exists in this environment
