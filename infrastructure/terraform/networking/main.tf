data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  common_tags = merge({
    Project     = var.name_prefix
    Environment = var.environment
    ManagedBy   = "terraform"
    Module      = "networking"
  }, var.tags)

  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  public_subnets = {
    for idx, cidr in var.public_subnet_cidrs : tostring(idx) => {
      cidr = cidr
      az   = local.azs[idx]
    }
  }

  private_subnets = {
    for idx, cidr in var.private_subnet_cidrs : tostring(idx) => {
      cidr = cidr
      az   = local.azs[idx]
    }
  }

  data_subnets = {
    for idx, cidr in var.data_subnet_cidrs : tostring(idx) => {
      cidr = cidr
      az   = local.azs[idx]
    }
  }

  cluster_discovery_tags = var.cluster_name != "" ? {
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
  } : {}

  # --- CIDR overlap validation -------------------------------------------------
  # Every subnet is keyed by "<tier>-<index>" so that an identical CIDR reused
  # across two tiers is still detected as an overlap (a plain string-dedup would
  # hide that case). Ranges are computed as [start, end] 32-bit integers so
  # overlap is a simple interval comparison.
  subnet_entries = merge(
    { for k, s in local.public_subnets : "public-${k}" => s.cidr },
    { for k, s in local.private_subnets : "private-${k}" => s.cidr },
    { for k, s in local.data_subnets : "data-${k}" => s.cidr },
  )

  all_named_cidrs = merge(local.subnet_entries, { vpc = var.vpc_cidr })

  cidr_range = {
    for name, cidr in local.all_named_cidrs : name => {
      cidr  = cidr
      start = sum([for i, o in split(".", cidrhost(cidr, 0)) : tonumber(o) * pow(256, 3 - i)])
      end   = sum([for i, o in split(".", cidrhost(cidr, 0)) : tonumber(o) * pow(256, 3 - i)]) + pow(2, 32 - tonumber(split("/", cidr)[1])) - 1
    }
  }

  reserved_range = {
    for idx, cidr in var.reserved_cidr_blocks : "reserved-${idx}" => {
      cidr  = cidr
      start = sum([for i, o in split(".", cidrhost(cidr, 0)) : tonumber(o) * pow(256, 3 - i)])
      end   = sum([for i, o in split(".", cidrhost(cidr, 0)) : tonumber(o) * pow(256, 3 - i)]) + pow(2, 32 - tonumber(split("/", cidr)[1])) - 1
    }
  }

  subnet_overlap_pairs = [
    for pair in setproduct(keys(local.subnet_entries), keys(local.subnet_entries)) : pair
    if pair[0] < pair[1]
    && local.cidr_range[pair[0]].start <= local.cidr_range[pair[1]].end
    && local.cidr_range[pair[1]].start <= local.cidr_range[pair[0]].end
  ]

  reserved_overlap_pairs = [
    for pair in setproduct(keys(local.all_named_cidrs), keys(local.reserved_range)) : pair
    if local.cidr_range[pair[0]].start <= local.reserved_range[pair[1]].end
    && local.reserved_range[pair[1]].start <= local.cidr_range[pair[0]].end
  ]
}

check "cidr_overlap" {
  assert {
    condition     = length(local.subnet_overlap_pairs) == 0
    error_message = "Overlapping subnet CIDR blocks detected between: ${jsonencode(local.subnet_overlap_pairs)}. Each subnet across all tiers must occupy a distinct address range."
  }

  assert {
    condition     = length(local.reserved_overlap_pairs) == 0
    error_message = "VPC or subnet CIDR overlaps with a reserved_cidr_blocks entry: ${jsonencode(local.reserved_overlap_pairs)}. Reserved ranges represent customer VPN/peering CIDRs that must not collide with platform networking."
  }
}

# --- VPC ------------------------------------------------------------------

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-vpc"
  })
}

# AWS auto-creates a default security group with an allow-all self-referencing
# rule on every VPC. Terraform can't delete it, only strip its rules — left
# alone it's an unmanaged, always-present bypass of the zone model above.
resource "aws_default_security_group" "main" {
  vpc_id = aws_vpc.main.id

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-default-sg-locked-down"
  })
}

# --- Public (edge) subnets --------------------------------------------------

resource "aws_subnet" "public" {
  for_each = local.public_subnets

  vpc_id            = aws_vpc.main.id
  cidr_block        = each.value.cidr
  availability_zone = each.value.az
  # Deliberately not map_public_ip_on_launch=true (CKV_AWS_130): edge
  # services (ALB/NLB, NAT EIPs) get public IPs explicitly assigned, not by
  # subnet default. Anything else placed here opts in per-instance instead.

  tags = merge(local.common_tags, local.cluster_discovery_tags, {
    Name                     = "${var.name_prefix}-${var.environment}-public-${each.value.az}"
    Tier                     = "public"
    "kubernetes.io/role/elb" = "1"
  })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-igw"
  })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-public-rt"
    Tier = "public"
  })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  for_each = local.public_subnets

  subnet_id      = aws_subnet.public[each.key].id
  route_table_id = aws_route_table.public.id
}

# --- Private (internal) subnets --------------------------------------------

resource "aws_subnet" "private" {
  for_each = local.private_subnets

  vpc_id            = aws_vpc.main.id
  cidr_block        = each.value.cidr
  availability_zone = each.value.az

  tags = merge(local.common_tags, local.cluster_discovery_tags, {
    Name                              = "${var.name_prefix}-${var.environment}-private-${each.value.az}"
    Tier                              = "internal"
    "kubernetes.io/role/internal-elb" = "1"
  })
}

resource "aws_eip" "nat" {
  for_each = local.public_subnets

  domain = "vpc"

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-nat-eip-${each.value.az}"
  })

  depends_on = [aws_internet_gateway.main]
}

resource "aws_nat_gateway" "main" {
  for_each = local.public_subnets

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = aws_subnet.public[each.key].id

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-nat-${each.value.az}"
  })

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "private" {
  for_each = local.private_subnets

  vpc_id = aws_vpc.main.id

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-private-rt-${each.value.az}"
    Tier = "internal"
  })
}

resource "aws_route" "private_nat" {
  for_each = local.private_subnets

  route_table_id         = aws_route_table.private[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[each.key].id
}

resource "aws_route_table_association" "private" {
  for_each = local.private_subnets

  subnet_id      = aws_subnet.private[each.key].id
  route_table_id = aws_route_table.private[each.key].id
}

# --- Data (isolated) subnets ------------------------------------------------
# No internet route of any kind — only the implicit local VPC route. This is
# the hard requirement that the Data zone is unreachable from the internet
# under any configuration.

resource "aws_subnet" "data" {
  for_each = local.data_subnets

  vpc_id            = aws_vpc.main.id
  cidr_block        = each.value.cidr
  availability_zone = each.value.az

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-data-${each.value.az}"
    Tier = "data"
  })
}

resource "aws_route_table" "data" {
  for_each = local.data_subnets

  vpc_id = aws_vpc.main.id

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-data-rt-${each.value.az}"
    Tier = "data"
  })
}

resource "aws_route_table_association" "data" {
  for_each = local.data_subnets

  subnet_id      = aws_subnet.data[each.key].id
  route_table_id = aws_route_table.data[each.key].id
}
