# WAF and Security Headers (WO-028)

Adds Web Application Firewall protection and mandatory security response
headers to the gateway established in WO-026 — `waf.tf`, plus new `set`
blocks on the existing `helm_release.ingress_nginx` in `gateway.tf`.

## WAF: ModSecurity + OWASP Core Rule Set

Enabled directly on the ingress-nginx release
(`controller.config.enable-modsecurity` / `enable-owasp-modsecurity-crs`).
`local.modsecurity_snippet` (`waf.tf`) configures:

- **Paranoia level 2**, per this WO's own spec.
- **Structured JSON audit logging** to stdout (`SecAuditLogFormat JSON`) —
  picked up by the cluster's log pipeline for SIEM forwarding, satisfying
  the "WAF blocked requests are logged in structured JSON" acceptance
  criterion.
- **10MB request body limit**, **response body inspection disabled**
  (performance), exactly as this WO's implementation steps specify.
- **False-positive exclusions**, scoped by rule tag rather than
  disabling whole categories: JWT Bearer tokens in the `Authorization`
  header (base64url segments joined by `.` trip some SQLi/XSS
  heuristics), and JSON/SCIM+JSON request bodies (this platform's own
  API payload shape, including WO-015's base64-encoded BYOK ciphertext
  fields).
- **A custom 403 JSON body** (`local.waf_403_server_snippet`) —
  `{"error":"request_blocked","message":"Request blocked by security
  policy.","request_id":"$request_id"}` — using NGINX's own
  `$request_id` (the same correlation id every other response carries),
  and deliberately never revealing which rule matched (anti-
  reconnaissance requirement).

## Security response headers

`kubernetes_config_map.security_response_headers` sets HSTS (1-year
max-age, includeSubDomains, preload), X-Content-Type-Options,
X-Frame-Options: DENY, Referrer-Policy, and Permissions-Policy on every
response the gateway proxies, referenced via ingress-nginx's
`add-headers` config option.

**CSP is deliberately NOT duplicated here.** It's set once, by the
backend's own `helmet` middleware (`backend/src/main.ts`, directives in
`backend/src/gateway/csp-policy.ts`) — a single source of truth, the
same "don't build two independent things that do the same job" reasoning
GATEWAY.md already applies to JWT validation. A future frontend-serving
edge (if one is added ahead of the backend) would need its own CSP
matching that same policy.

## XXE prevention

This platform's **one** real XML parsing path is SAML assertion
validation (`backend/src/auth/saml.service.ts`, via
`@node-saml/node-saml` → `@xmldom/xmldom` + `xml2js`). Rather than
assuming these libraries are safe by reputation,
`backend/test/gateway/xxe-protection.test.ts` feeds a real, validly
signed SAML assertion containing a `SYSTEM` external entity pointing at
a local file through the actual validation path. Result: xmldom throws
`entity not found` — it doesn't resolve external entities at all, so
there is no file-content-exfiltration path to close. No other XML
parser exists anywhere else in this codebase.

## What this offline module cannot validate

Same boundary GATEWAY.md already draws for TLS/mTLS — these require a
live, deployed cluster:

- **OWASP ZAP / Nikto scan with zero critical/high findings** — run
  against the live Ingress once deployed.
- **WAF latency overhead (<15ms P99 at 1,000 req/s)** — a k6 load test
  comparing WAF-enabled vs. disabled against the live Ingress.
- **Live attack-payload testing** (SQLi/XSS/SSRF/path-traversal against
  the real ModSecurity+CRS engine) — this sandbox has no ModSecurity
  binary to run these against; `tests/gateway.tftest.hcl`'s new WAF run
  blocks verify the *configuration* (paranoia level, exclusions, log
  format, header values) is correctly wired, not that a live WAF engine
  actually blocks a given payload.
- **WAF audit log forwarding to ELK/CloudWatch** — verify once a real
  log pipeline is deployed downstream of the cluster's stdout collection.
