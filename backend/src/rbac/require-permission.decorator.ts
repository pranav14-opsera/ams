import { SetMetadata } from "@nestjs/common";

export const REQUIRE_PERMISSION_KEY = "rbac:require_permission";

/** Declares the permission (from the WO-023 matrix, e.g. "agent_management:agent:create") a route requires. RbacGuard denies by default when this is absent — every real route must declare one. */
export const RequirePermission = (permission: string) => SetMetadata(REQUIRE_PERMISSION_KEY, permission);
