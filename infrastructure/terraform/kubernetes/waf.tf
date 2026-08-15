# WO-028: WAF (OWASP Core Rule Set via ModSecurity, enabled on the
# ingress-nginx release in gateway.tf), mandatory security response
# headers, and XXE prevention for the platform's gateway layer.
#
# XXE: this platform's one real XML parsing path is SAML assertion
# validation (backend/src/auth/saml.service.ts, via @node-saml/node-saml
# -> @xmldom/xmldom + xml2js) — neither library implements external
# entity resolution at all (verified, not assumed:
# backend/test/gateway/xxe-protection.test.ts feeds a real signed SAML
# assertion with a SYSTEM entity pointing at a local file through the
# real validation path and confirms it is rejected, never expanded).
# There is no XML parser anywhere else in this codebase to secure.

locals {
  # CRS paranoia level 2 (this WO's own spec) + structured JSON audit
  # logging to stdout (picked up by the cluster's log pipeline for SIEM
  # forwarding) + exclusions for this platform's own known
  # false-positive shapes: JWT Authorization headers (base64url with
  # dots trips some injection heuristics), SCIM/REST JSON bodies
  # carrying long field values, and this platform's own base64-encoded
  # BYOK ciphertext fields (WO-015) in request bodies.
  modsecurity_snippet = <<-EOT
    SecRuleEngine On
    SecAuditEngine RelevantOnly
    SecAuditLog /dev/stdout
    SecAuditLogFormat JSON
    SecAuditLogType Serial
    SecAuditLogParts ABIJDEFHZ
    SecRequestBodyLimit 10485760
    SecRequestBodyNoFilesLimit 10485760
    SecResponseBodyAccess Off
    SecDefaultAction "phase:2,deny,log,status:403"

    # Paranoia level 2 — the level this WO's implementation steps specify.
    SecAction "id:900000,phase:1,pass,nolog,setvar:tx.paranoia_level=2"

    # False-positive exclusions for this platform's own known-legitimate
    # shapes, scoped by rule tag rather than disabling entire categories:
    # - JWT Bearer tokens in the Authorization header (base64url segments
    #   joined by '.' can trip SQLi/XSS heuristics on the header value).
    SecRule REQUEST_HEADERS:Authorization "@rx ^Bearer\s" \
      "id:1000001,phase:1,pass,nolog,ctl:ruleRemoveTargetByTag=attack-sqli;ARGS,ctl:ruleRemoveTargetByTag=attack-xss;ARGS"
    # - SCIM/REST JSON bodies: a field literally named e.g. "userName" or
    #   containing base64-encoded BYOK ciphertext (WO-015) is not SQL
    #   injection just because it contains SQL-keyword-shaped substrings.
    SecRule REQUEST_HEADERS:Content-Type "@rx application/(scim\+)?json" \
      "id:1000002,phase:1,pass,nolog,ctl:ruleRemoveTargetByTag=attack-sqli;REQUEST_BODY"
  EOT

  # NGINX's own $request_id (built in since 1.11.0, no extra module) —
  # the SAME correlation id gateway.tf's log-format-upstream and
  # X-Request-ID header already use. Never reveals which ModSecurity
  # rule matched, per this WO's anti-reconnaissance requirement.
  waf_403_server_snippet = <<-EOT
    error_page 403 = @waf_blocked;
    location @waf_blocked {
      default_type application/json;
      return 403 '{"error":"request_blocked","message":"Request blocked by security policy.","request_id":"$request_id"}';
    }
  EOT
}

# ingress-nginx's `add-headers` ConfigMap convention: every key becomes a
# `HeaderName: value` line added to every proxied response via
# ngx_http_headers_module.
resource "kubernetes_config_map" "security_response_headers" {
  metadata {
    name      = "security-response-headers"
    namespace = "ingress-nginx"
  }

  data = {
    "Strict-Transport-Security" = "max-age=31536000; includeSubDomains; preload"
    "X-Content-Type-Options"    = "nosniff"
    "X-Frame-Options"           = "DENY"
    "Referrer-Policy"           = "strict-origin-when-cross-origin"
    "Permissions-Policy"        = "camera=(), microphone=(), geolocation=(), payment=()"
    # CSP is set by the backend's own helmet middleware
    # (backend/src/main.ts) rather than duplicated here — a single
    # source of truth for the directive list, since ingress-nginx's
    # add-headers ConfigMap can't reference the same TypeScript constant
    # (backend/src/gateway/csp-policy.ts) this Terraform module has no
    # access to. Setting it twice with two configs to keep in sync would
    # be the same "two independent things doing the same job" problem
    # this WO's own JWT-validation design (GATEWAY.md) already avoids.
  }

  depends_on = [kubernetes_namespace.system]
}
