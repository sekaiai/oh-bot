import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  CanActivate,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  Inject,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

export const ADMIN_DATABASE = Symbol("ADMIN_DATABASE");
export const ADMIN_TOKEN = Symbol("ADMIN_TOKEN");
const authenticatedAdminPrincipals = new WeakSet<object>();
export type AuthenticatedAdminPrincipal = Readonly<{ kind: "admin"; auditActorId: string }>;
function createAuthenticatedAdminPrincipal(): AuthenticatedAdminPrincipal {
  const principal = Object.freeze({ kind: "admin" as const, auditActorId: "admin" });
  authenticatedAdminPrincipals.add(principal);
  return principal;
}
export function isAuthenticatedAdminPrincipal(value: unknown): value is AuthenticatedAdminPrincipal {
  return typeof value === "object" && value !== null && authenticatedAdminPrincipals.has(value);
}
const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();
const jobListQuerySchema = listQuerySchema.extend({
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]).optional(),
});
const emptyQuerySchema = z.object({}).strict();
const paginatedAdminPaths = new Set([
  "/admin/people",
  "/admin/identities",
  "/admin/identities/links",
  "/admin/characters",
  "/admin/circles",
  "/admin/model-profiles",
  "/admin/job-logs",
  "/admin/turns",
  "/admin/deliveries",
]);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export class AdminGuard implements CanActivate {
  constructor(@Inject(ADMIN_TOKEN) private readonly token: string) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const canonicalRoute = request.routeOptions?.url;
    if (canonicalRoute === "/health") return true;
    const authorization = request.headers.authorization;
    if (
      typeof authorization !== "string" ||
      !authorization.startsWith("Bearer ")
    ) {
      throw new ApiError(401, "unauthorized");
    }
    const received = Buffer.from(authorization.slice(7));
    const expected = Buffer.from(this.token);
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      throw new ApiError(401, "unauthorized");
    }
    const requestPath = canonicalRoute;
    const querySchema = request.method === "GET" && requestPath === "/admin/job-logs"
      ? jobListQuerySchema
      : request.method === "GET" && requestPath && paginatedAdminPaths.has(requestPath)
        ? listQuerySchema
        : emptyQuerySchema;
    if (!querySchema.safeParse(request.query).success) {
      throw new ApiError(400, "invalid_input");
    }
    (
      request as FastifyRequest & {
        adminPrincipal?: AuthenticatedAdminPrincipal;
      }
    ).adminPrincipal = createAuthenticatedAdminPrincipal();
    return true;
  }
}

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  while (current && typeof current === "object") {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: import("@nestjs/common").ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const headerId = request.headers["x-request-id"];
    const requestId =
      typeof headerId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(headerId)
        ? headerId
        : randomUUID();
    const apiError = error instanceof ApiError ? error : undefined;
    const statusFromException =
      typeof (error as { getStatus?: () => number })?.getStatus === "function"
        ? (error as { getStatus: () => number }).getStatus()
        : undefined;
    const sqlState = postgresCode(error);
    const sqlStatus =
      sqlState === "23505"
        ? 409
        : sqlState === "23503"
          ? 404
          : sqlState === "23514"
            ? 400
            : undefined;
    const status = apiError?.status ?? statusFromException ?? sqlStatus ?? 500;
    const code =
      apiError?.code ??
      (status === 404
        ? "not_found"
        : status === 401
          ? "unauthorized"
          : status === 409
            ? "conflict"
            : status < 500
              ? "invalid_input"
              : "internal_error");
    void reply.status(status).send({ code, requestId });
  }
}
