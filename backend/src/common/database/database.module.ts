import { Global, Module } from "@nestjs/common";
import { Pool } from "pg";

export const PG_POOL = "PG_POOL";

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () => {
        // ams_app (least-privilege role, WO-004) — never a superuser
        // connection. connectionString comes from Secrets Manager in
        // deployed environments (WO-004's rotation Lambda writes it);
        // DATABASE_URL here is the local/CI override.
        return new Pool({ connectionString: process.env.DATABASE_URL });
      },
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule {}
