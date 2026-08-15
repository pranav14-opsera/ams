# Native Terraform test suite (Terraform 1.9+) for the API Gateway
# (WO-026): aws/kubernetes/helm are all mocked so this runs fully
# offline — no AWS credentials, no live cluster, no real Helm repo
# fetch required — while still exercising real resource wiring, TLS
# config, and routing-table shape via `command = apply` against the
# mock providers' generated plan.
#
# Real infrastructure validation (an actual TLS 1.3 handshake via
# testssl.sh, a live k6 load test at 1,000 req/s measuring gateway P99
# overhead, mTLS certificate rotation actually observed) requires apply
# against a live cluster and is intentionally not part of this offline
# suite — same boundary the existing kubernetes.tftest.hcl documents for
# EKS cluster/node-group validation.

mock_provider "aws" {}
mock_provider "kubernetes" {}
mock_provider "helm" {}

variables {
  region             = "us-east-1"
  environment        = "dev"
  name_prefix        = "ams"
  vpc_id             = "vpc-0123456789abcdef0"
  private_subnet_ids = ["subnet-priv-a", "subnet-priv-b", "subnet-priv-c"]
  data_subnet_ids    = ["subnet-data-a", "subnet-data-b", "subnet-data-c"]
}

run "installs_ingress_nginx_with_tls13_only_and_ha_replicas" {
  command = apply

  assert {
    condition     = helm_release.ingress_nginx.chart == "ingress-nginx"
    error_message = "Must install the ingress-nginx chart"
  }

  assert {
    condition     = [for s in helm_release.ingress_nginx.set : s.value if s.name == "controller.config.ssl-protocols"][0] == "TLSv1.3"
    error_message = "Must configure TLSv1.3 ONLY — listing any of TLSv1.0/1.1/1.2 alongside it would fail the 'TLS 1.0/1.1 disabled' acceptance criterion"
  }

  assert {
    condition     = [for s in helm_release.ingress_nginx.set : s.value if s.name == "controller.replicaCount"][0] == "3"
    error_message = "Ingress controller must run HA (every request in the platform passes through it)"
  }

  assert {
    condition     = helm_release.ingress_nginx.create_namespace == false
    error_message = "Must install into the ingress-nginx namespace already created by namespaces.tf, not create a second one"
  }
}

run "installs_cert_manager_with_crds_and_ha_replicas" {
  command = apply

  assert {
    condition     = helm_release.cert_manager.chart == "cert-manager"
    error_message = "Must install the cert-manager chart"
  }

  assert {
    condition     = [for s in helm_release.cert_manager.set : s.value if s.name == "installCRDs"][0] == "true"
    error_message = "Must install cert-manager's CRDs — the ClusterIssuer/Certificate manifests this module also creates depend on them existing"
  }

  assert {
    condition     = tonumber([for s in helm_release.cert_manager.set : s.value if s.name == "replicaCount"][0]) >= 2
    error_message = "cert-manager must run HA — every cert issuance/renewal (public TLS + mTLS) depends on it"
  }
}

run "internal_ca_bootstrap_chain_is_correctly_ordered" {
  command = apply

  assert {
    condition     = kubernetes_manifest.internal_ca_bootstrap_issuer.manifest.spec.selfSigned != null
    error_message = "The bootstrap issuer must be self-signed — nothing else exists yet to sign the CA certificate"
  }

  assert {
    condition     = kubernetes_manifest.internal_ca_certificate.manifest.spec.isCA == true
    error_message = "The internal CA certificate must have isCA=true"
  }

  assert {
    condition     = kubernetes_manifest.internal_ca_certificate.manifest.spec.issuerRef.name == "internal-ca-bootstrap"
    error_message = "The CA certificate must be issued by the bootstrap (self-signed) issuer"
  }

  assert {
    condition     = kubernetes_manifest.internal_mtls_issuer.manifest.spec.ca.secretName == "ams-internal-ca-secret"
    error_message = "The mTLS issuer used for every backend service certificate must reference the CA's own secret, not the bootstrap issuer"
  }
}

run "every_bounded_context_namespace_gets_a_90_day_mtls_certificate" {
  command = apply

  assert {
    condition     = length(kubernetes_manifest.backend_mtls_certificate) == length(var.bounded_context_namespaces)
    error_message = "Every bounded-context namespace must get exactly one mTLS certificate"
  }

  assert {
    condition     = alltrue([for cert in kubernetes_manifest.backend_mtls_certificate : cert.manifest.spec.duration == "2160h"])
    error_message = "Every backend mTLS certificate must have a 90-day (2160h) duration, matching this WO's rotation requirement"
  }

  assert {
    condition     = alltrue([for cert in kubernetes_manifest.backend_mtls_certificate : cert.manifest.spec.issuerRef.name == "ams-internal-mtls-issuer"])
    error_message = "Every backend mTLS certificate must be issued by the internal mTLS issuer, not the public ACME issuer"
  }
}

run "routing_table_covers_every_required_path_group" {
  command = apply

  assert {
    condition = alltrue([
      for prefix in [
        "/api/v1/agents", "/api/v1/credits", "/api/v1/governance",
        "/api/v1/audit", "/api/v1/auth", "/api/v1/workflows"
      ] : contains(keys(var.gateway_route_backends), prefix)
    ])
    error_message = "The routing table must cover every path group this WO's acceptance criteria list: agents, credits, governance, audit, auth, workflows"
  }

  assert {
    condition     = length([for r in local.gateway_routes : r if r.prefix == "/api/v1/agents"]) == 1
    error_message = "Each path prefix must appear exactly once in the flattened routing list"
  }
}

