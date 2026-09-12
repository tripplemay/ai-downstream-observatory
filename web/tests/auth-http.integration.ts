import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../src/server/auth/core";
import { AuthStore } from "../src/server/auth/store";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function run() {
  if (!existsSync(".next/BUILD_ID")) throw new Error("Run npm run build before test:auth:http.");
  const directory = mkdtempSync(path.join(tmpdir(), "workbench-auth-http-"));
  let server: ChildProcess | undefined;
  let logs = "";
  const password = randomBytes(24).toString("base64url");
  const encoded = await hashPassword(password);
  const port = await freePort();
  const address = `http://127.0.0.1:${port}`;
  const canonicalOrigin = `https://workbench.example.test`;
  const legacyFile = path.join(directory, "must-not-open-unauthenticated.db");
  const authDirectory = path.join(directory, "configured");
  const request = (url: string, init: RequestInit = {}) => fetch(address + url, { ...init, redirect: "manual" });
  async function start(configured: boolean) {
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      env: {
        ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", DB_PATH: legacyFile,
        WORKBENCH_DB_PATH: path.join(directory, "must-not-open-workbench.db"),
        WORKBENCH_DATA_DIR: configured ? authDirectory : "",
        WORKBENCH_PASSWORD_HASH: configured ? encoded : "",
        WORKBENCH_SESSION_SECRET: configured ? randomBytes(48).toString("base64url") : "",
        WORKBENCH_ORIGIN: configured ? canonicalOrigin : "",
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (chunk) => { logs = (logs + chunk).slice(-16000); });
    server.stderr?.on("data", (chunk) => { logs = (logs + chunk).slice(-16000); });
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`Server exited early: ${logs}`);
      try { if ((await request("/api/health")).ok) return; } catch { /* Await the child listener. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Server did not become ready: ${logs}`);
  }
  async function stop() {
    if (!server || server.exitCode !== null) return;
    const child = server;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
    server = undefined;
  }
  try {
    await start(false);
    assert.match(await (await request("/login")).text(), /认证尚未配置/);
    assert.equal((await request("/ai-downstream")).headers.get("location"), "/login");
    assert.equal((await request("/api/auth/login", { method: "POST" })).status, 503);
    assert.equal(existsSync(legacyFile), false);
    await stop();
    await start(true);
    for (const url of ["/", "/ai-downstream", "/ai-downstream/reports", "/ai-downstream/pool"]) {
      const response = await request(url, { headers: { "x-middleware-subrequest": "middleware:middleware:middleware:middleware:middleware" } });
      assert.equal(response.headers.get("location"), "/login", url);
      assert.equal(response.status, 307, url);
    }
    assert.equal(existsSync(legacyFile), false);
    const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")) as {
      node: Record<string, { exportedName?: string }>;
    };
    const actionId = Object.entries(manifest.node).find(([, entry]) => entry.exportedName === "addPoolItem")?.[0];
    assert.ok(actionId, "The protected action must actually exist in this build.");
    const action = await request("/ai-downstream/pool", {
      method: "POST", headers: {
        "Next-Action": actionId, "Content-Type": "text/plain;charset=UTF-8", Origin: canonicalOrigin,
        "x-forwarded-host": new URL(canonicalOrigin).host,
      }, body: JSON.stringify([{ themeId: "ai-downstream", name: "Unauthorized fixture must not persist" }]),
    });
    assert.equal(action.status, 500);
    await action.text();
    assert.match(logs, /UNAUTHENTICATED/);
    assert.equal(existsSync(legacyFile), false);
    const login = (supplied: string, origin = canonicalOrigin) => request("/api/auth/login", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: supplied }).toString(),
    });
    assert.equal((await login(password, "https://evil.example.test")).status, 403);
    assert.equal((await login("wrong-password")).headers.get("location"), `${canonicalOrigin}/login?error=invalid`);
    const signedIn = await login(password);
    assert.equal(signedIn.status, 303);
    const setCookie = signedIn.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookie = setCookie.split(";")[0];
    assert.equal((await request("/login", { headers: { Cookie: cookie } })).headers.get("location"), "/");
    assert.equal((await request("/api/auth/logout", { method: "POST", headers: { Cookie: cookie, Origin: "https://evil.example.test" } })).status, 403);
    assert.equal((await request("/api/auth/logout", { method: "POST", headers: { Cookie: cookie, Origin: canonicalOrigin } })).status, 303);
    assert.equal((await request("/ai-downstream", { headers: { Cookie: cookie } })).headers.get("location"), "/login");
    const second = await login(password);
    const secondCookie = (second.headers.get("set-cookie") ?? "").split(";")[0];
    const store = new AuthStore(authDirectory);
    store.db.prepare("UPDATE sessions SET expires_at=0").run();
    store.close();
    assert.equal((await request("/ai-downstream", { headers: { Cookie: secondCookie } })).headers.get("location"), "/login");
    assert.equal(existsSync(legacyFile), false);
    assert.equal(existsSync(path.join(directory, "must-not-open-workbench.db")), false);
    process.stdout.write("PASS auth HTTP: fail-closed config, private reads, direct action denial, Origin, login, secure cookie, persistent logout and expiry; no financial DB accessed.\n");
  } finally {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
