terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.100"
    }
    kafka = {
      source  = "Mongey/kafka"
      version = "~> 0.7"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }
}

provider "aws" {
  region = var.region
}

# Manages topics via the Kafka protocol itself — AWS's own provider has no
# native "topic" resource; MSK is the cluster, not topic administration.
provider "kafka" {
  bootstrap_servers = [aws_msk_cluster.main.bootstrap_brokers_sasl_scram]
  tls_enabled       = true
  sasl_mechanism    = "scram-sha512"
  sasl_username     = local.scram_username
  sasl_password     = random_password.scram_password.result
}
