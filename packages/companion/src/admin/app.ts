import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Module, type DynamicModule } from "@nestjs/common";
import type { Database } from "../database/database.js";
import { IdentityService } from "../identity/identity-service.js";
import { DeliveryService } from "../transactions/delivery-service.js";
import { MemoryLifecycleService } from "../memory/memory-lifecycle-service.js";
import { AdminController } from "./controller.js";
import {
  AdminGuard,
  ApiExceptionFilter,
  ADMIN_DATABASE,
  ADMIN_TOKEN,
} from "./auth.js";

export type AdminApplicationOptions = {
  database: Database;
  adminToken: string;
  modelConfigured?: boolean;
  qqConfigured?: boolean;
  corsOrigins?: string[];
};

@Module({})
class AdminModule {
  static register(definition: DynamicModule): DynamicModule {
    return definition;
  }
}

/** The injected Database stays caller-owned; callers close it after closing this app. */
export async function createAdminApplication(
  options: AdminApplicationOptions,
): Promise<NestFastifyApplication> {
  if (!options.database) throw new Error("COMPANION_DATABASE_REQUIRED");
  if (!options.adminToken || Buffer.byteLength(options.adminToken) < 32) {
    throw new Error("COMPANION_ADMIN_TOKEN_INVALID");
  }

  const definition: DynamicModule = {
    module: AdminModule,
    controllers: [AdminController],
    providers: [
      { provide: ADMIN_DATABASE, useValue: options.database },
      { provide: ADMIN_TOKEN, useValue: options.adminToken },
      {
        provide: "HEALTH_CONFIG",
        useValue: {
          model:
            options.modelConfigured ??
            Boolean(process.env.AI_BASE_URL && process.env.AI_MODEL),
          qq: options.qqConfigured ?? Boolean(process.env.NAPCAT_WS_URL),
        },
      },
      {
        provide: "IDENTITY",
        useFactory: () => new IdentityService(options.database),
      },
      {
        provide: "DELIVERY",
        useFactory: () => new DeliveryService(options.database),
      },
      { provide: "MEMORY_LIFECYCLE", useFactory: () => new MemoryLifecycleService(options.database) },
      {
        provide: AdminGuard,
        useFactory: () => new AdminGuard(options.adminToken),
      },
    ],
  };
  const app = await NestFactory.create<NestFastifyApplication>(
    AdminModule.register(definition),
    new FastifyAdapter({ logger: false }),
    { logger: false },
  );
  app.useGlobalGuards(app.get(AdminGuard));
  app.useGlobalFilters(new ApiExceptionFilter());
  if (options.corsOrigins && options.corsOrigins.length > 0) {
    app.enableCors({
      origin: options.corsOrigins,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type"],
      credentials: false,
    });
  }
  await app.init();
  return app;
}
