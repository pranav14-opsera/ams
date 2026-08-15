import { SetMetadata } from "@nestjs/common";

export const REQUIRE_ANY_PERMISSION_KEY = "rbac:require_any_permission";

/**
 * WO-047: some routes are shared by roles whose access is granted via
 * DIFFERENT permissions rather than a single common one — e.g.
 * GET /api/v1/audit/logs, where compliance_officer holds only
 * `audit_access:logs:view_org` and team_lead holds only
 * `audit_access:logs:view_team` (platform_admin holds both). A single
 * `@RequirePermission(...)` can't express "any of these" since RbacGuard
 * denies unless the caller holds that EXACT permission. This declares an
 * OR-set instead — the caller must hold at least one of the listed
 * permissions. Existing `@RequirePermission` routes are entirely
 * unaffected; RbacGuard checks this metadata first and only falls back
 * to the single-permission path when it's absent.
 */
export const RequireAnyPermission = (permissions: string[]) => SetMetadata(REQUIRE_ANY_PERMISSION_KEY, permissions);
