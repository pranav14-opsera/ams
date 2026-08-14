output "secret_arns" {
  description = "ARNs of every managed secret, keyed by secret name."
  value       = { for k, s in aws_secretsmanager_secret.managed : k => s.arn }
}

output "rotation_lambda_name" {
  description = "Name of the shared secret-rotation Lambda function."
  value       = aws_lambda_function.secret_rotation.function_name
}

output "rotation_lambda_security_group_id" {
  description = "Security group ID of the rotation Lambda's ENIs, for adding inbound allow rules on the target database/cache/broker security groups."
  value       = aws_security_group.secret_rotation_lambda.id
}
