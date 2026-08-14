# cache/redis module (WO-005)

Provisions the ElastiCache Redis 7.x replication group (1 primary + 1
replica, multi-AZ automatic failover) used for four purposes:

## Key namespace conventions (enforced by application code, not Redis itself)

| Prefix | Purpose | TTL |
|---|---|---|
| `session:{user_id}` | JWT refresh token + device fingerprint binding | None or long-lived, tied to session policy — never evicted under memory pressure (see eviction policy below) |
| `abac:{tenant_id}:{policy_id}` | ABAC policy evaluation cache | 60s |
| `credit:{tenant_id}:{team_id}` | Real-time credit balance cache | Short, refreshed on every debit/credit |
| `ws:{tenant_id}:{connection_id}` | WebSocket connection state | Tied to connection lifetime |

Redis has no native per-prefix TTL enforcement — every service writing
into one of these namespaces is responsible for setting (or deliberately
not setting) a TTL consistent with the table above.

## Auth token: written into the secrets module's secret, not a new one

This module does **not** create its own `aws_secretsmanager_secret` for
the Redis AUTH token. WO-003's `infrastructure/terraform/secrets` module
already has a `redis-auth-token` entry in its `managed_secrets` map
(`secret_type = "redis"`), complete with 90-day automatic rotation via its
shared rotation Lambda. A first draft of this module created a second
secret at the identical name path — caught by checkov (`CKV2_AWS_57`,
rotation not enabled on the module's own secret) during review, which
surfaced the deeper issue: two Terraform resources in two different
modules both trying to own one Secrets Manager name. That's a real apply-
time collision waiting to happen, not just a lint nitpick.

Fixed by having this module accept `var.redis_auth_secret_id` (the
existing secret's ID/ARN, output by the secrets module) and write the
initial host/port/auth_token payload into it via
`aws_secretsmanager_secret_version`, `ignore_changes`'d so the rotation
Lambda's later updates aren't fought back to this initial value on every
`terraform apply`.

## Eviction policy — reconciling two requirements into one mechanism

The acceptance criteria ask for both "allkeys-lru for cache keys" and
"noeviction for session keys." Rather than split these into separate
logical databases (ElastiCache doesn't cleanly support Redis's numbered-DB
model in a way that's operationally simple), this module uses a single
`maxmemory-policy = volatile-lru`: it evicts only keys carrying an
explicit TTL. `abac:*`, `credit:*`, and `ws:*` keys are always written
*with* a TTL (per the table above) and are therefore LRU-eviction
candidates; `session:*` keys, written *without* a TTL, are never touched
by eviction — the same practical outcome as noeviction, without needing
separate databases.

## AOF persistence — architecture deviation, documented

The work order asks for "AOF persistence with 1-second fsync." **AWS
ElastiCache for Redis does not expose AOF as a configurable option** —
there is no `appendonly`/`appendfsync` parameter in any ElastiCache
parameter group family, unlike self-managed Redis. This is a platform
limitation, not a missing config flag, in the same category as WO-001's
TimescaleDB-on-RDS gap and WO-004's TimescaleDB-on-RDS gap.

ElastiCache's own durability primitives are used instead:
- `automatic_failover_enabled` + `multi_az_enabled`: AWS's documented
  automatic failover typically completes well under a minute — inside the
  <5 minute RTO acceptance criterion
- `snapshot_retention_limit` (7 days by default): daily RDB snapshots for
  point-in-time recovery in the event of a full cluster loss, not the
  normal single-node-failure path (that's handled by the multi-AZ
  replica's continuous replication, with no snapshot restore needed)

If true AOF-level durability (sub-second RPO on every write, not just
replica-level) becomes a hard requirement, that means self-managed Redis
on EC2/EKS rather than ElastiCache — a platform-level decision, out of
scope here.

## Memory limit — node type, not a direct parameter

ElastiCache has no direct "cap total memory at N MB" parameter
independent of the node's actual RAM. `cache.t4g.micro` (~0.5 GiB usable)
is selected specifically to land near the 500MB acceptance-criteria
target, rather than a larger node type constrained by a config parameter
that doesn't exist for this service.

## Verification performed

- `terraform fmt -check -recursive`: clean · `tflint --recursive`: 0 errors
- `terraform validate`/`terraform test`: blocked locally by the same
  pre-existing AVG TLS-interception issue documented in prior WOs — not a
  code defect
- **The eviction-policy design was verified for real** against a locally
  installed Redis 8 (`scoop install redis`), configured with this module's
  exact `maxmemory-policy volatile-lru` and `notify-keyspace-events Ex`:
  - Set one `session:*` key with no TTL and 20,000 `abac:*` keys each with
    a 600s TTL, then capped `maxmemory` at 2MB to force eviction pressure
  - Result: **15,970 of the TTL'd keys were evicted** (`evicted_keys` in
    `INFO stats`), while **the no-TTL session key survived untouched** —
    confirming the README's core design claim (one policy reconciling both
    "LRU-evict cache keys" and "never evict session keys") actually
    behaves as designed, not just in theory
  - TTL/atomic-operation behavior for each namespace also verified
    directly: `session:*` → TTL -1 (no expiry), `abac:*`/`credit:*`/`ws:*`
    → correct explicit TTLs, `DECRBY` on a credit-balance key applied
    atomically
- `terraform apply` / real ElastiCache provisioning / TLS connectivity /
  multi-AZ automatic failover: not run — no AWS credentials in this
  environment. TLS enforcement and failover timing are AWS-managed
  behaviors specific to ElastiCache, not reproducible with a local OSS
  Redis instance the way the eviction-policy logic above is.
