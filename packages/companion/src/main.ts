import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createAdminApplication } from "./admin/app.js";
import { createDatabase } from "./database/database.js";
import type { Database } from "./database/database.js";

class StartupConfigurationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new StartupConfigurationError(`${name}_REQUIRED`);
  return value;
}

let database: Database | undefined;
let app: NestFastifyApplication | undefined;
try {
  const databaseUrl = requiredEnvironment("COMPANION_DATABASE_URL");
  if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
    throw new StartupConfigurationError("COMPANION_DATABASE_URL_INVALID");
  }
  const adminToken = requiredEnvironment("COMPANION_ADMIN_TOKEN");
  if (Buffer.byteLength(adminToken) < 32) {
    throw new StartupConfigurationError("COMPANION_ADMIN_TOKEN_INVALID");
  }
  const host = process.env.COMPANION_ADMIN_HOST ?? "127.0.0.1";
  const portRaw = process.env.COMPANION_ADMIN_PORT ?? "3010";
  if (
    !/^\d+$/.test(portRaw) ||
    Number(portRaw) < 1 ||
    Number(portRaw) > 65535
  ) {
    throw new StartupConfigurationError("COMPANION_ADMIN_PORT_INVALID");
  }
  const allowedOrigins = (process.env.COMPANION_ADMIN_CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  database = createDatabase(databaseUrl);
  app = await createAdminApplication({
    database,
    adminToken,
    corsOrigins: allowedOrigins,
  });
  await app.listen(Number(portRaw), host);
} catch (error) {
  try {
    await app?.close();
  } catch {
    // Startup cleanup reports only a stable code below.
  }
  try {
    await database?.close();
  } catch {
    // Startup cleanup reports only a stable code below.
  }
  const code =
    error instanceof StartupConfigurationError
      ? error.code
      : "COMPANION_ADMIN_STARTUP_FAILED";
  process.stderr.write(`${code}\n`);
  process.exit(1);
}

let shutdownPromise: Promise<void> | undefined;
function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    try {
      await app?.close();
    } finally {
      await database?.close();
    }
  })();
  return shutdownPromise;
}

function handleShutdownSignal(): void {
  void shutdown().then(
    () => process.exit(0),
    () => {
      process.stderr.write("COMPANION_ADMIN_SHUTDOWN_FAILED\n");
      process.exit(1);
    },
  );
}

process.once("SIGTERM", handleShutdownSignal);
process.once("SIGINT", handleShutdownSignal);
