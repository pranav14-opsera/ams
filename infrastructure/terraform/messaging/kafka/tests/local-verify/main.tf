# Standalone local-verification config — NOT part of the deployed module.
# Applies the parent module's exact topics.tf definitions (partition
# counts, retention.ms) against a local single-broker Kafka instance via
# the same Mongey/kafka Terraform provider the real module uses, with
# replication_factor overridden to 1 (a single local broker can't satisfy
# 3x replication) and no TLS/SASL (that's MSK-specific auth, a separate,
# already-documented CANNOT_VERIFY concern — this config verifies topic
# administration, not cluster security).
#
# Usage: terraform init && terraform apply -auto-approve
# (against a local Kafka broker on localhost:9092)

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    kafka = {
      source  = "Mongey/kafka"
      version = "~> 0.7"
    }
  }
}

provider "kafka" {
  bootstrap_servers = ["localhost:9092"]
  tls_enabled       = false
}

locals {
  core_topics = {
    agent-telemetry = {
      partitions   = 6
      retention_ms = 7 * 24 * 60 * 60 * 1000
    }
    credit-consumption = {
      partitions   = 6
      retention_ms = 30 * 24 * 60 * 60 * 1000
    }
    audit-events = {
      partitions   = 6
      retention_ms = 90 * 24 * 60 * 60 * 1000
    }
    dashboard-updates = {
      partitions   = 6
      retention_ms = 1 * 24 * 60 * 60 * 1000
    }
    governance-events = {
      partitions   = 6
      retention_ms = 30 * 24 * 60 * 60 * 1000
    }
  }
}

resource "kafka_topic" "core" {
  for_each = local.core_topics

  name               = each.key
  partitions         = each.value.partitions
  replication_factor = 1 # local override — see header comment

  config = {
    "retention.ms"        = tostring(each.value.retention_ms)
    "min.insync.replicas" = "1" # local override — MSK config uses 2
  }
}

resource "kafka_topic" "dlq" {
  for_each = local.core_topics

  name               = "${each.key}-dlq"
  partitions         = each.value.partitions
  replication_factor = 1

  config = {
    "retention.ms"        = tostring(7 * 24 * 60 * 60 * 1000)
    "min.insync.replicas" = "1"
  }
}
