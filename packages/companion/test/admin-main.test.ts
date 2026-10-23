import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { requireCompatDatabaseUrl } from "./helpers.js";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("unable to reserve port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

test("built ESM admin entry starts without migrations and exits cleanly on SIGTERM", async () => {
  const port = await availablePort();
  const token = "built-entry-admin-token-with-at-least-thirty-two-bytes";
  const child = spawn(process.execPath, ["dist/main.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      COMPANION_DATABASE_URL: requireCompatDatabaseUrl(),
      COMPANION_ADMIN_TOKEN: token,
      COMPANION_ADMIN_HOST: "127.0.0.1",
      COMPANION_ADMIN_PORT: String(port),
      COMPANION_ADMIN_CORS_ORIGINS: "",
    },
    stdio: "ignore",
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  try {
    let health: Response | undefined;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !exited) {
      try {
        health = await fetch(`http://127.0.0.1:${port}/health`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(health, "admin entry did not begin listening");
    assert.equal(health.status, 200);
    assert.equal(
      ((await health.json()) as { databaseReady: boolean }).databaseReady,
      true,
    );
    child.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("admin entry did not stop after SIGTERM")),
        5000,
      );
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0);
  } finally {
    if (!exited) child.kill("SIGKILL");
  }
});

test("built entry prints only a stable code for invalid startup configuration", async () => {
  const child = spawn(process.execPath, ["dist/main.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      COMPANION_DATABASE_URL: requireCompatDatabaseUrl(),
      COMPANION_ADMIN_TOKEN:
        "built-entry-admin-token-with-at-least-thirty-two-bytes",
      COMPANION_ADMIN_HOST: "127.0.0.1",
      COMPANION_ADMIN_PORT: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 1);
  assert.equal(stderr, "COMPANION_ADMIN_PORT_INVALID\n");
});
