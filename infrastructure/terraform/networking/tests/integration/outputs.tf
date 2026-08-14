output "public_probe_instance_id" {
  value = aws_instance.public_probe.id
}

output "public_probe_public_ip" {
  value = aws_instance.public_probe.public_ip
}

output "private_probe_instance_id" {
  value = aws_instance.private_probe.id
}

output "data_probe_instance_id" {
  value = aws_instance.data_probe.id
}

output "data_probe_private_ip" {
  value = aws_instance.data_probe.private_ip
}

output "listener_document_name" {
  value = aws_ssm_document.start_probe_listener.name
}
