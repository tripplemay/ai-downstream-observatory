import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { before, test } from "node:test";
import { getIronSession, sealData, unsealData } from "iron-session";
import { AuthError, getAuthConfig, hashPassword, LOGIN_ATTEMPTS, LOGIN_WINDOW_MS, readLoginForm, requireSameOrigin, SESSION_TTL_SECONDS, verifyPassword } from "../src/server/auth/core";
import { AuthStore } from "../src/server/auth/store";

const syntheticPassword = randomBytes(24).toString("base64url");
let passwordHash: string;
const env = {
  WORKBENCH_PASSWORD_HASH: "",
  WORKBENCH_SESSION_SECRET: randomBytes(48).toString("base64url"),
  WORKBENCH_ORIGIN: "https://workbench.example.test",
  WORKBENCH_DATA_DIR: path.join(tmpdir(), "workbench-test-unused"),
  NODE_ENV: "production" as const,
};

before(async () => { passwordHash = await hashPassword(syntheticPassword); env.WORKBENCH_PASSWORD_HASH = passwordHash; });

test("E-23: missing or insecure production auth config fails closed", () => {
  for (const key of Object.keys(env).filter((key) => key !== "NODE_ENV")) {
    assert.throws(() => getAuthConfig({ ...env, [key]: "" }), /AUTH_NOT_CONFIGURED/);
  }
  for (const origin of ["http://workbench.example.test", "http://localhost:3000", "https://workbench.example.test/path", "https://user:pass@workbench.example.test"]) {
    assert.throws(() => getAuthConfig({ ...env, WORKBENCH_ORIGIN: origin }), /AUTH_NOT_CONFIGURED/);
  }
  assert.equal(getAuthConfig(env).secure, true);
  assert.equal(getAuthConfig({ ...env, NODE_ENV: "development", WORKBENCH_ORIGIN: "http://127.0.0.1:3000" }).secure, false);
});

test("E-23: scrypt verifies exact password, rejects malformed hashes and oversized inputs", async () => {
  assert.equal(await verifyPassword(syntheticPassword, passwordHash), true);
  assert.equal(await verifyPassword(`${syntheticPassword}!`, passwordHash), false);
  assert.equal(await verifyPassword(syntheticPassword, "bad"), false);
  assert.equal(await verifyPassword("x".repeat(1025), passwordHash), false);
  await assert.rejects(hashPassword("too-short"), /PASSWORD_LENGTH/);
});

test("E-23: strict Origin rejects missing, cross-site and spoofed proxy headers", () => {
  const config = getAuthConfig(env);
  assert.doesNotThrow(() => requireSameOrigin(new Headers({ origin: config.origin }), config));
  for (const headers of [new Headers(), new Headers({ origin: "https://evil.test" }),
    new Headers({ origin: config.origin, "sec-fetch-site": "cross-site" }),
    new Headers({ "x-forwarded-host": "workbench.example.test", host: "workbench.example.test" })]) {
    assert.throws(() => requireSameOrigin(headers, config), /INVALID_ORIGIN/);
  }
});

test("E-23: opaque server sessions survive restart, expire, revoke and reject configuration rotation", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "workbench-auth-"));
  let store = new AuthStore(dir);
  try {
    const config = getAuthConfig(env);
    const issued = store.issue(config, 1000);
    assert.equal(store.valid(issued.sid, config, 1001), true);
    assert.equal(store.valid("x", config, 1001), false);
    store.close();
    store = new AuthStore(dir);
    assert.equal(store.valid(issued.sid, config, 1002), true);
    assert.equal(store.valid(issued.sid, { version: "rotated" }, 1002), false);
    assert.equal(store.valid(issued.sid, config, 1000 + SESSION_TTL_SECONDS * 1000), false);
    store.revoke(issued.sid, 1003);
    assert.equal(store.valid(issued.sid, config, 1004), false);
    const row = store.db.prepare("SELECT token_hash FROM sessions LIMIT 1").get() as { token_hash: string };
    assert.notEqual(row.token_hash, issued.sid);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("E-23: login rate limit is persistent and atomic across connections", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "workbench-auth-limit-"));
  const a = new AuthStore(dir);
  const b = new AuthStore(dir);
  try {
    for (let i = 0; i < LOGIN_ATTEMPTS; i++) assert.equal((i % 2 ? a : b).consumeLoginAttempt(1000 + i).allowed, true);
    assert.equal(a.consumeLoginAttempt(1100).allowed, false);
    assert.equal(b.consumeLoginAttempt(1100).retryAfter, 900);
    assert.equal(a.consumeLoginAttempt(1000 + LOGIN_WINDOW_MS).allowed, true);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("E-23: iron-session rejects altered sealed payloads and sets secure cookie attributes", async () => {
  const token = randomBytes(32).toString("base64url");
  const options = { password: env.WORKBENCH_SESSION_SECRET, ttl: 3600 };
  const sealed = await sealData({ sid: token }, options);
  assert.equal((await unsealData<{ sid?: string }>(sealed, options)).sid, token);
  const tampered = `${sealed.slice(0, 40)}X${sealed.slice(41)}`;
  assert.equal((await unsealData<{ sid?: string }>(tampered, options)).sid, undefined);
  const writes: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
  const jar = { get: () => undefined, set: (name: string, value: string, options: Record<string, unknown>) => { writes.push({ name, value, options }); } };
  const session = await getIronSession<{ sid?: string }>(jar, {
    ...options, cookieName: "__Host-workbench-session",
    cookieOptions: { secure: true, httpOnly: true, sameSite: "strict", path: "/" },
  });
  session.sid = token;
  await session.save();
  assert.equal(writes[0].options.secure, true);
  assert.equal(writes[0].options.httpOnly, true);
  assert.equal(writes[0].options.sameSite, "strict");
  assert.equal(writes[0].options.path, "/");
  assert.equal(writes[0].options.domain, undefined);
  session.destroy();
  assert.equal(writes.at(-1)?.options.maxAge, 0);
});

test("E-24: login input is bounded even without Content-Length", async () => {
  const request = (body: string, contentType = "application/x-www-form-urlencoded") => new Request("https://workbench.example.test/api/auth/login", {
    method: "POST", headers: { "Content-Type": contentType }, body,
  });
  assert.equal((await readLoginForm(request("password=example"))).get("password"), "example");
  await assert.rejects(readLoginForm(request("password=" + "x".repeat(4096))), (error: unknown) => error instanceof AuthError && error.status === 413);
  await assert.rejects(readLoginForm(request("{}", "application/json")), /UNSUPPORTED_MEDIA_TYPE/);
});

test("E-23: every legacy public DAL export and Server Action is guarded", () => {
  const raw = readFileSync(new URL("../src/lib/legacy-queries.ts", import.meta.url), "utf8");
  const facade = readFileSync(new URL("../src/lib/queries.ts", import.meta.url), "utf8");
  for (const match of raw.matchAll(/export function (\w+)\(/g)) {
    assert.ok(facade.includes(`export const ${match[1]} = authorized(legacy.${match[1]})`), match[1]);
  }
  assert.match(facade, /await requireSession\(\);\s+return query/);
  const actions = readFileSync(new URL("../src/lib/actions.ts", import.meta.url), "utf8");
  const declarations = [...actions.matchAll(/export async function [^\n]+\{\n([^\n]+)/g)];
  assert.equal(declarations.length, 7);
  for (const action of declarations) assert.equal(action[1].trim(), "await requireMutationSession();");
});
