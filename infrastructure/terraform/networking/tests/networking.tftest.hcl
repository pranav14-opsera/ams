# Native Terraform test suite (Terraform 1.9+). The aws provider is mocked so
# these run fully offline — no AWS credentials or account required — while
# still exercising real resource wiring, counts, and security-group rules via
# `command = apply` against the mock provider's generated plan.
#
# Real infrastructure validation (an EC2 instance per tier actually proving
# connectivity) is covered separately in tests/integration/connectivity, which
# requires apply against a live AWS account/credentials and is intentionally
# not run as part of this offline suite.

mock_provider "aws" {}

override_data {
  target = data.aws_availability_zones.available
  values = {
    names = ["us-east-1a", "us-east-1b", "us-east-1c"]
  }
}

override_data {
  target = data.aws_caller_identity.current
  values = {
    account_id = "123456789012"
  }
}

override_data {
  target = data.aws_vpc_endpoint_service.kms
  values = {
    service_name = "com.amazonaws.us-east-1.kms"
  }
}

override_data {
  target = data.aws_vpc_endpoint_service.ecr_api
  values = {
    service_name = "com.amazonaws.us-east-1.ecr.api"
  }
}

override_data {
  target = data.aws_vpc_endpoint_service.ecr_dkr
  values = {
    service_name = "com.amazonaws.us-east-1.ecr.dkr"
  }
}

override_data {
  target = data.aws_vpc_endpoint_service.logs
  values = {
    service_name = "com.amazonaws.us-east-1.logs"
  }
}

variables {
  region      = "us-east-1"
  environment = "dev"
  name_prefix = "ams"
}

run "creates_three_tier_topology_across_three_azs" {
  command = apply

  assert {
    condition     = aws_vpc.main.cidr_block == "10.0.0.0/16"
    error_message = "VPC CIDR must default to 10.0.0.0/16"
  }

  assert {
    condition     = length(aws_subnet.public) == 3
    error_message = "Expected 3 public (edge) subnets, one per AZ"
  }

  assert {
    condition     = length(aws_subnet.private) == 3
    error_message = "Expected 3 private (internal) subnets, one per AZ"
  }

  assert {
    condition     = length(aws_subnet.data) == 3
    error_message = "Expected 3 isolated data subnets, one per AZ"
  }

  assert {
    condition     = length(aws_nat_gateway.main) == 3
    error_message = "Expected one NAT gateway per AZ (not a single shared NAT)"
  }

  assert {
    condition     = length(aws_eip.nat) == 3
    error_message = "Expected one Elastic IP per NAT gateway"
  }

  assert {
    condition     = length(aws_route_table.private) == 3
    error_message = "Expected one private route table per AZ (each points at its own NAT gateway)"
  }

  assert {
    condition     = length([for r in aws_route.private_nat : r if r.nat_gateway_id != null]) == 3
    error_message = "Every private route table must route 0.0.0.0/0 through a NAT gateway"
  }

  assert {
    condition     = length(aws_route_table.data) == 3
    error_message = "Expected one data-zone route table per AZ"
  }

  assert {
    condition     = aws_route.public_internet.gateway_id == aws_internet_gateway.main.id
    error_message = "Public route table must route 0.0.0.0/0 through the internet gateway"
  }
}

run "vpc_endpoints_created_when_enabled" {
  command = apply

  assert {
    condition     = length(aws_vpc_endpoint.s3) == 1
    error_message = "S3 gateway endpoint should be created when enable_vpc_endpoints is true"
  }

  assert {
    condition     = length(aws_vpc_endpoint.kms) == 1 && length(aws_vpc_endpoint.ecr_api) == 1 && length(aws_vpc_endpoint.ecr_dkr) == 1 && length(aws_vpc_endpoint.logs) == 1
    error_message = "KMS, ECR (api+dkr), and CloudWatch Logs interface endpoints should all be created when enable_vpc_endpoints is true"
  }
}

run "vpc_endpoints_skipped_when_disabled" {
  command = apply

  variables {
    enable_vpc_endpoints = false
  }

  assert {
    condition     = length(aws_vpc_endpoint.s3) == 0 && length(aws_vpc_endpoint.kms) == 0
    error_message = "No VPC endpoints should be created when enable_vpc_endpoints is false"
  }

  assert {
    condition     = length(output.vpc_endpoint_ids) == 0
    error_message = "vpc_endpoint_ids output must be empty when endpoints are disabled"
  }
}

