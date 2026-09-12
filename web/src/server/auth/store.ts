import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { LOGIN_ATTEMPTS, LOGIN_WINDOW_MS, SESSION_TTL_SECONDS, tokenHash, type AuthConfig } from "./core";

export class AuthStore {
  readonly db: Database.Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, "auth.sqlite");
    this.db = new Database(file);
    chmodSync(file, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, config_version TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS login_limits (
        scope TEXT PRIMARY KEY, window_started INTEGER NOT NULL, attempts INTEGER NOT NULL
      );
    `);
  }

  consumeLoginAttempt(now = Date.now()): { allowed: boolean; retryAfter: number } {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM login_limits WHERE scope = 'owner'").get() as
        { window_started: number; attempts: number } | undefined;
      if (!row || now - row.window_started >= LOGIN_WINDOW_MS) {
        this.db.prepare("INSERT INTO login_limits VALUES ('owner', ?, 1) ON CONFLICT(scope) DO UPDATE SET window_started=excluded.window_started, attempts=1").run(now);
        return { allowed: true, retryAfter: 0 };
      }
      if (row.attempts >= LOGIN_ATTEMPTS) {
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((row.window_started + LOGIN_WINDOW_MS - now) / 1000)) };
      }
      this.db.prepare("UPDATE login_limits SET attempts = attempts + 1 WHERE scope = 'owner'").run();
      return { allowed: true, retryAfter: 0 };
    }).immediate();
  }

  issue(config: Pick<AuthConfig, "version">, now = Date.now()): { sid: string; expiresAt: number } {
    const sid = randomBytes(32).toString("base64url");
    const expiresAt = now + SESSION_TTL_SECONDS * 1000;
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").run(now);
      this.db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, NULL)").run(tokenHash(sid), config.version, now, expiresAt);
    }).immediate();
    return { sid, expiresAt };
  }

  valid(sid: unknown, config: Pick<AuthConfig, "version">, now = Date.now()): boolean {
    if (typeof sid !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(sid)) return false;
    return Boolean(this.db.prepare("SELECT 1 FROM sessions WHERE token_hash=? AND config_version=? AND expires_at>? AND revoked_at IS NULL")
      .get(tokenHash(sid), config.version, now));
  }

  revoke(sid: string, now = Date.now()): void {
    this.db.prepare("UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL").run(now, tokenHash(sid));
  }

  close(): void { this.db.close(); }
}

export function withAuthStore<T>(config: AuthConfig, operation: (store: AuthStore) => T): T {
  const store = new AuthStore(config.dataDir);
  try { return operation(store); } finally { store.close(); }
}
