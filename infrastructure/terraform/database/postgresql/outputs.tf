output "db_instance_id" {
  description = "RDS instance identifier."
  value       = aws_db_instance.main.id
}

output "db_instance_arn" {
  description = "ARN of the RDS instance."
  value       = aws_db_instance.main.arn
}

output "master_user_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the auto-generated, auto-rotated master password."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "proxy_endpoint" {
  description = "RDS Proxy endpoint — application services connect here, not directly to the database endpoint, for connection pooling."
  value       = aws_db_proxy.main.endpoint
}

output "database_endpoint" {
  description = "Direct RDS instance endpoint (migration runs and admin tooling connect here, bypassing the proxy)."
  value       = aws_db_instance.main.address
}

output "database_port" {
  value = aws_db_instance.main.port
}
