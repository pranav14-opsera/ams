# Namespace-per-bounded-context isolation, plus system namespaces for
# ingress/monitoring/cert-management. Every bounded-context namespace gets a
# ResourceQuota and LimitRange to prevent one noisy tenant from starving the
# others, and a default-deny NetworkPolicy so cross-namespace traffic must be
# explicitly allowed rather than implicitly permitted.

resource "kubernetes_namespace" "bounded_context" {
  for_each = toset(var.bounded_context_namespaces)

  metadata {
    name = each.value
    labels = {
      "app.kubernetes.io/managed-by" = "terraform"
      "ams.io/namespace-type"        = "bounded-context"
    }
  }

  depends_on = [aws_eks_node_group.system]
}

resource "kubernetes_namespace" "system" {
  for_each = toset(var.system_namespaces)

  metadata {
    name = each.value
    labels = {
      "app.kubernetes.io/managed-by" = "terraform"
      "ams.io/namespace-type"        = "system"
    }
  }

  depends_on = [aws_eks_node_group.system]
}

resource "kubernetes_resource_quota" "bounded_context" {
  for_each = kubernetes_namespace.bounded_context

  metadata {
    name      = "${each.key}-default-quota"
    namespace = each.value.metadata[0].name
  }

  spec {
    hard = {
      "requests.cpu"    = var.namespace_resource_quota.requests_cpu
      "requests.memory" = var.namespace_resource_quota.requests_memory
      "limits.cpu"      = var.namespace_resource_quota.limits_cpu
      "limits.memory"   = var.namespace_resource_quota.limits_memory
      "pods"            = tostring(var.namespace_resource_quota.max_pods)
    }
  }
}

resource "kubernetes_limit_range" "bounded_context" {
  for_each = kubernetes_namespace.bounded_context

  metadata {
    name      = "${each.key}-default-limits"
    namespace = each.value.metadata[0].name
  }

  spec {
    limit {
      type = "Container"
      default = {
        cpu    = "500m"
        memory = "512Mi"
      }
      default_request = {
        cpu    = "100m"
        memory = "128Mi"
      }
    }
  }
}

# Default-deny ingress/egress in every bounded-context namespace. Explicit
# allow rules (e.g. from the ingress controller, or between two specific
# services) are added per-service by the base Helm chart, not here.
resource "kubernetes_network_policy" "default_deny" {
  for_each = kubernetes_namespace.bounded_context

  metadata {
    name      = "default-deny-all"
    namespace = each.value.metadata[0].name
  }

  spec {
    pod_selector {}
    policy_types = ["Ingress", "Egress"]
  }
}

# Allow DNS egress (kube-dns/CoreDNS) — otherwise the default-deny egress
# rule above breaks service discovery for every pod in the namespace.
resource "kubernetes_network_policy" "allow_dns_egress" {
  for_each = kubernetes_namespace.bounded_context

  metadata {
    name      = "allow-dns-egress"
    namespace = each.value.metadata[0].name
  }

  spec {
    pod_selector {}
    policy_types = ["Egress"]

    egress {
      ports {
        port     = "53"
        protocol = "UDP"
      }
      ports {
        port     = "53"
        protocol = "TCP"
      }
    }
  }
}

# Allow pods within the same namespace to reach each other. Default-deny is
# a cross-namespace boundary, not an intra-service one — without this,
# ordinary same-namespace calls (and the smoke-test verify Job hitting the
# smoke-test Service) would also be blocked.
resource "kubernetes_network_policy" "allow_intra_namespace" {
  for_each = kubernetes_namespace.bounded_context

  metadata {
    name      = "allow-intra-namespace"
    namespace = each.value.metadata[0].name
  }

  spec {
    pod_selector {}
    policy_types = ["Ingress", "Egress"]

    ingress {
      from {
        pod_selector {}
      }
    }

    egress {
      to {
        pod_selector {}
      }
    }
  }
}

# Allow ingress-nginx to reach pods in every bounded-context namespace on
# the standard container port range — the one documented cross-namespace
# path the default-deny policy needs to carve an exception for.
resource "kubernetes_network_policy" "allow_from_ingress" {
  for_each = kubernetes_namespace.bounded_context

  metadata {
    name      = "allow-from-ingress-nginx"
    namespace = each.value.metadata[0].name
  }

  spec {
    pod_selector {}
    policy_types = ["Ingress"]

    ingress {
      from {
        namespace_selector {
          match_labels = {
            "kubernetes.io/metadata.name" = "ingress-nginx"
          }
        }
      }
    }
  }

  depends_on = [kubernetes_namespace.system]
}
