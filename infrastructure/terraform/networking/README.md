# networking

Foundation VPC module implementing the platform's four-zone security model
(Public, DMZ, Internal, Data). Every other infrastructure component — the
Kubernetes cluster, PostgreSQL, Redis, Kafka — is provisioned into subnets
created here.

## Topology

- **Public (edge) subnets** — one per AZ, route to an Internet Gateway. Hosts
  CDN/API Gateway/WAF placement.
- **Private (internal) subnets** — one per AZ, outbound-only via a dedicated
  NAT Gateway per AZ (no single point of failure). Hosts application
  services.
- **Data (isolated) subnets** — one per AZ, no internet route of any kind.
  Hosts databases, cache, and message brokers.

Security groups enforce default-deny between zones: `sg-public` only accepts
443 from the internet; `sg-internal` accepts traffic from `sg-public` and
itself; `sg-data` accepts PostgreSQL/Redis/Kafka ports from `sg-internal`
only. There is no rule anywhere that lets the public zone reach the data
zone.

## Usage

```hcl
module "networking" {
  source = "./infrastructure/terraform/networking"

  region      = "us-east-1"
  environment = "dev"
  name_prefix = "ams"

  # Optional — set once the K8s cluster name is known, to tag subnets for
  # kubernetes.io/cluster discovery:
  cluster_name = "ams-primary"

  # Optional — CIDRs of customer VPN/peering ranges to validate against:
  reserved_cidr_blocks = ["172.31.0.0/16"]
}
```

Each environment (dev/staging/prod) should call this module once, into its
own separate `region`/`environment` pair — the platform's environments are
fully isolated VPCs, not shared.

## Testing

- `terraform test` (from this directory) runs the offline suite in
  `tests/networking.tftest.hcl` against a mocked AWS provider — no
  credentials or account required. Covers resource topology, security group
  rules, VPC endpoint toggling, Kubernetes discovery tags, flow log
  configuration, and every CIDR/variable validation rule.
- `tests/integration/` provisions real EC2 instances against a live AWS
  account to verify actual network reachability end-to-end. See its README.

## Known data gap: WO-001 dependency cycle

WO-002 and WO-001 (Multi-AZ Kubernetes Cluster) list each other as
dependencies in the backlog. That's not implementable as written — this
module was built first, treating WO-002 as the true prerequisite (a
Kubernetes cluster is provisioned into a VPC, not the reverse). WO-001's
Terraform should consume this module's `public_subnet_ids`/
`private_subnet_ids` outputs. Flagged for whoever owns the work-order
backlog to correct the dependency direction.
