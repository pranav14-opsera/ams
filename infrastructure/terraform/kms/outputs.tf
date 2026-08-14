output "platform_key_arn" {
  description = "ARN of the platform's symmetric AES-256 KMS key."
  value       = aws_kms_key.platform.arn
}

output "platform_key_alias" {
  description = "Alias of the platform key, for use in downstream module key_id references."
  value       = aws_kms_alias.platform.name
}

output "jwt_signing_current_alias_arn" {
  description = "ARN of the alias pointing to the currently active JWT signing key generation. Application services sign new JWTs with this key."
  value       = aws_kms_alias.jwt_signing_current.arn
}

output "jwt_signing_previous_alias_arn" {
  description = "ARN of the alias pointing to the prior JWT signing key generation, kept valid for the overlap window so in-flight tokens still verify."
  value       = aws_kms_alias.jwt_signing_previous.arn
}

output "jwt_rotation_lambda_name" {
  description = "Name of the JWT signing key rotation Lambda function."
  value       = aws_lambda_function.jwt_rotation.function_name
}

output "image_signing_key_arn" {
  description = "ARN of the container image signing KMS key (cosign, WO-012)."
  value       = aws_kms_key.image_signing.arn
}

output "image_signing_key_alias" {
  description = "Alias of the image signing key — pass to cosign as awskms:///<this-alias> (or the key ARN directly)."
  value       = aws_kms_alias.image_signing.name
}

output "cloudtrail_arn" {
  description = "ARN of the account's CloudTrail trail capturing all KMS/Secrets Manager management events."
  value       = aws_cloudtrail.main.arn
}

output "cloudtrail_log_group_name" {
  description = "CloudWatch Logs group receiving near-real-time CloudTrail events."
  value       = aws_cloudwatch_log_group.cloudtrail.name
}
