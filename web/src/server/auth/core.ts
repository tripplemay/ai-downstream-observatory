import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import path from "node:path";

export const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_ATTEMPTS = 10;
const HASH_PATTERN = /^scrypt\$32768\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

export type AuthConfig = {
  passwordHash: string;
  secret: string;
  origin: string;
  dataDir: string;
  secure: boolean;
  version: string;
};

export class AuthError extends Error {
  constructor(public code: string, public status = 401) {
    super(code);
  }
}

export function getAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const passwordHash = env.WORKBENCH_PASSWORD_HASH ?? "";
  const secret = env.WORKBENCH_SESSION_SECRET ?? "";
  const dataDir = env.WORKBENCH_DATA_DIR ?? "";
  let url: URL;
  try {
    url = new URL(env.WORKBENCH_ORIGIN ?? "");
  } catch {
    throw new AuthError("AUTH_NOT_CONFIGURED", 503);
  }
  const secure = url.protocol === "https:";
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!HASH_PATTERN.test(passwordHash) || secret.length < 32 || !path.isAbsolute(dataDir)
    || (!secure && !(env.NODE_ENV !== "production" && localHttp))
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new AuthError("AUTH_NOT_CONFIGURED", 503);
  }
  return {
    passwordHash, secret, origin: url.origin, dataDir, secure,
    version: createHash("sha256").update(`${passwordHash}\0${secret}\0${url.origin}`).digest("hex"),
  };
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => {
      if (error) reject(error); else resolve(result);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 16 || Buffer.byteLength(password) > 1024) throw new AuthError("PASSWORD_LENGTH", 400);
  const salt = randomBytes(16);
  const digest = await derive(password, salt);
  return `scrypt$32768$8$1$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const match = HASH_PATTERN.exec(encoded);
  if (!match || !password || Buffer.byteLength(password) > 1024) return false;
  const actual = await derive(password, Buffer.from(match[1], "base64url"));
  return timingSafeEqual(actual, Buffer.from(match[2], "base64url"));
}

export function requireSameOrigin(headers: Pick<Headers, "get">, config: AuthConfig): void {
  if (headers.get("origin") !== config.origin || headers.get("sec-fetch-site") === "cross-site") {
    throw new AuthError("INVALID_ORIGIN", 403);
  }
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function readLoginForm(request: Request): Promise<URLSearchParams> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    throw new AuthError("UNSUPPORTED_MEDIA_TYPE", 415);
  }
  const limit = 4096;
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > limit) throw new AuthError("BODY_TOO_LARGE", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError("EMPTY_BODY", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new AuthError("BODY_TOO_LARGE", 413);
    }
    chunks.push(value);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
