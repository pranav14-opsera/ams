# API Gateway (WO-026)

Adds the platform's single edge entry point to the `kubernetes` module
(alongside the EKS cluster itself, Argo Rollouts, and Kyverno) —
`gateway.tf` and `gateway-routes.tf`.

## What this provisions

- **NGINX Ingress Controller** (`helm_release.ingress_nginx`), HA (3
  replicas), TLS 1.3 only (`ssl-protocols = "TLSv1.3"` — listing only
  1.3 is what actually rejects 1.0/1.1, not merely offering 1.3
  alongside them), `X-Request-ID` correlation-id generation built into
  NGINX itself, and structured JSON access logging.
- **cert-manager** (`helm_release.cert_manager`), HA (2 replicas), CRDs
  installed.
- **Public-facing TLS**: an ACME (Let's Encrypt) `ClusterIssuer` via
  HTTP-01, referenced by the main Ingress's
  `cert-manager.io/cluster-issuer` annotation.
- **Internal mTLS CA**: a two-tier cert-manager bootstrap (a
  self-signed `ClusterIssuer` mints the CA certificate; a second
  `ClusterIssuer` referencing that CA's secret issues every backend
  service's own leaf certificate) — one 90-day, auto-renewed (30 days
  before expiry) certificate per bounded-context namespace.
- **Routing**: `var.gateway_route_backends` is a path-prefix → 
  {namespace, service, port} map covering every path group this WO's
  acceptance criteria list (`/api/v1/agents`, `/credits`, `/governance`,
  `/audit`, `/auth`, `/workflows`, plus `/api/v1/rbac`, `/api/v1/tenants`,
  `/scim/v2`, `/health`). A separate Ingress handles `/adapters/*`
  (larger body-size allowance and its own rate-limit ceiling — batch
  telemetry uploads have a different traffic shape than interactive API
  calls).

## Where JWT validation actually happens

This gateway does **not** re-verify JWTs at the edge (no
`nginx.ingress.kubernetes.io/auth-url` subrequest). The backend's
`TenantContextMiddleware` and `RbacGuard` (WO-024) already perform full
RS256/JWKS-rotation-aware verification, tenant-context extraction, and
deny-by-default permission enforcement on every request. Re-implementing
that same verification a second time in NGINX/Lua would mean two
independent JWT verifiers to keep in sync for identical coverage — a
worse security posture, not a better one, and a meaningfully larger,
harder-to-test surface (hand-written Lua with no equivalent to this
repo's `node --test` suite). This gateway's job is edge concerns only:
TLS termination, routing, correlation id, rate limiting/WAF-adjacent
concerns. The "SSO callback / SCIM / health endpoints require no JWT"
distinction in this WO's acceptance criteria is therefore already true
by construction — there is no gateway-level JWT check anywhere for
those routes to need to skip.

## What today's routing table represents

`var.gateway_route_backends` currently points every path group at the
**same** single `ams-backend` service — this platform is presently one
NestJS monolith (`backend/`), not yet split into per-bounded-context
microservices. This map is exactly what becomes a real multi-service
routing table as each bounded context gets its own service, with no
Ingress-resource restructuring needed later.

## Health check endpoints

`/health/live`, `/health/ready` (WO-007), and the new `/health/startup`
(this WO — verifies the database is reachable, distinct from "the
process is up") are all implemented in `backend/src/health.controller.ts`
and excluded from `TenantContextMiddleware`/`RbacGuard` (see
`PRE_AUTH_ROUTES` in `backend/src/app.module.ts`) — they need to answer
before any JWT/tenant context could possibly exist.

## What this offline module cannot validate

Three of this WO's acceptance criteria require a live, deployed
environment and are **intentionally not** part of `tests/gateway.tftest.hcl`'s
offline (mock-provider) suite, the same boundary `tests/kubernetes.tftest.hcl`
already draws for the EKS cluster itself:

- **TLS 1.3 enforcement / TLS 1.0-1.1 rejection** — verify with
  `testssl.sh` against the live Ingress once deployed.
- **<10ms P99 gateway latency overhead at 1,000 req/s** — verify with a
  `k6` load test against the live Ingress.
- **90-day mTLS certificate rotation** — verify by observing an actual
  renewal in a live cluster; this module's `renewBefore = "720h"` is
  configuration, not a substitute for watching it happen.

## Composition

Same pattern as the rest of this module — takes cluster/namespace state
from resources this module itself already creates
(`kubernetes_namespace.system["ingress-nginx"]`,
`kubernetes_namespace.bounded_context`), not from a separate module.
