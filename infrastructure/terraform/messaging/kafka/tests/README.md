# Verification

`local-verify/` mirrors the parent module's `topics.tf` definitions
(partition counts, retention.ms) applied against a local single-broker
Kafka instance instead of MSK — `replication_factor` overridden to 1
(a single broker can't satisfy 3x) and no TLS/SASL (that's MSK-specific
auth, a separate concern from topic administration).

This is how WO-006 was actually verified in this session:

```bash
# 1. Local Kafka (KRaft, no ZooKeeper) — see main module README for exact steps
kafka-storage.sh format -t <cluster-id> -c config/server.properties --standalone
kafka-server-start.sh config/server.properties &

# 2. Create topics matching topics.tf exactly (the Mongey/kafka Terraform
#    provider binary itself was blocked by this environment's antivirus,
#    so topics were created directly via kafka-topics.sh instead — same
#    configuration, different tool):
kafka-topics.sh --bootstrap-server localhost:9092 --create \
  --topic agent-telemetry --partitions 6 --replication-factor 1 \
  --config retention.ms=604800000 --config min.insync.replicas=1
# ... (repeat for all 5 core topics + 5 DLQ topics, see topics.tf for values)

# 3. Produce 1000 events across 5 tenant_id keys, consume, verify strict
#    per-tenant ordering, and verify DLQ routing for a malformed event —
#    a small kafkajs script (not checked in — ad hoc verification, not a
#    permanent test asset). Result: 1000/1000 consumed, ordering PASS for
#    all 5 tenants, DLQ PASS.
```

Real AWS verification (MSK cluster creation, 3x replication, SASL/SCRAM
over TLS, CloudWatch consumer-lag alarms firing): not run — no AWS
credentials in this environment.
