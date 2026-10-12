"""Render derived research observations; no raw market values in metadata."""

from .runtime import _milliseconds


LABELS = {
    "FIXED_POLICY_WITHIN_CLASS_BANDS": "类别偏离未达到冻结阈值，当前也没有到期周期复核；继续观察。",
    "POLICY_TARGETS_WITHIN_TOLERANCE": "冻结规则已复核，但证券金额差异仍在容差内；不为精确追逐权重强迫交易。",
    "POLICY_COOLDOWN_NO_NEW_ADVICE": "当前仍在研究建议冷却期内，不发布新的全面再平衡建议；这不表示偏离已消失或旧建议已执行。",
    "CALENDAR_POLICY_REVIEW": "已到冻结策略的当地半年度或年度复核周期；日期只触发研究，不强制交易。",
    "CLASS_WEIGHT_BREACH": "资产类别的绝对偏离已达到冻结百分点阈值；不以单只证券偏离替代类别判断。",
    "PLANNED_FUNDING_REVIEW_OPEN": "同一笔假设资金的修复方案仍待决策，不视为已投入，也不重复延后冷却起点。",
    "NEW_MODEL_CNY_CASH": "参考模型出现新增人民币现金，已含于模型净值；优先研究不卖出的低配修复。",
    "MODEL_CNY_CASH_REVIEW_OPEN": "参考模型现金修复仍待决定，未改变模型单位或实际账户现金。",
    "MODEL_WITHIN_CONFIRMED_BANDS": "本次模型计算完成，偏离未超过已确认阈值；继续观察。",
    "NEW_PLANNED_FUNDING": "计划投入已到复核日期，优先研究补足低配资产。计划资金仍不等于实际到账。",
    "TARGET_WEIGHTS_CHANGED": "参考目标权重发生变化，需要比较维持原方案与调整的理由。",
    "MODEL_DRIFT_OUTSIDE_BAND": "模型偏离已超过研究阈值；先比较新资金修复与成本，不自动交易。",
    "REQUIRED_INPUTS_NOT_CURRENT": "必要证据未齐或已陈旧，无法得出当前有效的调整结论。",
    "CANNOT_COMPARE_CHANGE_COST": "缺少费用假设，无法比较调整成本。",
    "CHANGE_NOT_COST_QUALIFIED": "估算调整成本超过研究策略约束。",
    "NO_COST_QUALIFIED_CONTRIBUTION_REPAIR": "本次计划投入无法在费用预算内形成有效修复；不能记为零成本投入。",
}


def observation(definition, request, result, next_check):
    document, assessment = result["monitor_request"]["document"], result["assessment"]
    gaps = []
    for code in assessment["gaps"]:
        base, _, scope = code.partition(":")
        affected = sorted({row["market"] for row in document["quotes"] if not scope or row["market"] == scope or row["currency"] == scope})
        gaps.append({"code": base + ("_" + scope if scope else ""),
            "title": "市场有效收盘数据未齐" if base == "MARKET_DATA_NOT_CURRENT" else "汇率证据未齐" if base.startswith("FX_") else "研究输入待复核",
            "detail": "输入检查未通过：" + code + "。本次不把缺少有效结论当作无需调整。", "affected_markets": affected,
            "action": "补齐对应来源、身份、日历和费用证据后重新计算。"})
    change = {key: assessment[key] for key in ("model_nav_cny", "estimated_cost_cny", "hypothetical_cash_remaining_cny", "funding_status", "allocation_method", "constraints_not_checked", "changes")}
    if assessment.get("policy_evaluation") is not None: change["policy_evaluation"] = assessment["policy_evaluation"]
    change.update(assessment_hash=assessment["result_hash"], market_cutoffs={key: _milliseconds(value) for key, value in assessment["market_cutoffs"].items()})
    return {"schema_version": "investor-observation-v1", "outcome": assessment["outcome"], "evaluated_at": _milliseconds(assessment["evaluated_at"]),
        "data_cutoff": _milliseconds(assessment["data_cutoff"]), "profile_id": definition["profile_id"], "profile_version": definition["profile_version"],
        "input_version": request["input_version"], "gaps": gaps, "reasons": [LABELS.get(code, "研究检查：" + code) for code in assessment["reason_codes"]],
        "next_review_at": next_check,
        "next_conditions": ["各市场下一次有效收盘或汇率证据更新", "参考目标、风险约束或日期化投入计划发生变化"],
        "monitoring": "active", "scope": "research_model", "live_advice_eligible": False, "model_change": change}


def blocked_observation(definition, input_version, at, code, next_check=None):
    limit = code == "MONITOR_CHECKPOINT_LIMIT_REQUIRES_RESTART"
    funding = code.startswith("MONITOR_FUNDING_")
    funding_detail = "保存的年度计划与监测输入中另一笔投入意图同时存在；不能猜测是否同一笔资金或将二者相加。" if code == "MONITOR_FUNDING_INTENTS_CONFLICT" \
        else "投入计划的研究窗口已结束；停止使用旧批次形成新调整建议。" if code == "MONITOR_FUNDING_PLAN_WINDOW_EXPIRED" \
        else "计划版本、年度批次或保存证据需重新核验；不能继续把旧观察显示为无需调整。"
    return {"schema_version": "investor-observation-v1", "outcome": "insufficient_evidence", "evaluated_at": at, "data_cutoff": None,
        "profile_id": definition["profile_id"], "profile_version": definition["profile_version"], "input_version": input_version,
        "gaps": [{"code": code, "title": "投入计划需要复核" if funding else "连续模型达到安全重放上限" if limit else "监测来源或连续模型需复核",
            "detail": funding_detail if funding else "新的有效收盘或企业行动需要推进状态，但已达到重放上限；不丢弃前序证据，不自动重置或拼接收益。" if limit else "来源不再有效或连续状态未能核验；不提供旧估值，也不把缺少结论当作无需调整。",
            "affected_markets": sorted({row["market"] for row in definition["targets"]}),
            "action": "核对当前投入计划并等待后台重新核验；保存计划或审阅决定均不会成交。" if funding else "需要重新审阅有效参考方案并明确建立独立观察起点；不能用新报价延长旧来源许可。" if limit else "补齐来源；涉及历史修订或保留期中断时需明确重述或重新建立观察起点。"}],
        "reasons": ["研究模型与真实账户独立；计划资金和审阅决定不会自动改变持仓或发出订单。"], "next_review_at": next_check,
        "next_conditions": ["来源或监测输入更新后复核", "参考方案与连续模型状态完成复核"],
        "monitoring": "not_enabled", "scope": "research_model", "live_advice_eligible": False}
