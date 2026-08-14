import { Controller, Get } from "@nestjs/common";
import { NoPermissionRequired } from "./no-permission-required.decorator";
import { RbacDefinitionService } from "./rbac-definition.service";

@Controller("api/v1/rbac")
export class RbacController {
  constructor(private readonly rbacDefinitionService: RbacDefinitionService) {}

  // Read-only platform-wide definition data — any authenticated user may
  // view "what does this role mean", it isn't itself a sensitive action.
  @Get("roles")
  @NoPermissionRequired()
  async getRoles() {
    return this.rbacDefinitionService.getRoles();
  }

  @Get("permissions")
  @NoPermissionRequired()
  async getPermissions() {
    return this.rbacDefinitionService.getPermissions();
  }
}
