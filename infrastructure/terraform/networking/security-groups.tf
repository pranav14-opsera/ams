# Default-deny security groups enforcing the four-zone model (Public, DMZ/API
# Gateway sits behind sg-public, Internal, Data). AWS security groups deny all
# inbound traffic unless explicitly allowed, so zone isolation falls directly
# out of which ingress rules exist below — there is no rule anywhere that lets
# the Public zone reach the Data zone.

resource "aws_security_group" "public" {
  name_prefix = "${var.name_prefix}-${var.environment}-public-"
  description = "Edge zone: CDN, API Gateway, WAF. Accepts HTTPS from the internet only."
  vpc_id      = aws_vpc.main.id

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-sg-public"
    Tier = "public"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "public_ingress_https" {
  type              = "ingress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.public.id
  description       = "HTTPS from the internet"
}

resource "aws_security_group_rule" "public_egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.public.id
  description       = "Unrestricted egress"
}

resource "aws_security_group" "internal" {
  name_prefix = "${var.name_prefix}-${var.environment}-internal-"
  description = "Internal zone: application services. No direct internet access; reachable only from the public zone and other internal services."
  vpc_id      = aws_vpc.main.id

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-sg-internal"
    Tier = "internal"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "internal_ingress_from_public" {
  type                     = "ingress"
  from_port                = 0
  to_port                  = 0
  protocol                 = "-1"
  source_security_group_id = aws_security_group.public.id
  security_group_id        = aws_security_group.internal.id
  description              = "Traffic from the public/edge zone"
}

resource "aws_security_group_rule" "internal_ingress_from_self" {
  type                     = "ingress"
  from_port                = 0
  to_port                  = 0
  protocol                 = "-1"
  source_security_group_id = aws_security_group.internal.id
  security_group_id        = aws_security_group.internal.id
  description              = "Service-to-service traffic within the internal zone"
}

resource "aws_security_group_rule" "internal_egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.internal.id
  description       = "Unrestricted egress (outbound routed via NAT)"
}

resource "aws_security_group" "data" {
  name_prefix = "${var.name_prefix}-${var.environment}-data-"
  description = "Data zone: databases, cache, and message broker. Reachable only from the internal zone on specific ports. Unreachable from the public zone under any configuration."
  vpc_id      = aws_vpc.main.id

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-sg-data"
    Tier = "data"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "data_ingress_from_internal" {
  for_each = toset([for p in var.data_zone_ports : tostring(p)])

  type                     = "ingress"
  from_port                = tonumber(each.value)
  to_port                  = tonumber(each.value)
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.internal.id
  security_group_id        = aws_security_group.data.id
  description              = "Data-zone port ${each.value} reachable from the internal zone only"
}

resource "aws_security_group_rule" "data_egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.data.id
  description       = "Egress within the VPC (data subnets have no NAT/IGW route, so this only reaches VPC endpoints and other in-VPC resources)"
}
