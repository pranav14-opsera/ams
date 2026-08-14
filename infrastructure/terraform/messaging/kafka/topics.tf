# Topic-level retention per the acceptance criteria: 7 days for telemetry,
# 30 days for credit/governance, 90 days for audit events. dashboard-updates
# is ephemeral push data (not replayed/audited), so it gets the shortest
# reasonable retention (1 day) — long enough to recover from a brief
# consumer outage, short enough not to accumulate stale UI-push events.
locals {
  core_topics = {
    agent-telemetry = {
      partitions     = 6
      retention_ms   = 7 * 24 * 60 * 60 * 1000
      consumer_group = "telemetry-normalizer"
    }
    credit-consumption = {
      partitions     = 6
      retention_ms   = 30 * 24 * 60 * 60 * 1000
      consumer_group = "credit-reconciler"
    }
    audit-events = {
      partitions     = 6
      retention_ms   = 90 * 24 * 60 * 60 * 1000
      consumer_group = "audit-writer"
    }
    dashboard-updates = {
      partitions     = 6
      retention_ms   = 1 * 24 * 60 * 60 * 1000
      consumer_group = "dashboard-pusher"
    }
    governance-events = {
      partitions     = 6
      retention_ms   = 30 * 24 * 60 * 60 * 1000
      consumer_group = "governance-engine"
    }
  }
}

resource "kafka_topic" "core" {
  for_each = local.core_topics

  name               = each.key
  partitions         = each.value.partitions
  replication_factor = 3

  config = {
    "retention.ms"        = tostring(each.value.retention_ms)
    "min.insync.replicas" = "2"
    # tenant_id as the producer-supplied partition key (application-level
    # convention, not a Kafka setting) is what gives ordered per-tenant
    # processing — see README.
  }
}

# One DLQ per core topic, matching partition count, fixed 7-day retention
# for failed-event investigation regardless of the parent topic's own
# retention policy.
resource "kafka_topic" "dlq" {
  for_each = local.core_topics

  name               = "${each.key}-dlq"
  partitions         = each.value.partitions
  replication_factor = 3

  config = {
    "retention.ms"        = tostring(7 * 24 * 60 * 60 * 1000)
    "min.insync.replicas" = "2"
  }
}
