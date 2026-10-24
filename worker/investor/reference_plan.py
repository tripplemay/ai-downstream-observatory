"""Render a frozen exploratory result, never choose weights or authorize trades."""

from worker.accounting.decimal_math import canonical, decimal, financial
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash
from .fixed_policy import SUFFIX, decision_rule
from .model_contracts import reference_schema


@financial
def render_reference_plan(profile_id, request_id, run_id, input_version, source, result, registry, created_at, *, version="investor-reference-plan-v1"):
    if (source["row"]["source_qualification"] != "owner_reviewed_reconstructed"
            or result["status"] != "reference_ready" or result["data_mode"] != "reconstructed"
            or result["qualification"] != "exploratory_research_only" or result["live_advice_eligible"]
            or source["document"]["valid_until"] <= created_at or registry["freeze_hash"] is None
            or registry["phases"]["validation"]["completed"] != 1 or registry["phases"]["holdout"]["completed"] != 1):
        raise WorkbenchError("INVESTOR_REFERENCE_EVIDENCE_INVALID")
    parameters = result["selected_parameters"]
    supported = version == "investor-reference-plan-v2"
    if version not in ("investor-reference-plan-v1", "investor-reference-plan-v2") or supported and parameters["schema_version"] != "research-fixed-rebalance-parameters-v2":
        raise WorkbenchError("INVESTOR_REFERENCE_EVIDENCE_INVALID")
    rule = decision_rule(parameters, supported)
    execution = source["payload"]["plan"]["execution"]
    action_aware = source["payload"]["plan"]["schema_version"] == "research-plan-v4"
    bounded = source["payload"]["plan"]["schema_version"] in ("research-plan-v3", "research-plan-v4")
    candidate = next((row for row in result["candidates"] if row["parameters_hash"] == content_hash(parameters)), None)
    if candidate is None or not candidate["risk_budget_pass"]:
        raise WorkbenchError("INVESTOR_REFERENCE_EVIDENCE_INVALID")
    roles = {"growth": "成长资产", "defensive": "防守资产", "diversifier": "分散资产"}
    targets = []
    for identity, weight in sorted(parameters["weights"].items()):
        facts = source["catalog"][identity]
        targets.append({"listing_id": identity, "symbol": facts["provider_symbol"], "name": facts["provider_symbol"],
            "market": facts["market"], "currency": facts["currency"], "weight": weight, "role": roles[facts["role"]],
            "overlap_summary": "未完成基金成分穿透；不同挂牌市场不等于底层资产分散。"})
    percent = lambda value: canonical(decimal(value) * 100) + "%"
    from .runtime import _milliseconds
    cutoff = _milliseconds(max(row["observed_at"] for row in source["payload"]["dataset"]["observations"]
        if row["metric"] == "close" and row["series_key"] in parameters["weights"]))
    value = {"schema_version": version, "profile_id": profile_id,
        "strategy_version": result["engine_version"] + ("+bounded-close-v1" if bounded else "") + ("+action-aware-close-v1" if action_aware else "") + (SUFFIX if rule else ""),
        "strategy_evidence": "训练期冻结候选后完成验证与保留期计算；仅为探索性历史研究，保留期独立性未验证。" + (rule or ""),
        "input_version": input_version,
        "data_cutoff": cutoff,
        "created_at": created_at, "valid_until": source["document"]["valid_until"], "data_mode": "reconstructed", "targets": targets,
        "estimated_cost": "历史比较按冻结费用、滑点与换汇假设；不代表你的券商收费或实际税务成本。" + (
            "买入数量按冻结价格缓冲 " + canonical(decimal(execution["buy_price_buffer_bps"]) / 100)
            + "%、外币汇率缓冲 " + canonical(decimal(execution["buy_fx_buffer_bps"]) / 100)
            + "% 及费用预留；超界跳过，不临时缩量。" if bounded else "") + (
            "已知公司行动落在决策与预定成交之间时，整批暂不建单，等下一预定评估重新计算；等待仍承担现金机会成本，未知行动仍可取消已建订单。" if action_aware else ""),
        "risk_scenarios": [row["label"] + "：假设组合变化 " + percent(row["portfolio_return"]) + "；不是发生概率或未来损失上限。" for row in candidate["stresses"]],
        "benchmark_summary": "同 ETF 范围、时点与成本口径；训练期基准扣费后 TWR " + percent(candidate["train"]["benchmark_twr"]) + "。各阶段重新起算，不是连续个人收益。",
        "counterarguments": ["历史目录与可用时点为重建假设，不能排除幸存者偏差或工具外样本曝光。", "较高历史收益不证明未来优势；复杂策略必须与简单基准比较。"],
        "uncertainties": ["当前行情、成分重叠、实际费用税务和可买性尚需独立复核。", "保存只登记研究观察模型，不创建实际持仓、现金、批准或订单。"],
        "reference_evidence": {"request_id": request_id, "run_id": run_id, "source_input_id": source["row"]["id"],
            "experiment_id": registry["experiment_id"], "manifest_hash": registry["manifest_hash"], "result_hash": result["result_hash"],
            "selected_parameters_hash": content_hash(parameters), "holdout_status": registry["holdout_status"],
            "qualification": "owner_reviewed_reconstructed"}, "live_advice_eligible": False}
    if supported:
        value["fixed_policy"] = {"parameters": parameters, "evaluation_timezone": source["payload"]["plan"]["evaluation_timezone"]}
    validate_contract(value, reference_schema(value))
    return value


