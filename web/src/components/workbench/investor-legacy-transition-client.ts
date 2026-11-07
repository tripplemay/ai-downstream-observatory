import { parseStrictJson } from "@/server/strict-json";
import { legacyTransitionAcknowledgements, legacyTransitionInputSchema, legacyTransitionResponseSchema,
  type LegacyTransitionResponse } from "@/server/investor/legacy-transition-schemas";

export type LegacyTransitionAttempt = { body: string; nonce: string; binding: string; workspace: string; intent: unknown };
function check(value: unknown, code = "LEGACY_TRANSITION_RESPONSE_INVALID"): asserts value { if (!value) throw new Error(code); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function digest(value: unknown) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function legacyTransitionAttempt(intent: unknown, binding: string, workspace: string): LegacyTransitionAttempt {
  const value = legacyTransitionInputSchema.parse(intent);
  return { body: JSON.stringify(value), nonce: value.kind === "preview" ? value.idempotency_key : value.body.idempotency_key, binding, workspace, intent: value };
}
export function buildLegacyTransitionConfirmation(response: LegacyTransitionResponse, acknowledgements: Record<string, boolean>, nonce: string, now = Date.now()) {
  const view = response.view; check(view && !response.read_only && response.preview_error === null, "LEGACY_TRANSITION_VIEW_UNAVAILABLE");
  check(now < Date.parse(response.refresh_after) && now < Date.parse(view.refresh_after) && now < Date.parse(view.preview.valid_until), "LEGACY_TRANSITION_VIEW_STALE");
  check(legacyTransitionAcknowledgements.every(key => acknowledgements[key] === true), "LEGACY_TRANSITION_ACK_REQUIRED");
  check(response.request?.status === "preview_ready" && response.request.resource_id === view.preview.preview_id && response.request.resource_hash,
    "LEGACY_TRANSITION_VIEW_UNAVAILABLE");
  // The response parser has already hashed the complete witness with WebCrypto.
  return legacyTransitionInputSchema.parse({ kind: "confirmation", body: { schema_version: "investor-legacy-transition-submit-v1",
    preview_id: view.preview.preview_id, expected_preview_hash: response.request.resource_hash, expected_revision: view.preview.workspace_revision,
    idempotency_key: nonce, acknowledgements: Object.fromEntries(legacyTransitionAcknowledgements.map(key => [key, true])) } });
}
export async function parseLegacyTransitionResponse(raw: unknown, binding: string, workspace: string, now = Date.now(), attempt?: LegacyTransitionAttempt): Promise<LegacyTransitionResponse> {
  const value = legacyTransitionResponseSchema.parse(raw);
  check(value.session_binding === binding && value.workspace_id === workspace);
  check(Date.parse(value.checked_at) <= now + 30000 && Date.parse(value.refresh_after) > now
    && Date.parse(value.refresh_after) > Date.parse(value.checked_at) && Date.parse(value.refresh_after) - Date.parse(value.checked_at) <= 15000,
  "LEGACY_TRANSITION_RESPONSE_STALE");
  if (attempt) {
    check(attempt.binding === binding && attempt.workspace === workspace && value.lookup_nonce === attempt.nonce);
    if (value.request) check(value.request.intent_hash === await digest(attempt.intent));
  }
  if (value.view) {
    const view = value.view, request = value.request;
    check(request?.status === "preview_ready" && request.kind === "preview" && request.resource_id === view.preview.preview_id
      && request.model_id === view.preview.model_id && view.preview.workspace_id === workspace && view.preview.workspace_revision === value.workspace_revision
      && value.model?.id === view.preview.model_id && value.model.requires_transition && value.preview_error === null);
    check(request.resource_hash === await digest(view.preview) && request.resource_valid_until === view.preview.valid_until);
    check(Date.parse(view.refresh_after) > now && Date.parse(view.preview.valid_until) > now
      && Date.parse(view.checked_at) <= Date.parse(value.checked_at) && Date.parse(view.refresh_after) <= Date.parse(view.preview.valid_until));
  }
  return value;
}
export async function readLegacyTransitionJson(response: Response) {
  check(response.body); const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true }); let size = 0, raw = "";
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > 65536) { void reader.cancel().catch(() => {}); throw new Error("LEGACY_TRANSITION_RESPONSE_INVALID"); }
      raw += decoder.decode(value, { stream: true });
    }
    return parseStrictJson(raw + decoder.decode());
  } finally { reader.releaseLock(); }
}
export function legacyTransitionErrorText(error: unknown) {
  const code = error && typeof error === "object" && "message" in error ? String(error.message) : "";
  const messages: Record<string, string> = {
    LEGACY_TRANSITION_ACK_REQUIRED: "请逐项核对兼容规则后再确认。",
    LEGACY_TRANSITION_VIEW_STALE: "预览已到复核时间，请先核对状态；刷新不会延长原确认期限。",
    LEGACY_TRANSITION_JOB_VERSION_CHANGED: "工作区已变化，请重新准备并核对预览。不会沿用原确认。",
    LEGACY_TRANSITION_JOB_BUSY: "已有兼容任务正在处理，请先核对受理状态。",
    LEGACY_TRANSITION_JOB_PREVIEW_EXPIRED: "原确认期限已到，请重新准备预览。",
    LEGACY_TRANSITION_JOB_ALREADY_CONFIRMED: "该方案已经登记兼容确认，请读取原登记状态。",
    WORKBENCH_READ_ONLY: "系统当前只读，不能登记兼容确认。",
  };
  return messages[code] ?? "未能核对最新状态，已隐藏旧预览。连接失败不等于未受理，请先核对原请求状态。";
}
