# kubernetes module (WO-001)

Provisions the multi-AZ EKS cluster that every other platform service runs on:
control plane, three node groups (system / application / data), namespace
isolation per bounded context with quotas and default-deny network policies,
and the CloudWatch audit log group.

Also provisions the platform's API Gateway (WO-026): NGINX Ingress
Controller, cert-manager, and routing — see [GATEWAY.md](./GATEWAY.md).
WAF and mandatory security headers (WO-028) are documented in
[WAF.md](./WAF.md).

## Composition with the networking module (WO-002)

This module takes `vpc_id`, `private_subnet_ids`, and `data_subnet_ids` as
input variables rather than reading the networking module's state directly.
Compose them in a root module:

```hcl
module "networking" {
  source      = "../networking"
  region      = var.region
  environment = var.environment
}

module "kubernetes" {
  source              = "../kubernetes"
  region              = var.region
  environment         = var.environment
  vpc_id              = module.networking.vpc_id
  private_subnet_ids  = module.networking.private_subnet_ids
  data_subnet_ids     = module.networking.data_subnet_ids
  cluster_security_group_ids = [module.networking.security_group_internal_id]
}
```

## Remote state

`backend.tf` declares an S3 backend with no inline config (S3 backend blocks
can't use variables). Run the `bootstrap` module once per account to create
the state bucket + DynamoDB lock table, copy `backend.hcl.example` to
`backend.hcl` with those values, then:

```
terraform init -backend-config=backend.hcl
```

## Cluster endpoint access

`endpoint_public_access` defaults to disabled (checkov CKV_AWS_38/39 — no
`0.0.0.0/0` public endpoint by default). `terraform apply` and any
`kubectl`/Helm command against this cluster must therefore run from inside
the VPC (a CI runner on a private subnet, a bastion, or VPN) unless you set
`cluster_endpoint_public_access_cidrs` to your specific CI/office CIDR
ranges to enable public access scoped to those ranges.

## What's out of scope here

- **Node group desired_size drift**: `lifecycle.ignore_changes` on
  `scaling_config[0].desired_size` for every node group, since the cluster
  autoscaler / HPA-driven scaling changes this outside of Terraform. Terraform
  still owns `min_size`/`max_size`.
- **Helm chart installs**: the base-service and smoke-test charts under
  `infrastructure/helm/` are applied via `helm install`/CI, not by this
  Terraform module — namespaces and their quotas/policies are the boundary
  Terraform owns; what runs inside them is Helm's job.
- **IRSA role bindings**: `cluster_oidc_issuer_url` is exported for
  downstream modules (e.g. WO-015's BYOK KMS module, WO-013's tenant API) to
  wire up IAM Roles for Service Accounts; this module doesn't create any
  IRSA roles itself since none of its own workloads need AWS API access.

## Verification performed

- `terraform fmt -check -recursive`: clean
- `tflint --recursive`: 0 errors
- `terraform validate`: blocked locally by a pre-existing AVG TLS-interception
  issue on this machine (same root cause documented in the networking
  module's README) — not a code defect. Runs clean in CI (see
  `.github/workflows/terraform-checks.yml`).
- `terraform apply` / idempotency / smoke-test chart: not run against real
  AWS — no cloud credentials available in this environment. The smoke-test
  Helm chart (`infrastructure/helm/smoke-test/`) implements the deploy/verify/
  self-cleanup acceptance criterion as `post-install` Helm hooks with
  `hook-delete-policy: hook-succeeded,hook-failed`, ready to run once applied
  against a live cluster.
