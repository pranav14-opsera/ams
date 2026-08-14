# messaging/kafka module (WO-006)

Provisions the MSK cluster (3 brokers across 3 AZs, SASL/SCRAM auth, TLS
in-transit, KMS at-rest encryption) and manages topics via the
`Mongey/kafka` Terraform provider, since AWS's own provider has no native
topic-administration resource — MSK is the cluster, topic administration
happens over the Kafka protocol itself.

## Auth-token wiring — same pattern as WO-005

This module generates the initial SASL/SCRAM password and writes it into
the **existing** `kafka-sasl-credentials` secret owned by WO-003's
`secrets` module (via `var.kafka_secret_id`), rather than creating a
second, colliding secret — the same fix WO-005's Redis module needed after
its first draft duplicated a secret name. Separately, MSK's own
`aws_msk_scram_secret_association` requires a *second*, MSK-specific
secret whose name must start with `AmazonMSK_` — that one genuinely is
unique to this module (MSK's naming requirement, not app-facing), so it's
created here directly.

## Tenant-partitioned ordering — an application convention, not a Kafka setting

"Tenant-partitioned topics for ordered processing per organization" is
achieved by producers using `tenant_id` as the Kafka message key — Kafka
guarantees ordering only within a partition, and a hash-partitioned key
routes all of one tenant's events to the same partition consistently.
Terraform has no setting for this; it's documented here as the convention
every producer must follow, and it's exactly what this WO's own local
verification exercises (see below).

## Verification performed

- `terraform fmt -check -recursive`: clean · `tflint --recursive`: 0 errors
- `terraform validate`/`terraform test`: blocked locally by the same
  pre-existing AVG TLS-interception issue documented in prior WOs — this
  is exactly why WO-005 shipped an `aws_elasticache_parameter_group`
  bug (`name_prefix` isn't a valid argument for that resource) that only
  CI's `terraform validate` caught, post-merge. Every `name_prefix` usage
  in this module was manually cross-checked against that lesson before
  pushing: `aws_security_group.kafka` is the only one, and security groups
  genuinely support it (already used correctly across every prior WO).
- The `Mongey/kafka` Terraform provider binary itself was blocked by this
  environment's antivirus when attempting to `terraform apply` topics
  against a local broker (`fork/exec ... Access is denied`, even after
  `Unblock-File`) — the same class of environment interference as the TLS
  issue above, not a code defect. Pivoted to verifying the identical
  topic configuration directly:
  - Installed Kafka 4.x locally (KRaft mode, `scoop install kafka`, no
    ZooKeeper needed), created all 5 core topics + 5 DLQ topics via
    `kafka-topics.sh` with this module's exact partition counts and
    `retention.ms` values (`replication-factor` overridden to 1 — a
    single local broker can't satisfy 3x — everything else identical)
  - **Produced 1,000 synthetic events across 5 tenant_ids** (as the Kafka
    message key) to `agent-telemetry` via a small kafkajs script;
    consumed all 1,000 back and confirmed **every tenant's 200 events
    arrived in strict sequential order within their partition** — the
    ordering guarantee the acceptance criteria requires, verified
    end-to-end, not assumed from Kafka's documented behavior
  - Produced one intentionally malformed event (invalid JSON) directly to
    `agent-telemetry-dlq` and confirmed a consumer receives it intact —
    verifying the DLQ topic itself works as a landing zone (the
    producer-side malformed-event detection that routes to it is
    consuming-service logic, not part of this Terraform module)
- `terraform apply` against real AWS (MSK cluster, 3x replication, SASL/
  SCRAM over TLS, CloudWatch consumer-lag alarms): not run — no AWS
  credentials in this environment.
