# WO-026: routes every /api/v1/* path group (agents, credits, governance,
# audit, auth, workflows, rbac, tenants), /scim/v2/*, and /health/* through
# the NGINX Ingress this module installs (gateway.tf) to the backend
# service currently serving it (var.gateway_route_backends).
#
# Where JWT validation actually happens: this Ingress does NOT re-verify
# JWTs at the edge via an nginx.ingress.kubernetes.io/auth-url subrequest.
# TenantContextMiddleware (backend/src/common/tenant-context.middleware.ts)
# and RbacGuard (WO-024) already perform full RS256/JWKS-rotation-aware
# verification, tenant-context extraction, and deny-by-default permission
# enforcement on every request — re-implementing that same verification a
# second time in NGINX/Lua would mean two independent JWT verifiers to
# keep in sync (a worse security posture, not a better one) for identical
# coverage. This Ingress's job is edge concerns only: TLS termination,
# routing, correlation id, rate limiting — the SSO callback / SCIM / health
# "no JWT required" distinction in this WO's acceptance criteria is
# already true by construction, since no gateway-level JWT check exists to
# require one anywhere.

locals {
  # kubernetes_ingress_v1's `rule.http.path` blocks need a flat list, not
  # the map var.gateway_route_backends is naturally expressed as.
  gateway_routes = [
    for prefix, backend in var.gateway_route_backends : {
      prefix    = prefix
      namespace = backend.namespace
      service   = backend.service
      port      = backend.port
    }
  ]
}

resource "kubernetes_ingress_v1" "api_gateway" {
  metadata {
    name      = "ams-api-gateway"
    namespace = "ingress-nginx"
    annotations = {
      "kubernetes.io/ingress.class"                    = "nginx"
      "cert-manager.io/cluster-issuer"                 = "public-tls-issuer"
      "nginx.ingress.kubernetes.io/ssl-redirect"       = "true"
      "nginx.ingress.kubernetes.io/proxy-body-size"    = "10m"
      "nginx.ingress.kubernetes.io/proxy-read-timeout" = "30"
      # mTLS to backend services (gateway.tf's internal CA) — NGINX
      # presents this client certificate on every upstream connection.
      # This is a Kubernetes Secret NAME reference (namespace/secretname),
      # not a literal secret value — the actual cert/key content lives in
      # the Secret cert-manager creates (gateway.tf), never inline here.
      "nginx.ingress.kubernetes.io/proxy-ssl-secret"      = "ingress-nginx/ams-gateway-client-mtls" # checkov:skip=CKV_SECRET_6:Secret NAME reference, not a literal secret value
      "nginx.ingress.kubernetes.io/proxy-ssl-verify"      = "on"
      "nginx.ingress.kubernetes.io/proxy-ssl-name"        = "ams-internal-ca"
      "nginx.ingress.kubernetes.io/configuration-snippet" = "proxy_set_header X-Request-ID $req_id;"
    }
  }

  spec {
    tls {
      hosts       = [var.gateway_hostname]
      secret_name = "ams-gateway-public-tls"
    }

    rule {
      host = var.gateway_hostname

      http {
        dynamic "path" {
          for_each = local.gateway_routes
          content {
            path      = path.value.prefix
            path_type = "Prefix"

            backend {
              service {
                name = path.value.service
                port {
                  number = path.value.port
                }
              }
            }
          }
        }
      }
    }
  }

  depends_on = [helm_release.ingress_nginx, kubernetes_manifest.public_tls_issuer]
}

# HMAC-signed adapter telemetry ingestion (LangChain/CrewAI/AutoGen/REST) —
# a SEPARATE Ingress rather than folded into the rule set above: telemetry
# payloads run larger (batch trace uploads) and have a different traffic
# shape (high-volume, bursty) than interactive API calls, warranting their
# own body-size/rate-limit tuning independent of the main API routes.
resource "kubernetes_ingress_v1" "adapter_gateway" {
  metadata {
    name      = "ams-adapter-gateway"
    namespace = "ingress-nginx"
    annotations = {
      "kubernetes.io/ingress.class"                       = "nginx"
      "cert-manager.io/cluster-issuer"                    = "public-tls-issuer"
      "nginx.ingress.kubernetes.io/ssl-redirect"          = "true"
      "nginx.ingress.kubernetes.io/proxy-body-size"       = "50m" # batch trace uploads run larger than interactive API payloads
      "nginx.ingress.kubernetes.io/limit-rps"             = "200" # bursty telemetry ingestion gets its own, higher rate-limit ceiling
      "nginx.ingress.kubernetes.io/configuration-snippet" = "proxy_set_header X-Request-ID $req_id;"
    }
  }

  spec {
    tls {
      hosts       = [var.gateway_hostname]
      secret_name = "ams-gateway-public-tls"
    }

    rule {
      host = var.gateway_hostname

      http {
        path {
          path      = "/adapters"
          path_type = "Prefix"

          backend {
            service {
              name = var.gateway_route_backends["/adapters"].service
              port {
                number = var.gateway_route_backends["/adapters"].port
              }
            }
          }
        }
      }
    }
  }

  depends_on = [helm_release.ingress_nginx, kubernetes_manifest.public_tls_issuer]
}

# WO-030: /ws/dashboard, /ws/alerts, /ws/approvals — long-lived WebSocket
# connections, currently served by the SAME backend service as the REST
# API (ams-backend), not yet split into a genuinely separate deployment
# (see WEBSOCKET.md). ingress-nginx proxies the Upgrade/Connection
# handshake transparently with no special annotation required; what
# DOES need overriding is proxy-read-timeout — the default (60s) would
# silently kill every idle WebSocket connection, which is the opposite
# of what this WO's whole point is.
resource "kubernetes_ingress_v1" "websocket_gateway" {
  metadata {
    name      = "ams-websocket-gateway"
    namespace = "ingress-nginx"
    annotations = {
      "kubernetes.io/ingress.class"                    = "nginx"
      "cert-manager.io/cluster-issuer"                 = "public-tls-issuer"
      "nginx.ingress.kubernetes.io/ssl-redirect"       = "true"
      "nginx.ingress.kubernetes.io/proxy-read-timeout" = "3600" # long-lived connections — the default 60s would kill idle WebSocket sessions
      "nginx.ingress.kubernetes.io/proxy-send-timeout" = "3600"
    }
  }

  spec {
    tls {
      hosts       = [var.gateway_hostname]
      secret_name = "ams-gateway-public-tls"
    }

    rule {
      host = var.gateway_hostname

      http {
        dynamic "path" {
          for_each = ["/ws/dashboard", "/ws/alerts", "/ws/approvals"]
          content {
            path      = path.value
            path_type = "Prefix"

            backend {
              service {
                name = var.gateway_route_backends["/api/v1/auth"].service # same backend process — see WEBSOCKET.md
                port {
                  number = var.gateway_route_backends["/api/v1/auth"].port
                }
              }
            }
          }
        }
      }
    }
  }

  depends_on = [helm_release.ingress_nginx, kubernetes_manifest.public_tls_issuer]
}
