# VPC endpoints keep S3/KMS/ECR/CloudWatch Logs traffic on the AWS network
# instead of traversing NAT gateways, reducing both cost and the internet-
# reachable surface area of the internal zone.
#
# Endpoint service availability varies by region — enable_vpc_endpoints is a
# single kill switch, and each interface endpoint is looked up by name first
# so an unsupported endpoint in a given region fails plan/apply with a clear
# "no matching service" error rather than silently misconfiguring routing.

data "aws_vpc_endpoint_service" "kms" {
  count   = var.enable_vpc_endpoints ? 1 : 0
  service = "kms"
}

data "aws_vpc_endpoint_service" "ecr_api" {
  count   = var.enable_vpc_endpoints ? 1 : 0
  service = "ecr.api"
}

data "aws_vpc_endpoint_service" "ecr_dkr" {
  count   = var.enable_vpc_endpoints ? 1 : 0
  service = "ecr.dkr"
}

data "aws_vpc_endpoint_service" "logs" {
  count   = var.enable_vpc_endpoints ? 1 : 0
  service = "logs"
}

resource "aws_security_group" "vpc_endpoints" {
  count = var.enable_vpc_endpoints ? 1 : 0

  name_prefix = "${var.name_prefix}-${var.environment}-vpce-"
  description = "Allows HTTPS from within the VPC to interface VPC endpoints."
  vpc_id      = aws_vpc.main.id

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-sg-vpc-endpoints"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "vpc_endpoints_ingress_https" {
  count = var.enable_vpc_endpoints ? 1 : 0

  type              = "ingress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = [var.vpc_cidr]
  security_group_id = aws_security_group.vpc_endpoints[0].id
  description       = "HTTPS from within the VPC"
}

resource "aws_security_group_rule" "vpc_endpoints_egress_all" {
  count = var.enable_vpc_endpoints ? 1 : 0

  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.vpc_endpoints[0].id
  description       = "Unrestricted egress"
}

# S3 is a gateway endpoint — it attaches to route tables, not subnets, and has
# no regional availability gaps.
resource "aws_vpc_endpoint" "s3" {
  count = var.enable_vpc_endpoints ? 1 : 0

  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"

  route_table_ids = concat(
    [for rt in aws_route_table.private : rt.id],
    [for rt in aws_route_table.data : rt.id],
  )

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-vpce-s3"
  })
}

resource "aws_vpc_endpoint" "kms" {
  count = var.enable_vpc_endpoints ? 1 : 0

  vpc_id              = aws_vpc.main.id
  service_name        = data.aws_vpc_endpoint_service.kms[0].service_name
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [for s in aws_subnet.private : s.id]
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
  private_dns_enabled = true

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-vpce-kms"
  })
}

resource "aws_vpc_endpoint" "ecr_api" {
  count = var.enable_vpc_endpoints ? 1 : 0

  vpc_id              = aws_vpc.main.id
  service_name        = data.aws_vpc_endpoint_service.ecr_api[0].service_name
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [for s in aws_subnet.private : s.id]
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
  private_dns_enabled = true

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-vpce-ecr-api"
  })
}

resource "aws_vpc_endpoint" "ecr_dkr" {
  count = var.enable_vpc_endpoints ? 1 : 0

  vpc_id              = aws_vpc.main.id
  service_name        = data.aws_vpc_endpoint_service.ecr_dkr[0].service_name
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [for s in aws_subnet.private : s.id]
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
  private_dns_enabled = true

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-vpce-ecr-dkr"
  })
}

resource "aws_vpc_endpoint" "logs" {
  count = var.enable_vpc_endpoints ? 1 : 0

  vpc_id              = aws_vpc.main.id
  service_name        = data.aws_vpc_endpoint_service.logs[0].service_name
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [for s in aws_subnet.private : s.id]
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
  private_dns_enabled = true

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-vpce-logs"
  })
}
