output "cluster_arn" {
  value = aws_msk_cluster.main.arn
}

output "bootstrap_brokers_sasl_scram" {
  description = "SASL/SCRAM bootstrap broker string for client connections."
  value       = aws_msk_cluster.main.bootstrap_brokers_sasl_scram
}

output "bootstrap_brokers_tls" {
  description = "TLS bootstrap broker string, for clients using mTLS instead of SASL."
  value       = aws_msk_cluster.main.bootstrap_brokers_tls
}

output "kafka_sasl_secret_id" {
  description = "The Secrets Manager secret this module wrote app-facing SASL credentials into (owned by the secrets module)."
  value       = var.kafka_secret_id
}

output "security_group_id" {
  value = aws_security_group.kafka.id
}

output "core_topic_names" {
  value = [for k, v in local.core_topics : k]
}

output "dlq_topic_names" {
  value = [for k, v in local.core_topics : "${k}-dlq"]
}

output "sns_alerts_topic_arn" {
  value = aws_sns_topic.kafka_alerts.arn
}
