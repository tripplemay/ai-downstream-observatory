import { correctionConsentAcknowledgements, correctionConsentResponseSchema, correctionConsentSubmitSchema,
  type CorrectionConsentResponse, type CorrectionConsentSubmit } from "@/server/investor/correction-consent-schemas";

export type ConsentScope = { workspace: string; binding: string; model: string; impact: string | null };
export type ConsentAttempt = { intent: CorrectionConsentSubmit; body: string; nonce: string };
export const consentLabels: Record<typeof correctionConsentAcknowledgements[number], string> = {
  exact_stored_impact_seen: "我已查看上方确切的历史差额比较。",
  explicit_historical_restatement: "我明确同意登记本次历史经济更正，不只是计算假设影响。",
  selected_report_differences_accepted: "我接受所选两源报告差异及逐日处理；这不保证客观没有其他事件。",
  tax_and_instants_are_research_assumptions: "税额、有效和支付时刻仍是我明确选择的研究假设。",
  preserve_original_history_and_strategy: "保留原观察、模型起点、历史策略决定和金融事实，不改写原收益。",
  new_epoch_not_current_nav: "本次只登记独立更正基线，不是当前净值或已经恢复监测。",
  separate_current_readmission_no_trading: "后续仍须重新核验当前资料；不改变策略、资金、维护或交易权限。",
};
function check(value: unknown, code = "CORRECTION_CONSENT_RESPONSE_INVALID"): asserts value { if (!value) throw new Error(code); }
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object"
  ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
async function digest(value: unknown) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value))))].map(x => x.toString(16).padStart(2, "0")).join(""); }
export function buildConsentAttempt(value: CorrectionConsentResponse, scope: ConsentScope, summaryHash: string | null,
  answers: Partial<Record<typeof correctionConsentAcknowledgements[number], boolean>>, nonce: string, now = Date.now()): ConsentAttempt {
  const c = value.candidate;
  check(value.workspace_id === scope.workspace && value.session_binding === scope.binding && !value.read_only && !value.request
    && c && c.model_id === scope.model && c.impact_request_id === scope.impact && c.summary_hash === summaryHash
    && c.workspace_revision === value.workspace_revision && c.all_differences_resolved, "CORRECTION_CONSENT_COMPARISON_REQUIRED");
  check(now < Math.min(Date.parse(value.refresh_after), Date.parse(c.valid_until)), "CORRECTION_CONSENT_EXPIRED");
  check(correctionConsentAcknowledgements.every(key => answers[key] === true), "CORRECTION_CONSENT_ACK_REQUIRED");
  const intent = correctionConsentSubmitSchema.parse({ schema_version: "investor-correction-consent-submit-v1", impact_request_id: c.impact_request_id,
    expected_result_hash: c.impact_result_hash, expected_revision: c.workspace_revision, idempotency_key: nonce, acknowledgements: answers });
  return { intent, body: JSON.stringify(intent), nonce };
}
export async function parseConsentResponse(raw: unknown, scope: ConsentScope, attempt?: ConsentAttempt, now = Date.now()): Promise<CorrectionConsentResponse> {
  const value = correctionConsentResponseSchema.parse(raw);
  check(value.workspace_id === scope.workspace && value.session_binding === scope.binding && Date.parse(value.checked_at) <= now + 30000
    && Date.parse(value.refresh_after) > now);
  if (attempt) check(value.lookup_nonce === attempt.nonce);
  if (value.candidate) check(!value.request && !value.receipt && value.candidate.model_id === scope.model && value.candidate.impact_request_id === scope.impact
    && value.candidate.workspace_revision === value.workspace_revision && Date.parse(value.candidate.valid_until) > now);
  if (value.request) {
    check(value.request.model_id === scope.model && (!scope.impact || value.request.impact_request_id === scope.impact));
    if (attempt) check(value.request.intent_hash === await digest(attempt.intent) && value.request.impact_request_id === attempt.intent.impact_request_id);
    check((value.request.status === "confirmed") === !!value.receipt);
  } else check(!value.receipt);
  if (value.receipt) check(value.receipt.workspace_id === scope.workspace && value.receipt.model_id === scope.model
    && value.receipt.request_id === value.request!.id && value.receipt.impact_request_id === value.request!.impact_request_id
    && (!attempt || value.receipt.impact_result_hash === attempt.intent.expected_result_hash));
  return value;
}
export function consentErrorText(error: unknown) {
  const code = error && typeof error === "object" && "message" in error ? String(error.message) : "";
  const messages: Record<string, string> = {
    CORRECTION_CONSENT_ACK_REQUIRED: "请逐项确认本次正式更正与保留边界；不自动沿用假设比较的同意。",
    CORRECTION_CONSENT_COMPARISON_REQUIRED: "请先查看当前合格的确切差额比较，并解决每一项历史差异。",
    CORRECTION_CONSENT_EXPIRED: "本次比较或核验期限已到，已停止确认。请先核对原登记状态，再重新准备资料。",
    CORRECTION_CONSENT_CHANGED: "来源、原比较或模型已有变化。不能沿用本次确认，请重新核对资料。",
    CORRECTION_CONSENT_VERSION_CHANGED: "工作区版本已变化。请重新核对资料，不会自动套用旧确认。",
    CORRECTION_CONSENT_UNRESOLVED: "仍有暂按原记录保留的差异，只能比较，不能登记为已解决的更正。",
    CORRECTION_CONSENT_BUSY: "已有更正确认请求，先核对原受理状态。",
    CORRECTION_CONSENT_SOURCE_UNAVAILABLE: "原件、身份、许可或完整原链未通过核验，本次未登记更正基线。请处理资料缺口后重新准备比较，不会跳过缺口或恢复监测。",
    WORKBENCH_READ_ONLY: "系统当前只读，只能核对历史登记。",
  };
  return messages[code] ?? "未能核实本次登记。连接失败不代表未受理；请先核对原请求，不会自动重发或恢复监测。";
}
