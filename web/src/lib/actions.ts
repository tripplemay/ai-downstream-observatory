"use server";

import { revalidatePath } from "next/cache";
import { getDb, nowStr, todayStr } from "./db";
import { validStatuses } from "./seed";
import {
  observationSchema,
  poolItemSchema,
  signalUpdateSchema,
  thesisSchema,
  type ObservationInput,
  type PoolItemInput,
  type SignalUpdateInput,
  type ThesisInput,
} from "./schemas";
import type { Signal } from "./queries";

export type ActionResult = { ok: boolean; message: string };

/** 更新信号：写 signals + signal_history（单事务），逻辑对齐 Flask /signals/<sid>/update */
export async function updateSignal(input: SignalUpdateInput): Promise<ActionResult> {
  const parsed = signalUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "参数非法" };
  }
  const db = getDb();
  const old = db.prepare("SELECT * FROM signals WHERE id = ?").get(parsed.data.id) as
    | Signal
    | undefined;
  if (!old) return { ok: false, message: "信号不存在" };
  const valid = validStatuses(old.layer);
  const status = valid.includes(parsed.data.status) ? parsed.data.status : old.status;
  const ts = nowStr();
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE signals SET status = ?, current_value = ?, note = ?, updated_at = ? WHERE id = ?"
    ).run(status, parsed.data.current_value, parsed.data.note, ts, old.id);
    db.prepare(
      "INSERT INTO signal_history (signal_id, old_status, new_status, old_value, new_value, note, changed_at)" +
        " VALUES (?,?,?,?,?,?,?)"
    ).run(old.id, old.status, status, old.current_value, parsed.data.current_value, parsed.data.note, ts);
  });
  tx();
  revalidatePath("/signals");
  revalidatePath("/");
  return { ok: true, message: `信号 ${old.id} 已更新` };
}

/** 新增观测：快照自动取当前 signals（对齐 Flask /observations/add） */
export async function addObservation(input: ObservationInput): Promise<ActionResult> {
  const parsed = observationSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "参数非法" };
  }
  const db = getDb();
  const rows = db.prepare("SELECT id, current_value FROM signals ORDER BY rowid").all() as Array<{
    id: string;
    current_value: string;
  }>;
  const snapshot: Record<string, string> = {};
  for (const r of rows) snapshot[r.id] = r.current_value;
  db.prepare(
    "INSERT INTO observations (date, light, snapshot, note, created_at) VALUES (?,?,?,?,?)"
  ).run(
    parsed.data.date || todayStr(),
    parsed.data.light,
    JSON.stringify(snapshot),
    parsed.data.note,
    nowStr()
  );
  revalidatePath("/observations");
  revalidatePath("/");
  return { ok: true, message: "观测记录已保存" };
}

/** 保存判断与规则（对齐 Flask /thesis POST） */
export async function saveThesis(input: ThesisInput): Promise<ActionResult> {
  const parsed = thesisSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "内容过长或非法" };
  const db = getDb();
  const upsert = db.prepare(
    "INSERT INTO pages (key, content) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET content = excluded.content"
  );
  const tx = db.transaction(() => {
    upsert.run("thesis", parsed.data.thesis);
    upsert.run("rules", parsed.data.rules);
  });
  tx();
  revalidatePath("/thesis");
  return { ok: true, message: "已保存" };
}

export async function addPoolItem(input: PoolItemInput): Promise<ActionResult> {
  const parsed = poolItemSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "参数非法" };
  }
  getDb()
    .prepare("INSERT INTO pool (name, code, channel, position, note) VALUES (?,?,?,?,?)")
    .run(parsed.data.name, parsed.data.code, parsed.data.channel, parsed.data.position, parsed.data.note);
  revalidatePath("/pool");
  return { ok: true, message: "已添加标的" };
}

export async function updatePoolItem(input: PoolItemInput): Promise<ActionResult> {
  const parsed = poolItemSchema.safeParse(input);
  if (!parsed.success || !parsed.data.id) {
    return { ok: false, message: parsed.success ? "缺少 id" : parsed.error.issues[0]?.message ?? "参数非法" };
  }
  getDb()
    .prepare("UPDATE pool SET name = ?, code = ?, channel = ?, position = ?, note = ? WHERE id = ?")
    .run(parsed.data.name, parsed.data.code, parsed.data.channel, parsed.data.position, parsed.data.note, parsed.data.id);
  revalidatePath("/pool");
  return { ok: true, message: "已保存修改" };
}

export async function deletePoolItem(id: number): Promise<ActionResult> {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, message: "id 非法" };
  getDb().prepare("DELETE FROM pool WHERE id = ?").run(id);
  revalidatePath("/pool");
  return { ok: true, message: "已删除" };
}
