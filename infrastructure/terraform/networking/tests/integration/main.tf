# Live-AWS integration harness for WO-002 acceptance criterion:
# "Deploy a test EC2 instance in each subnet tier and verify connectivity
#  rules — Internal can reach Data, Public cannot reach Data, Private subnets
#  can reach internet via NAT."
#
# This is NOT part of the offline test suite in ../networking.tftest.hcl — it
# provisions real (tiny) EC2 instances and therefore requires a live AWS
# account and credentials. Run it manually or from a CI job that has both:
#
#   cd infrastructure/terraform/networking/tests/integration
#   terraform init
#   terraform apply
#   ./run_connectivity_checks.sh   # requires the AWS CLI, uses SSM — no SSH keys/bastion needed
#   terraform destroy              # tear down when done, these instances cost money while running

terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

module "networking" {
  source = "../../"

  region      = var.region
  environment = var.environment
  name_prefix = var.name_prefix
}

data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_iam_role" "ssm" {
  name = "${var.name_prefix}-${var.environment}-conntest-ssm-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.ssm.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ssm" {
  name = "${var.name_prefix}-${var.environment}-conntest-ssm-profile"
  role = aws_iam_role.ssm.name
}

locals {
  instance_type = "t3.micro"

  # Applied identically to all three probes: force IMDSv2, encrypt the root
  # volume, and turn on detailed monitoring — these are throwaway instances
  # but there's no reason for them to fall short of the baseline any real
  # workload in this VPC would be held to.
  probe_hardening = {
    metadata_options = {
      http_tokens                 = "required"
      http_put_response_hop_limit = 1
      http_endpoint               = "enabled"
    }
    monitoring    = true
    ebs_optimized = true
  }
}

resource "aws_instance" "public_probe" {
  ami                         = data.aws_ssm_parameter.al2023_ami.value
  instance_type               = local.instance_type
  subnet_id                   = module.networking.public_subnet_ids[0]
  vpc_security_group_ids      = [module.networking.security_group_public_id]
  iam_instance_profile        = aws_iam_instance_profile.ssm.name
  associate_public_ip_address = true # only the public-zone probe gets one, and explicitly — not via subnet default
  monitoring                  = local.probe_hardening.monitoring
  ebs_optimized               = local.probe_hardening.ebs_optimized

  metadata_options {
    http_tokens                 = local.probe_hardening.metadata_options.http_tokens
    http_put_response_hop_limit = local.probe_hardening.metadata_options.http_put_response_hop_limit
    http_endpoint               = local.probe_hardening.metadata_options.http_endpoint
  }

  root_block_device {
    encrypted = true
  }

  tags = { Name = "${var.name_prefix}-${var.environment}-conntest-public" }
}

resource "aws_instance" "private_probe" {
  ami                    = data.aws_ssm_parameter.al2023_ami.value
  instance_type          = local.instance_type
  subnet_id              = module.networking.private_subnet_ids[0]
  vpc_security_group_ids = [module.networking.security_group_internal_id]
  iam_instance_profile   = aws_iam_instance_profile.ssm.name
  monitoring             = local.probe_hardening.monitoring
  ebs_optimized          = local.probe_hardening.ebs_optimized

  metadata_options {
    http_tokens                 = local.probe_hardening.metadata_options.http_tokens
    http_put_response_hop_limit = local.probe_hardening.metadata_options.http_put_response_hop_limit
    http_endpoint               = local.probe_hardening.metadata_options.http_endpoint
  }

  root_block_device {
    encrypted = true
  }

  tags = { Name = "${var.name_prefix}-${var.environment}-conntest-private" }
}

resource "aws_instance" "data_probe" {
  ami                    = data.aws_ssm_parameter.al2023_ami.value
  instance_type          = local.instance_type
  subnet_id              = module.networking.data_subnet_ids[0]
  vpc_security_group_ids = [module.networking.security_group_data_id]
  iam_instance_profile   = aws_iam_instance_profile.ssm.name
  monitoring             = local.probe_hardening.monitoring
  ebs_optimized          = local.probe_hardening.ebs_optimized

  metadata_options {
    http_tokens                 = local.probe_hardening.metadata_options.http_tokens
    http_put_response_hop_limit = local.probe_hardening.metadata_options.http_put_response_hop_limit
    http_endpoint               = local.probe_hardening.metadata_options.http_endpoint
  }

  root_block_device {
    encrypted = true
  }

  tags = { Name = "${var.name_prefix}-${var.environment}-conntest-data" }
}

# Neither probe runs a real service by default, so a bare TCP handshake is
# the only thing the security groups have anything to say about. This
# document starts a netcat listener on a caller-specified port so the
# connectivity script can emulate "PostgreSQL is listening on 5432" (data
# zone) or "the edge service is listening on 443" (public zone) with a real
# TCP handshake instead of relying on ICMP, which the security groups don't
# even open.
resource "aws_ssm_document" "start_probe_listener" {
  name          = "${var.name_prefix}-${var.environment}-conntest-listener"
  document_type = "Command"

  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Start a netcat listener on the given port for connectivity testing"
    parameters = {
      port = {
        type        = "String"
        description = "TCP port to listen on"
        default     = "5432"
      }
    }
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "startListener"
      inputs = {
        runCommand = [
          "nohup nc -lk {{ port }} >/tmp/nc.log 2>&1 &",
        ]
      }
    }]
  })
}