run "main_ingress_routes_every_configured_path_prefix_and_enforces_tls" {
  command = apply

  assert {
    condition     = length(kubernetes_ingress_v1.api_gateway.spec[0].rule[0].http[0].path) == length(var.gateway_route_backends)
    error_message = "The main Ingress must have one path rule per entry in the routing table"
  }

  assert {
    condition     = kubernetes_ingress_v1.api_gateway.spec[0].tls[0].hosts[0] == var.gateway_hostname
    error_message = "The Ingress TLS block must cover the gateway hostname"
  }

  assert {
    condition     = kubernetes_ingress_v1.api_gateway.metadata[0].annotations["cert-manager.io/cluster-issuer"] == "public-tls-issuer"
    error_message = "The Ingress must be annotated to request its certificate from the public ACME issuer"
  }
}

run "adapter_ingress_is_separate_with_its_own_body_size_and_rate_limit" {
  command = apply

  assert {
    condition     = kubernetes_ingress_v1.adapter_gateway.metadata[0].annotations["nginx.ingress.kubernetes.io/proxy-body-size"] == "50m"
    error_message = "Adapter telemetry ingestion needs a larger body-size allowance than interactive API routes"
  }

  assert {
    condition     = kubernetes_ingress_v1.adapter_gateway.spec[0].rule[0].http[0].path[0].path == "/adapters"
    error_message = "The adapter Ingress must route the /adapters prefix"
  }
}

# --- WO-028: WAF + security headers ---

run "modsecurity_and_owasp_crs_are_enabled_on_the_ingress_controller" {
  command = apply

  assert {
    condition     = [for s in helm_release.ingress_nginx.set : s.value if s.name == "controller.config.enable-modsecurity"][0] == "true"
    error_message = "ModSecurity must be enabled on the ingress controller"
  }

  assert {
    condition     = [for s in helm_release.ingress_nginx.set : s.value if s.name == "controller.config.enable-owasp-modsecurity-crs"][0] == "true"
    error_message = "The OWASP Core Rule Set must be enabled, not just ModSecurity's engine"
  }
}

run "modsecurity_config_sets_paranoia_level_2_json_audit_logging_and_a_10mb_body_limit" {
  command = apply

  assert {
    condition     = strcontains(local.modsecurity_snippet, "tx.paranoia_level=2")
    error_message = "This WO's spec requires OWASP CRS paranoia level 2"
  }

  assert {
    condition     = strcontains(local.modsecurity_snippet, "SecAuditLogFormat JSON")
    error_message = "WAF-blocked requests must be logged in structured JSON for SIEM integration"
  }

  assert {
    condition     = strcontains(local.modsecurity_snippet, "SecRequestBodyLimit 10485760")
    error_message = "Request body limit must be 10MB (10485760 bytes) per this WO's spec"
  }

  assert {
    condition     = strcontains(local.modsecurity_snippet, "SecResponseBodyAccess Off")
    error_message = "Response body inspection must be disabled for performance, per this WO's spec"
  }
}

run "modsecurity_false_positive_exclusions_target_jwt_and_json_bodies_only" {
  command = apply

  assert {
    condition     = strcontains(local.modsecurity_snippet, "REQUEST_HEADERS:Authorization")
    error_message = "Must exclude the Authorization header (Bearer JWTs) from SQLi/XSS heuristics — a documented false-positive shape"
  }

  assert {
    condition     = strcontains(local.modsecurity_snippet, "application/(scim\\+)?json")
    error_message = "Must exclude JSON and SCIM+JSON request bodies from the SQLi body scan — this platform's own known false-positive shape"
  }
}

run "waf_blocked_responses_return_a_structured_json_body_that_never_reveals_the_matched_rule" {
  command = apply

  assert {
    condition     = strcontains(local.waf_403_server_snippet, "\"error\":\"request_blocked\"")
    error_message = "WAF 403 responses must use this WO's exact structured error code"
  }

  assert {
    condition     = !strcontains(local.waf_403_server_snippet, "rule_id") && !strcontains(local.waf_403_server_snippet, "MSC_")
    error_message = "The response body must never reveal which WAF rule matched (anti-reconnaissance requirement)"
  }

  assert {
    condition     = strcontains(local.waf_403_server_snippet, "$request_id")
    error_message = "The 403 body must include the same request_id correlation id every other response carries"
  }
}

run "security_response_headers_configmap_covers_every_mandatory_header" {
  command = apply

  assert {
    condition     = kubernetes_config_map.security_response_headers.data["Strict-Transport-Security"] == "max-age=31536000; includeSubDomains; preload"
    error_message = "HSTS must be exactly max-age=31536000; includeSubDomains; preload per this WO's spec"
  }

  assert {
    condition     = kubernetes_config_map.security_response_headers.data["X-Content-Type-Options"] == "nosniff"
    error_message = "X-Content-Type-Options must be nosniff"
  }

  assert {
    condition     = kubernetes_config_map.security_response_headers.data["X-Frame-Options"] == "DENY"
    error_message = "X-Frame-Options must be DENY, not the less-strict SAMEORIGIN"
  }
}

run "ingress_controller_references_the_security_headers_configmap" {
  command = apply

  assert {
    condition     = [for s in helm_release.ingress_nginx.set : s.value if s.name == "controller.config.add-headers"][0] == "ingress-nginx/security-response-headers"
    error_message = "The ingress controller must reference the security-response-headers ConfigMap by namespace/name"
  }
}