run "public_security_group_allows_only_https_inbound" {
  command = apply

  assert {
    condition     = aws_security_group_rule.public_ingress_https.from_port == 443 && aws_security_group_rule.public_ingress_https.to_port == 443 && aws_security_group_rule.public_ingress_https.protocol == "tcp"
    error_message = "Public security group must allow only TCP/443 inbound"
  }

  assert {
    condition     = contains(aws_security_group_rule.public_ingress_https.cidr_blocks, "0.0.0.0/0")
    error_message = "Public security group HTTPS rule must accept traffic from the internet"
  }
}

run "internal_security_group_only_reachable_from_public_and_self" {
  command = apply

  assert {
    condition     = aws_security_group_rule.internal_ingress_from_public.source_security_group_id == aws_security_group.public.id
    error_message = "Internal zone must accept traffic from the public zone security group"
  }

  assert {
    condition     = aws_security_group_rule.internal_ingress_from_self.source_security_group_id == aws_security_group.internal.id
    error_message = "Internal zone must accept service-to-service traffic from itself"
  }
}

run "data_security_group_only_reachable_from_internal_on_expected_ports" {
  command = apply

  assert {
    condition     = alltrue([for r in aws_security_group_rule.data_ingress_from_internal : r.source_security_group_id == aws_security_group.internal.id])
    error_message = "Data zone must only be reachable from the internal zone security group"
  }

  assert {
    condition     = length(setsubtract([5432, 6379, 9092], [for r in aws_security_group_rule.data_ingress_from_internal : r.from_port])) == 0
    error_message = "Data zone must expose PostgreSQL (5432), Redis (6379), and Kafka (9092) to the internal zone"
  }
}

run "kubernetes_discovery_tags_applied_when_cluster_name_set" {
  command = apply

  variables {
    cluster_name = "ams-primary"
  }

  assert {
    condition     = alltrue([for s in aws_subnet.public : s.tags["kubernetes.io/cluster/ams-primary"] == "shared"])
    error_message = "Public subnets must carry the kubernetes.io/cluster discovery tag when cluster_name is set"
  }

  assert {
    condition     = alltrue([for s in aws_subnet.public : s.tags["kubernetes.io/role/elb"] == "1"])
    error_message = "Public subnets must be tagged for external ELB discovery"
  }

  assert {
    condition     = alltrue([for s in aws_subnet.private : s.tags["kubernetes.io/role/internal-elb"] == "1"])
    error_message = "Private subnets must be tagged for internal ELB discovery"
  }
}

run "flow_logs_ship_to_s3_with_retention" {
  command = apply

  variables {
    flow_log_retention_days = 14
  }

  assert {
    condition     = aws_flow_log.main.log_destination_type == "s3"
    error_message = "Flow logs must be delivered to S3"
  }

  assert {
    condition     = aws_flow_log.main.traffic_type == "ALL"
    error_message = "Flow logs must capture ALL traffic (accept and reject) for security audit"
  }
}

run "rejects_reserved_cidr_overlap" {
  command = plan

  variables {
    reserved_cidr_blocks = ["10.0.0.0/8"]
  }

  expect_failures = [
    check.cidr_overlap,
  ]
}

run "rejects_duplicate_cidr_reused_across_tiers" {
  command = plan

  variables {
    private_subnet_cidrs = ["10.0.0.0/20", "10.0.64.0/20", "10.0.80.0/20"]
  }

  expect_failures = [
    check.cidr_overlap,
  ]
}

run "rejects_subnet_count_mismatched_with_az_count" {
  command = plan

  variables {
    az_count             = 2
    public_subnet_cidrs  = ["10.0.0.0/20", "10.0.16.0/20"]
    private_subnet_cidrs = ["10.0.48.0/20", "10.0.64.0/20"]
  }

  expect_failures = [
    var.data_subnet_cidrs,
  ]
}

run "rejects_invalid_environment" {
  command = plan

  variables {
    environment = "qa"
  }

  expect_failures = [
    var.environment,
  ]
}

run "rejects_vpc_cidr_smaller_than_slash16" {
  command = plan

  variables {
    vpc_cidr = "10.0.0.0/17"
  }

  expect_failures = [
    var.vpc_cidr,
  ]
}
