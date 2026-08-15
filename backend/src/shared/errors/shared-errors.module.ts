import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { GlobalExceptionFilter } from "./global-exception.filter";

@Module({
  providers: [
    // Registered LAST among this app's global filters (see this
    // module's position in app.module.ts's imports array) so
    // RbacForbiddenExceptionFilter and any other exception-specific
    // filter gets first refusal — this is the fallback for everything
    // nothing more specific already handled.
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class SharedErrorsModule {}
