import { Logger, Module } from "@nestjs/common";
import { createPool } from "@lpr/db";
import { HealthController } from "./health.controller.js";
import { DB_POOL, HealthService } from "./health.service.js";
import { loadEnv } from "../../config/env.js";

/**
 * Phase 0 wires the database pool here so /ready has something real to probe.
 * Phase 1 moves pool provisioning into a dedicated DatabaseModule shared by
 * every domain module.
 */
@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    {
      provide: DB_POOL,
      useFactory: () => {
        const logger = new Logger("DbPool");
        return createPool({
          connectionString: loadEnv().DATABASE_URL,
          max: 4,
          // Log and carry on. The pool reconnects; the process must not die.
          onError: (error) => logger.error(`idle client error: ${error.message}`),
        });
      },
    },
  ],
  exports: [DB_POOL],
})
export class HealthModule {}
