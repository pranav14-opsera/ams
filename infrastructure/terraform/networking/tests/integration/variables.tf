variable "region" {
  description = "AWS region to run the connectivity probes in."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name passed through to the networking module."
  type        = string
  default     = "dev"
}

variable "name_prefix" {
  description = "Resource name prefix passed through to the networking module."
  type        = string
  default     = "ams-conntest"
}
