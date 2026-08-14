output "primary_endpoint_address" {
  description = "Primary (write) endpoint."
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "reader_endpoint_address" {
  description = "Reader endpoint, routing across all replicas."
  value       = aws_elasticache_replication_group.main.reader_endpoint_address
}

output "port" {
  value = aws_elasticache_replication_group.main.port
}

output "auth_token_secret_id" {
  description = "The Secrets Manager secret this module wrote the host/port/auth_token payload into (owned by the secrets module, passed in via var.redis_auth_secret_id). Application services read this at runtime — the auth token is never hardcoded or passed as a plain Terraform variable."
  value       = var.redis_auth_secret_id
}

output "security_group_id" {
  value = aws_security_group.redis.id
}

output "sns_alerts_topic_arn" {
  value = aws_sns_topic.redis_alerts.arn
}
