import { Decimal } from "../ledger/decimal";
import { hash } from "../ledger/service";

export const fixedPolicySuffix = "+fixed-policy-v2";
export const fixedPolicyMonitorGap = "INVESTOR_MONITOR_FIXED_POLICY_UNSUPPORTED";

/** Only describe already verified frozen parameters; never choose a default. */
export function fixedPolicyDecisionRule(parameters: Record<string, unknown>, monitorSupported = false): string | undefined {
  if (parameters.schema_version !== "research-fixed-rebalance-parameters-v2") return undefined;
  const cycle = parameters.rebalance === "first_decision_each_half_year" ? "每半年" : "每年";
  return cycle + "复核；资产类别偏离达到 " + new Decimal(parameters.class_drift_threshold as string).mul(100).toFixed()
    + " 个百分点触发；调整冷却期 " + parameters.minimum_days_between_rebalances
    + " 个当地日历日；新增人民币现金只买入补足低配，不卖出；研究订单于下月边界失效。"
    + (monitorSupported ? "持续监测须保存带冻结规则的新版方案并核验有效来源。" : "当前持续监测尚不支持此规则。");
}

export function fixedPolicyUnsupported(plan: { schema_version: string; strategy_version: string }) {
  return plan.strategy_version.endsWith(fixedPolicySuffix) && plan.schema_version !== "investor-reference-plan-v2";
}

export function modelDefinitionHash(value: { profile_hash: unknown; plan_hash: unknown; targets: unknown; schema_version: unknown; fixed_policy?: unknown }) {
  return hash({ profile_hash: value.profile_hash, plan_hash: value.plan_hash, targets: value.targets,
    ...(value.schema_version === "investor-model-definition-v2" ? { fixed_policy: value.fixed_policy } : {}) });
}
