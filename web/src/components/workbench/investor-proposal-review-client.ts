import { z } from "zod";
import { proposalReviewBasis, proposalReviewContextSchema, proposalReviewIntentSchema, type ProposalReviewContext, type ProposalReviewIntent } from "@/server/investor/proposal-review-schemas";
import type { ValuationScope } from "./investor-valuation-client";

const response = proposalReviewContextSchema.innerType().extend({ session_binding: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export function parseProposalReview(value: unknown, expected: ValuationScope, proposalId: string | null) {
  const { session_binding, ...body } = response.parse(value), context = proposalReviewContextSchema.parse(body);
  if (session_binding !== expected.binding || context.workspace_id !== expected.workspace || context.workspace_revision !== expected.revision
    || context.portfolio_id !== expected.portfolio || context.ledger_revision !== expected.ledgerRevision || context.link_id !== expected.linkId
    || context.link_version !== expected.linkVersion || context.selected?.id !== (proposalId ?? undefined)) throw new Error("INVESTOR_PROPOSAL_RESPONSE_INVALID");
  return context;
}
export function buildProposalReview(context: ProposalReviewContext, operation: string, note: string, acknowledged: boolean, now: number) {
  proposalReviewContextSchema.parse(context);
  const selected = context.selected;
  if (!selected || context.read_only || !selected.allowed_operations.includes(operation as ProposalReviewIntent["operation"])
    || !Number.isFinite(now) || Date.parse(selected.expires_at) <= now && !["cancel_remainder", "expire"].includes(operation)) throw new Error("INVESTOR_PROPOSAL_DRAFT_INVALID");
  return proposalReviewIntentSchema.parse({ action: "review_linked_proposal", portfolio_id: context.portfolio_id, proposal_id: selected.id,
    expected_ledger_revision: context.ledger_revision, expected_link_id: context.link_id, expected_link_version: context.link_version,
    expected_context_hash: context.context_hash, operation, note, acknowledgement: acknowledged, basis: proposalReviewBasis });
}
export const proposalOperationLabels = { risk_check: "记录一次风控复核", approve: "批准此清单并预占", prepare: "执行前再次复核",
  cancel_remainder: "终止清单并释放剩余预占", expire: "登记到期并释放剩余预占" };
export const proposalConsequences = {
  risk_check: "只保存风控结果，不批准、不预占，也不发订单。",
  approve: "提交时重验完整清单；通过后登记人工批准并预占相应现金或证券。预占不是成交，也不改变实际资产。",
  prepare: "提交时再次检查原批准、账本、行情、权限与剩余预占；复核通过仍需你自行决定并在券商操作。",
  cancel_remainder: "仅终止本工作台清单并释放尚未成交的预占，不会向券商撤单。请自行核对券商端未决订单；已发生成交仍须如实回录。",
  expire: "仅登记本工作台清单已到期并释放剩余预占，不撤销成交或券商订单。",
};
export function proposalRiskMessage(code: string) {
  const messages: Record<string, string> = {
    DETERMINISTIC_RISK_PASS: "确定性风控在本次核对时通过。",
    G_01_POLICY: "政策范围已核对。", G_02_ACCOUNTS: "账户范围已核对。",
    G_03_INPUTS: "工程和数据输入已核对。", G_04_STRATEGY: "策略准入已核对。",
    PROPOSAL_EXPIRED: "清单已到期，不能继续批准或准备执行。",
    PROPOSAL_LEDGER_CHANGED: "账本事实已经变化，需要基于新事实重新形成清单。",
    PROPOSAL_MARKET_CHANGED: "行情发布版本已经变化，不能沿用这张旧清单。",
    RUNTIME_RELEASE_MANIFEST_REQUIRED: "尚无可核对的运行版本准入依据，不能批准。",
    VERIFICATION_VERSION_MISMATCH: "工程或策略证据不属于当前版本。",
    VERIFICATION_NOT_ACTUAL_PASS: "没有符合实际建议要求的正式准入结果。",
    FORMAL_STRATEGY_EVIDENCE_REQUIRED: "缺少正式策略证据，研究结果不能直接替代。",
    NO_ACTIVE_GOVERNANCE: "尚无当前有效的账户政策与策略激活。",
    GOVERNANCE_VERSION_CHANGED: "政策或策略版本已变化。",
    POLICY_REVIEW_OVERDUE: "政策已到复核期限。",
    ACCOUNT_CAPABILITY_MISSING: "账户交易范围或权限证据不足。",
    ACCOUNT_RECONCILIATION_REQUIRED: "账户需要先通过独立对账。",
    INSUFFICIENT_AVAILABLE_CASH: "已核对的同账户、同币种可用现金不足。",
    RISK_INPUT_INVALID: "关键输入未通过核验，不能把未完成计算视为可执行。",
  };
  return messages[code.replaceAll("-", "_")] ?? "存在未通过的准入或风控条件，请展开原始标识复核；不据此扩大资金、风险或交易权限。";
}
