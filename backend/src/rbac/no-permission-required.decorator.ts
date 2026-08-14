import { SetMetadata } from "@nestjs/common";

export const NO_PERMISSION_REQUIRED_KEY = "rbac:no_permission_required";

/**
 * Explicitly opts a route OUT of RbacGuard's deny-by-default permission
 * requirement — for routes that genuinely have none: pre-authentication
 * exchanges (SAML/OIDC callback, refresh, JWKS, health), authenticated
 * self-service actions that apply to the caller's own account rather
 * than anyone else's (MFA enroll/verify), and read-only platform
 * definition data anyone authenticated may see (GET /api/v1/rbac/*).
 * This is deliberate, audited-by-code-review opt-out, not an oversight —
 * every OTHER route with no decorator at all is denied by default.
 */
export const NoPermissionRequired = () => SetMetadata(NO_PERMISSION_REQUIRED_KEY, true);
