# Branch protection for the ams repository, as Terraform-managed config —
# per WO-007's acceptance criteria ("2 approvals, all CI checks passing").
#
# NOT APPLIED. This is deliberate, not an oversight: the project is
# currently being built out across 129 work orders in rapid, unattended
# succession (implement -> PR -> merge, repeated), with no second human
# reviewer in the loop. Turning on a real 2-approval requirement right now
# would immediately block every subsequent PR in that sequence — either
# blocking on human approval that isn't coming, or requiring an admin-
# override merge every single time, which defeats the rule's purpose
# entirely. This was raised explicitly and the decision was to keep this
# as a reviewable, not-yet-applied deliverable.
#
# To actually enable it: point this module at a GitHub connector/token
# with admin rights on the repo and run `terraform apply` once the team
# is ready for every PR to require real review (i.e. once the pace of
# work order delivery slows to a normal human-reviewed cadence).

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

variable "github_owner" {
  description = "GitHub organization or user that owns the repository."
  type        = string
  default     = "pranav14-opsera"
}

variable "repository_name" {
  type    = string
  default = "ams"
}

provider "github" {
  owner = var.github_owner
}

resource "github_branch_protection" "main" {
  repository_id = var.repository_name
  pattern       = "main"

  required_status_checks {
    strict   = true
    contexts = ["fmt / validate / tflint", "migrate-and-test"]
  }

  required_pull_request_reviews {
    required_approving_review_count = 2
    dismiss_stale_reviews           = true
  }

  enforce_admins         = false # platform-admin role can still override for genuine emergencies
  allows_force_pushes    = false
  allows_deletions       = false
  require_signed_commits = true
}
