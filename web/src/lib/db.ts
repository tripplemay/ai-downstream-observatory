/** better-sqlite3 单例连接（WAL 模式），直连 ../data/observatory.db。
 * 首次连接时建表并按 db.py 逻辑灌种子（仅 themes 为空时）。 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SCHEMA, seedIfEmpty } from "./seed";

const DB_PATH =
  process.env.DB_PATH ?? path.resolve(process.cwd(), "..", "data", "observatory.db");

declare global {
  // eslint-disable-next-line no-var
  var __obsDb: Database.Database | undefined;
}

export function getDb(): Database.Database {
  if (!globalThis.__obsDb) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    seedIfEmpty(db);
    globalThis.__obsDb = db;
  }
  return globalThis.__obsDb;
}

export function nowStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function todayStr(): string {
  return nowStr().slice(0, 10);
}
