import { Module } from "@nestjs/common";
import { RbacController } from "./rbac.controller";
import { RbacDefinitionService } from "./rbac-definition.service";

@Module({
  controllers: [RbacController],
  providers: [RbacDefinitionService],
  exports: [RbacDefinitionService],
})
export class RbacModule {}
