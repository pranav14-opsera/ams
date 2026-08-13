output "vpc_id" {
  description = "ID of the provisioned VPC."
  value       = aws_vpc.main.id
}

output "vpc_cidr_block" {
  description = "CIDR block of the provisioned VPC."
  value       = aws_vpc.main.cidr_block
}

output "availability_zones" {
  description = "Availability zones the subnets are spread across."
  value       = local.azs
}

output "public_subnet_ids" {
  description = "Public (edge zone) subnet IDs, one per AZ."
  value       = [for s in aws_subnet.public : s.id]
}

output "public_subnet_ids_by_az" {
  description = "Public subnet IDs keyed by availability zone."
  value       = { for s in aws_subnet.public : s.availability_zone => s.id }
}

output "private_subnet_ids" {
  description = "Private (internal zone) subnet IDs, one per AZ."
  value       = [for s in aws_subnet.private : s.id]
}

output "private_subnet_ids_by_az" {
  description = "Private subnet IDs keyed by availability zone."
  value       = { for s in aws_subnet.private : s.availability_zone => s.id }
}

output "data_subnet_ids" {
  description = "Isolated data-zone subnet IDs, one per AZ."
  value       = [for s in aws_subnet.data : s.id]
}

output "data_subnet_ids_by_az" {
  description = "Data subnet IDs keyed by availability zone."
  value       = { for s in aws_subnet.data : s.availability_zone => s.id }
}

output "internet_gateway_id" {
  description = "ID of the internet gateway attached to the VPC."
  value       = aws_internet_gateway.main.id
}

output "nat_gateway_ids" {
  description = "NAT gateway IDs, one per AZ."
  value       = [for ng in aws_nat_gateway.main : ng.id]
}

output "public_route_table_id" {
  description = "ID of the shared public route table."
  value       = aws_route_table.public.id
}

output "private_route_table_ids" {
  description = "Private route table IDs, one per AZ (each routes through its own NAT gateway)."
  value       = [for rt in aws_route_table.private : rt.id]
}

output "data_route_table_ids" {
  description = "Data-zone route table IDs, one per AZ (no internet route)."
  value       = [for rt in aws_route_table.data : rt.id]
}

output "security_group_public_id" {
  description = "ID of the public/edge zone security group."
  value       = aws_security_group.public.id
}

output "security_group_internal_id" {
  description = "ID of the internal zone security group."
  value       = aws_security_group.internal.id
}

output "security_group_data_id" {
  description = "ID of the data zone security group."
  value       = aws_security_group.data.id
}

output "vpc_endpoint_ids" {
  description = "Map of created VPC endpoint IDs, empty if enable_vpc_endpoints is false."
  value = var.enable_vpc_endpoints ? {
    s3      = aws_vpc_endpoint.s3[0].id
    kms     = aws_vpc_endpoint.kms[0].id
    ecr_api = aws_vpc_endpoint.ecr_api[0].id
    ecr_dkr = aws_vpc_endpoint.ecr_dkr[0].id
    logs    = aws_vpc_endpoint.logs[0].id
  } : {}
}

output "flow_log_id" {
  description = "ID of the VPC flow log."
  value       = aws_flow_log.main.id
}

output "flow_log_bucket_name" {
  description = "Name of the S3 bucket receiving VPC flow logs."
  value       = aws_s3_bucket.flow_logs.id
}
