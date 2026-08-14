import { Controller, Get } from "@nestjs/common";
import { RbacDefinitionService } from "./rbac-definition.service";

@Controller("api/v1/rbac")
export class RbacController {
  constructor(private readonly rbacDefinitionService: RbacDefinitionService) {}

  @Get("roles")
  async getRoles() {
    return this.rbacDefinitionService.getRoles();
  }

  @Get("permissions")
  async getPermissions() {
    return this.rbacDefinitionService.getPermissions();
  }
}
