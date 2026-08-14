import { Injectable } from "@nestjs/common";
import { RbacDefinitionService } from "./rbac-definition.service";

const CACHE_TTL_MS = 60_000;

/**
 * A real, functional in-memory cache of the WO-023 role->permission
 * matrix (60-second TTL, per this WO's acceptance criteria) — single
 * shared snapshot across the whole process, refreshed lazily on expiry.
 * For a single-instance deployment this is a genuine cache, not a stub;
 * a multi-instance production deployment would swap this for a real
 * Redis-backed implementation behind the same interface (same pattern
 * already used for session/refresh-token/rate-limiter storage in this
 * codebase) — the matrix rarely changes, so even a stale 60s snapshot is
 * an acceptable trade-off either way.
 */
@Injectable()
export class RbacMatrixCacheService {
  private snapshot: Map<string, string[]> | null = null; // permission name -> granting role names
  private expiresAt = 0;

  constructor(private readonly rbacDefinitionService: RbacDefinitionService) {}

  async getGrantingRoles(permissionName: string): Promise<string[]> {
    const matrix = await this.getSnapshot();
    return matrix.get(permissionName) ?? [];
  }

  async hasPermission(roleName: string, permissionName: string): Promise<boolean> {
    const grantingRoles = await this.getGrantingRoles(permissionName);
    return grantingRoles.includes(roleName);
  }

  private async getSnapshot(): Promise<Map<string, string[]>> {
    if (this.snapshot && Date.now() < this.expiresAt) {
      return this.snapshot;
    }

    const roles = await this.rbacDefinitionService.getRoles();
    const matrix = new Map<string, string[]>();
    for (const role of roles) {
      for (const permission of role.permissions) {
        const existing = matrix.get(permission) ?? [];
        existing.push(role.name);
        matrix.set(permission, existing);
      }
    }

    this.snapshot = matrix;
    this.expiresAt = Date.now() + CACHE_TTL_MS;
    return matrix;
  }
}
