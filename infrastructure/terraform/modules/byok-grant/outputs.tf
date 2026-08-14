output "grant_id" {
  description = "ID of the created KMS grant."
  value       = aws_kms_grant.byok.grant_id
}

output "grant_token" {
  description = "Grant token, usable immediately for eventually-consistent KMS operations right after creation (before the grant has fully propagated)."
  value       = aws_kms_grant.byok.grant_token
  sensitive   = true
}