def persist_reference_plan(db, workspace_id, profile_id, request_id, run_id, input_version, source, result, registry, now):
    from worker.orchestration.db import new_id
    version = "investor-reference-plan-v2" if result["selected_parameters"]["schema_version"] == "research-fixed-rebalance-parameters-v2" else "investor-reference-plan-v1"
    document = render_reference_plan(profile_id, request_id, run_id, input_version, source, result, registry, now, version=version)
    identifier = new_id("investor-reference")
    db.execute("INSERT INTO investor_reference_plans(id,workspace_id,profile_id,document_json,content_hash,created_at) VALUES(?,?,?,?,?,?)",
        (identifier, workspace_id, profile_id, canonical_json(document), content_hash(document), now))
    db.execute("INSERT INTO investor_reference_evidence(plan_id,workspace_id,request_id,run_id,evidence_input_id,result_hash,created_at) VALUES(?,?,?,?,?,?,?)",
        (identifier, workspace_id, request_id, run_id, source["row"]["id"], result["result_hash"], now))
    return identifier


def reference_source_current(db, workspace_id, plan_id, now, *, verify_result=False):
    from .source_inputs import latest_input, resolve_evidence_input
    row = db.execute("SELECT * FROM investor_reference_evidence WHERE plan_id=? AND workspace_id=?", (plan_id, workspace_id)).fetchone()
    if row is None:
        raise WorkbenchError("INVESTOR_REFERENCE_EVIDENCE_INVALID")
    source = resolve_evidence_input(db, workspace_id, row["evidence_input_id"], now=now, header_only=True, allow_unavailable=True)
    head = latest_input(db, workspace_id)
    current = source.get("unavailable_reason") is None and head is not None and head["id"] == row["evidence_input_id"]
    if current:
        from .model_runtime import _sealed
        from .runtime import _json
        plan = db.execute("SELECT * FROM investor_reference_plans WHERE id=? AND workspace_id=?", (plan_id, workspace_id)).fetchone()
        value = _json(plan["document_json"])
        if value.get("schema_version") == "investor-reference-plan-v2" or verify_result:
            _sealed(plan, reference_schema(value))
            admitted = resolve_evidence_input(db, workspace_id, row["evidence_input_id"], now=now)
            request = db.execute("SELECT * FROM investor_research_requests WHERE id=? AND workspace_id=?", (row["request_id"], workspace_id)).fetchone()
            run = db.execute("SELECT u.*,j.status job_status,j.job_type,j.scope,j.period,j.input_version job_input,j.command_request_id FROM investor_research_runs u JOIN job_runs j ON j.id=u.job_id WHERE u.id=? AND u.workspace_id=?", (row["run_id"], workspace_id)).fetchone()
            if request is None or run is None or not (run["request_id"] == request["id"] and run["status"] == "calculated" and run["job_status"] == "succeeded"
                    and run["job_type"] == "investor_research" and run["scope"] == workspace_id and run["period"] == request["id"]
                    and run["job_input"] == request["input_version"] and run["command_request_id"] is None
                    and request["profile_id"] == plan["profile_id"] and request["evidence_input_id"] == row["evidence_input_id"] and request["input_id"] is None
                    and run["created_at"] == plan["created_at"] == row["created_at"] <= now):
                raise WorkbenchError("INVESTOR_REFERENCE_EVIDENCE_INVALID")
            profile = db.execute("SELECT * FROM investor_profiles WHERE id=? AND workspace_id=?", (plan["profile_id"], workspace_id)).fetchone()
            _sealed(profile, "investor-profile.schema.json")
            bound = _json(request["document_json"])
            expected = {"schema_version": "investor-research-request-v1", "engine_version": "investor-diversified-reference-v1",
                "profile_hash": profile["content_hash"], "input_hash": admitted["row"]["content_hash"]}
            stored = _json(run["document_json"])
            if content_hash(stored) != run["content_hash"] or bound != expected or content_hash(bound) != request["input_version"]:
                raise WorkbenchError("INVESTOR_REFERENCE_EVIDENCE_INVALID")
            result, registry = stored["result"], stored["registry"]
            validate_contract(result, "investor-strategy-result.schema.json")
            body = {key: entry for key, entry in result.items() if key != "result_hash"}
            experiment = db.execute("SELECT * FROM investor_experiments WHERE id=? AND workspace_id=? AND request_id=?", (registry["experiment_id"], workspace_id, request["id"])).fetchone()
            frozen = db.execute("SELECT * FROM investor_candidate_freezes WHERE experiment_id=?", (registry["experiment_id"],)).fetchone()
            from .trials import _sealed as sealed_trial
            manifest = sealed_trial(experiment)
            freeze = sealed_trial(frozen, "evidence_json")
            if not (content_hash(body) == result["result_hash"] == row["result_hash"] and result["profile_hash"] == profile["content_hash"]
                    and all(result[key + "_hash"] == content_hash(admitted["payload"][key]) for key in ("dataset", "plan", "policy"))
                    and result["implementation_hash"] == stored["implementation_hash"] == manifest["implementation_hash"]
                    and experiment["content_hash"] == registry["manifest_hash"] == freeze["manifest_hash"]
                    and frozen["content_hash"] == registry["freeze_hash"] and frozen["parameters_hash"] == freeze["parameters_hash"] == content_hash(result["selected_parameters"])
                    and frozen["created_at"] <= run["created_at"] and manifest["profile_hash"] == profile["content_hash"]
                    and all(manifest[key + "_hash"] == result[key + "_hash"] for key in ("dataset", "plan", "policy"))):
                raise WorkbenchError("INVESTOR_REFERENCE_EVIDENCE_INVALID")
            rendered = render_reference_plan(plan["profile_id"], request["id"], run["id"], request["input_version"], admitted, result, registry, plan["created_at"], version=value["schema_version"])
            if content_hash(rendered) != plan["content_hash"]:
                raise WorkbenchError("INVESTOR_REFERENCE_EVIDENCE_INVALID")
    return current
