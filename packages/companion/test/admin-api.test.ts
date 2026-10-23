import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { createAdminApplication } from "../src/admin/app.js";
import type { Database } from "../src/database/database.js";

const token = "test-only-admin-token-that-is-longer-than-32-bytes";
const query = {
  from: () => query,
  orderBy: () => query,
  limit: () => query,
  offset: async () => [],
};
const database = {
  db: { execute: async () => ({ rows: [] }), select: () => query },
  pool: {},
  close: async () => undefined,
} as unknown as Database;

test("Nest Fastify inject protects every admin route and keeps health public and redacted", async () => {
  const app = await createAdminApplication({ database, adminToken: token });
  try {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().databaseReady, false);
    assert.equal(JSON.stringify(health.json()).includes(token), false);

    const protectedRoutes = [
      ["GET", "/admin/people"],
      ["POST", "/admin/people"],
      ["GET", "/admin/identities"],
      ["GET", "/admin/identities/links"],
      ["GET", "/admin/characters"],
      ["POST", "/admin/characters"],
      [
        "GET",
        "/admin/characters/00000000-0000-4000-8000-000000000001/primary-partner",
      ],
      [
        "PUT",
        "/admin/characters/00000000-0000-4000-8000-000000000001/primary-partner",
      ],
      ["GET", "/admin/circles"],
      ["POST", "/admin/circles"],
      ["POST", "/admin/circles/00000000-0000-4000-8000-000000000001/members"],
      [
        "DELETE",
        "/admin/circles/00000000-0000-4000-8000-000000000001/members/00000000-0000-4000-8000-000000000002",
      ],
      [
        "GET",
        "/admin/conversations/00000000-0000-4000-8000-000000000001/policy",
      ],
      [
        "PUT",
        "/admin/conversations/00000000-0000-4000-8000-000000000001/policy",
      ],
      ["GET", "/admin/model-profiles"],
      ["POST", "/admin/model-profiles"],
      ["PUT", "/admin/model-profiles/00000000-0000-4000-8000-000000000001"],
      [
        "GET",
        "/admin/characters/00000000-0000-4000-8000-000000000001/model-bindings",
      ],
      [
        "PUT",
        "/admin/characters/00000000-0000-4000-8000-000000000001/model-bindings",
      ],
      ["GET", "/admin/job-logs"],
      ["GET", "/admin/worker/status"],
      ["GET", "/admin/job-logs/00000000-0000-4000-8000-000000000001"],
      ["POST", "/admin/job-logs/00000000-0000-4000-8000-000000000001/retry"],
      ["GET", "/admin/turns"],
      ["GET", "/admin/deliveries"],
      [
        "POST",
        "/admin/deliveries/00000000-0000-4000-8000-000000000001/reconcile",
      ],
    ] as const;
    for (const [method, url] of protectedRoutes) {
      const response = await app.inject({ method, url });
      assert.equal(response.statusCode, 401, `${method} ${url}`);
      assert.equal(response.json().code, "unauthorized");
    }

    const encodedAdminPath = await app.inject({
      method: "GET",
      url: "/%61dmin/people",
    });
    assert.equal(encodedAdminPath.statusCode, 401);

    const authorized = await app.inject({
      method: "GET",
      url: "/admin/people",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(authorized.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("admin API rejects malformed bearer credentials without reflecting them", async () => {
  const app = await createAdminApplication({ database, adminToken: token });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/admin/people",
      headers: { authorization: "Bearer secret-sentinel" },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.includes("secret-sentinel"), false);
  } finally {
    await app.close();
  }
});

test("admin API rejects unknown body fields and invalid pagination at HTTP boundary", async () => {
  const app = await createAdminApplication({ database, adminToken: token });
  try {
    const headers = { authorization: `Bearer ${token}` };
    const body = await app.inject({
      method: "POST",
      url: "/admin/people",
      headers,
      payload: { displayName: "x", kind: "admin" },
    });
    assert.equal(body.statusCode, 400);
    assert.equal(body.json().code, "invalid_input");

    const page = await app.inject({
      method: "GET",
      url: "/admin/people?limit=101",
      headers,
    });
    assert.equal(page.statusCode, 400);
    assert.equal(page.json().code, "invalid_input");
    const secretUrl = await app.inject({
      method: "POST",
      url: "/admin/model-profiles",
      headers,
      payload: {
        name: "invalid-secret-url",
        purpose: "chat",
        provider: "test",
        baseUrl:
          "https://user:secret-sentinel@example.invalid/v1?key=secret-sentinel",
        model: "chat-model",
        credentialRef: "API_KEY",
      },
    });
    assert.equal(secretUrl.statusCode, 400);
    assert.equal(secretUrl.body.includes("secret-sentinel"), false);

    const defaultGuard = await app.inject({
      method: "GET",
      url: "/admin/new-route-added-later",
    });
    assert.equal(defaultGuard.statusCode, 404);
    const unauthorizedInvalidQuery = await app.inject({
      method: "GET",
      url: "/admin/people?limit=101",
    });
    assert.equal(unauthorizedInvalidQuery.statusCode, 401);
    const unknownQuery = await app.inject({
      method: "GET",
      url: "/admin/people?unexpected=true",
      headers,
    });
    assert.equal(unknownQuery.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("admin API rejects non-http model URLs and invalid time zones", async () => {
  const app = await createAdminApplication({ database, adminToken: token });
  try {
    const headers = { authorization: `Bearer ${token}` };
    const profile = await app.inject({
      method: "POST",
      url: "/admin/model-profiles",
      headers,
      payload: { name: "ftp-profile", purpose: "chat", provider: "test", baseUrl: "ftp://example.invalid/model", model: "x", credentialRef: "KEY" },
    });
    assert.equal(profile.statusCode, 400);
    const policy = await app.inject({
      method: "PUT",
      url: "/admin/conversations/00000000-0000-4000-8000-000000000001/policy",
      headers,
      payload: { version: 1, triggerMode: "mentioned", circleDisclosureVerified: false, proactiveEnabled: false, quietStart: "22:00", quietEnd: "08:00", timeZone: "Not/A_Time_Zone", maxPerDay: 1 },
    });
    assert.equal(policy.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("CORS preflight allows only configured origins and admin headers", async () => {
  const app = await createAdminApplication({
    database,
    adminToken: token,
    corsOrigins: ["https://admin.example"],
  });
  try {
    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/admin/people",
      headers: {
        origin: "https://admin.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    assert.equal(allowed.statusCode, 204);
    assert.equal(
      allowed.headers["access-control-allow-origin"],
      "https://admin.example",
    );
    assert.match(allowed.headers["access-control-allow-methods"] ?? "", /GET/);
    assert.match(
      allowed.headers["access-control-allow-headers"] ?? "",
      /authorization/i,
    );

    const denied = await app.inject({
      method: "OPTIONS",
      url: "/admin/people",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    assert.equal(denied.headers["access-control-allow-origin"], undefined);
  } finally {
    await app.close();
  }
});
