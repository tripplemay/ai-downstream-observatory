"""Describe frozen research rules without enabling a live monitor."""

from worker.accounting.decimal_math import canonical, decimal, financial
from worker.research.fixed_policy import VERSION


SUFFIX = "+fixed-policy-v2"
MONITOR_GAP = "INVESTOR_MONITOR_FIXED_POLICY_UNSUPPORTED"


@financial
def decision_rule(parameters, monitor_supported=False):
    if parameters["schema_version"] != VERSION:
        return None
    cycle = "每半年" if parameters["rebalance"] == "first_decision_each_half_year" else "每年"
    return (cycle + "复核；资产类别偏离达到 " + canonical(decimal(parameters["class_drift_threshold"]) * 100)
        + " 个百分点触发；调整冷却期 " + str(parameters["minimum_days_between_rebalances"])
        + " 个当地日历日；新增人民币现金只买入补足低配，不卖出；研究订单于下月边界失效。"
        + ("持续监测须保存带冻结规则的新版方案并核验有效来源。" if monitor_supported else "当前持续监测尚不支持此规则。"))
