"""Workspace-scoped research queue; never creates an actual portfolio or order."""

from datetime import datetime, timezone
import json

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, new_id, transaction
from worker.orchestration.jobs import JobCommit, enqueue_job
from .implementation import implementation_hash
from .strategy import ENGINE_VERSION, EVENT_ENGINE_VERSION, research_engine, research_reference
from .trials import TrialRecorder


JOB_TYPE = "investor_research"
MAX_INPUT_BYTES = 16777216


def _json(value):
    def pairs(items):
        result = {}
        for key, item in items:
            if key in result: raise WorkbenchError("INVESTOR_RESEARCH_EVIDENCE_INVALID")
            result[key] = item
        return result
    try:
        return json.loads(value, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, TypeError, RecursionError):
        raise WorkbenchError("INVESTOR_RESEARCH_EVIDENCE_INVALID") from None


def _milliseconds(value=None):
    # Wall-clock publication uses milliseconds. Supplied replay clocks must be
    # exact rather than silently rounding a future evidence timestamp.
    if value is None:
        value = datetime.now(timezone.utc)
        value = value.replace(microsecond=value.microsecond // 1000 * 1000)
    moment = instant(value)
    if moment.microsecond % 1000 or isinstance(value, str) and len(value.partition(".")[2].removesuffix("Z")) > 6:
        raise WorkbenchError("INVESTOR_RESEARCH_CLOCK_PRECISION")
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _latest_input(connection, workspace_id):
    from .source_inputs import latest_input
    return latest_input(connection, workspace_id)


def register_synthetic_input(connection, workspace_id, dataset, plan, policy, *, now=None):
    """Internal synthetic tests only; real captures use the evidence admission path."""
    if dataset.get("mode") != "synthetic":
        raise WorkbenchError("INVESTOR_SYNTHETIC_INPUT_REQUIRED")
    payload = {"dataset": dataset, "plan": plan, "policy": policy}
    document = canonical_json(payload)
    if len(document.encode()) > MAX_INPUT_BYTES:
        raise WorkbenchError("INVESTOR_RESEARCH_INPUT_LIMIT")
    # Validate without selecting parameters or exposing validation/holdout.
    validate_contract({"action": "research", **payload,
        "profile": {"schema_version": "investor-profile-v1", "horizon_years": 12, "loss_tolerance": None,
                    "liquidity_need": "none_in_horizon", "markets": ["CN", "HK", "US"],
                    "product_scope": "unleveraged_long_only_etfs", "research_direction": "system_design", "exclusions": [],
                    "illustrative_budget_cny": None, "planned_annual_contribution_cny": None}}, "investor-kernel-request.schema.json")
    digest, created = content_hash(payload), _milliseconds(now)
    with transaction(connection):
        previous = connection.execute("SELECT * FROM investor_research_inputs WHERE workspace_id=? AND content_hash=?", (workspace_id, digest)).fetchone()
        if previous: return dict(previous)
        identifier = new_id("research-input")
        connection.execute("INSERT INTO investor_research_inputs(id,workspace_id,source_qualification,document_json,content_hash,created_at) VALUES(?,?,'synthetic_test_only',?,?,?)",
                           (identifier, workspace_id, document, digest, created))
        return dict(connection.execute("SELECT * FROM investor_research_inputs WHERE id=?", (identifier,)).fetchone())


def sync_research_requests(connection, *, limit=100, now=None):
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise WorkbenchError("INVESTOR_RESEARCH_DISCOVERY_LIMIT")
    requests = connection.execute("""SELECT r.* FROM investor_research_requests r LEFT JOIN job_runs j
      ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.input_version
      WHERE j.id IS NULL ORDER BY r.created_at,r.rowid LIMIT ?""", (JOB_TYPE, limit)).fetchall()
    return [enqueue_job(connection, JOB_TYPE, row["workspace_id"], row["id"], row["input_version"],
                        max_attempts=2, now=now) for row in requests]


def _binding(connection, job, now, *, header_only=False):
    request = connection.execute("SELECT * FROM investor_research_requests WHERE id=? AND workspace_id=?", (job["period"], job["scope"])).fetchone()
    if (request is None or job["job_type"] != JOB_TYPE or job["command_request_id"] is not None
            or job["input_version"] != request["input_version"] or instant(request["created_at"]) > instant(now)):
        raise WorkbenchError("INVESTOR_RESEARCH_BINDING_INVALID")
    document = _json(request["document_json"])
    if (not isinstance(document, dict) or set(document) != {"schema_version", "engine_version", "profile_hash", "input_hash"}
            or document["schema_version"] != "investor-research-request-v1" or document["engine_version"] not in (ENGINE_VERSION, EVENT_ENGINE_VERSION)
            or content_hash(document) != request["input_version"]):
        raise WorkbenchError("INVESTOR_RESEARCH_BINDING_INVALID")
    profile = connection.execute("SELECT * FROM investor_profiles WHERE id=? AND workspace_id=?", (request["profile_id"], job["scope"])).fetchone()
    if profile is None or instant(profile["created_at"]) > instant(now):
        raise WorkbenchError("INVESTOR_RESEARCH_BINDING_INVALID")
    preferences = _json(profile["document_json"])
    validate_contract(preferences, "investor-profile.schema.json")
    if content_hash(preferences) != profile["content_hash"] or document["profile_hash"] != profile["content_hash"]:
        raise WorkbenchError("INVESTOR_RESEARCH_BINDING_INVALID")
    evidence_id = request["evidence_input_id"]
    if evidence_id is not None and request["input_id"] is not None:
        raise WorkbenchError("INVESTOR_RESEARCH_BINDING_INVALID")
    source = connection.execute("SELECT * FROM investor_research_inputs WHERE id=? AND workspace_id=?", (request["input_id"], job["scope"])).fetchone()
    if evidence_id is None and ((source is None) != (request["input_id"] is None) or (source is None) != (document["input_hash"] is None)):
        raise WorkbenchError("INVESTOR_RESEARCH_BINDING_INVALID")
    qualification = None
    payload = None
    if evidence_id is not None:
        from .source_inputs import resolve_evidence_input
        admitted = resolve_evidence_input(connection, job["scope"], evidence_id, now=now, header_only=header_only, allow_unavailable=True)
        source = admitted["row"]
        qualification = admitted.get("unavailable_reason") or source["source_qualification"]
        payload = admitted.get("payload")
        if source["created_at"] > request["created_at"] or source["content_hash"] != document["input_hash"]:
            raise WorkbenchError("INVESTOR_RESEARCH_BINDING_INVALID")
    elif source is not None:
        if source["source_qualification"] != "synthetic_test_only" or instant(source["created_at"]) > instant(request["created_at"]):
            raise WorkbenchError("INVESTOR_RESEARCH_BINDING_INVALID")
        qualification = source["source_qualification"]
        payload = _json(source["document_json"])
        if (not isinstance(payload, dict) or set(payload) != {"dataset", "plan", "policy"}
                or payload["dataset"].get("mode") != "synthetic" or content_hash(payload) != source["content_hash"]
                or document["input_hash"] != source["content_hash"]):
            raise WorkbenchError("INVESTOR_RESEARCH_BINDING_INVALID")
    source_plan = payload["plan"] if payload is not None else admitted["document"]["plan"] if evidence_id is not None else {}
    if document["engine_version"] != research_engine(source_plan):
        raise WorkbenchError("INVESTOR_RESEARCH_BINDING_INVALID")
    current_profile = connection.execute("SELECT id FROM investor_profiles WHERE workspace_id=? ORDER BY version DESC LIMIT 1", (job["scope"],)).fetchone()
    latest_input = _latest_input(connection, job["scope"])
    current = current_profile["id"] == profile["id"] and (latest_input["id"] if latest_input else None) == (evidence_id or request["input_id"])
    return request, profile, preferences, payload, current, qualification


def _observation(request, profile, preferences, codes, now, reference_ready=False):
    synthetic = "SYNTHETIC_RESEARCH_ONLY" in codes
    reconstructed = "RECONSTRUCTED_RESEARCH_ONLY" in codes
    gaps = [{"code": "SYNTHETIC_RESEARCH_ONLY" if synthetic else "REFERENCE_DATASET_NOT_READY",
             "title": "仅有合成数据测试" if synthetic else "研究数据尚未就绪",
             "detail": "计算结果只验证软件流程，不能作为真实 ETF 权重或个人投资结论。" if synthetic else "尚无经过身份、日历、价格、分红、汇率及使用许可核验的研究输入。",
             "affected_markets": preferences["markets"], "action": "接入并验收真实研究数据后重新生成参考方案。"}]
    if reconstructed:
        gaps[0] = {"code": "RECONSTRUCTED_RESEARCH_ONLY", "title": "历史参考已生成，等待有效监测输入" if reference_ready else "已完成历史重建研究，尚非当前观察方案",
            "detail": "已从审阅来源计算候选；发布时间和历史目录仍为重建假设，独立保留期与持续监测尚未验收。",
            "affected_markets": preferences["markets"], "action": "可保存历史参考用于研究观察；补齐当前监测输入后才能判断是否调整。" if reference_ready else "比较候选和损失情景；确认风险后完成参考方案与监测准入。"}
    elif any(code.startswith("REFERENCE_SOURCE_") for code in codes):
        gaps[0] = {"code": next(code for code in codes if code.startswith("REFERENCE_SOURCE_")), "title": "研究来源已失效",
            "detail": "来源过期、撤回、改版或载荷已删除；旧计算不作为当前研究依据。",
            "affected_markets": preferences["markets"], "action": "补充当前有效来源后重新评估，不恢复旧价格默认值。"}
    if preferences["loss_tolerance"] is None:
        gaps.append({"code": "RISK_BUDGET_UNCONFIRMED", "title": "风险预算尚未确认", "detail": "先比较损失情景，不替你默认选择风险档位。",
                     "affected_markets": [], "action": "阅读损失情景后确认可承受范围。"})
    if preferences["liquidity_need"] != "none_in_horizon":
        gaps.append({"code": "LIQUIDITY_REVIEW_REQUIRED", "title": "用款安排需要核对", "detail": "预计用款或流动性不确定，不能按长期不取款约束生成方案。",
                     "affected_markets": [], "action": "确认用款安排与预留资金。"})
    return {"schema_version": "investor-observation-v1", "outcome": "insufficient_evidence", "evaluated_at": now,
            "data_cutoff": None, "profile_id": profile["id"], "profile_version": profile["version"],
            "input_version": request["input_version"], "gaps": gaps,
            "reasons": ["后台研究已完成合成数据计算；未生成真实投资方案。" if synthetic else
                "后台已完成已审阅来源的历史重建候选；尚未启用持续监测或个人交易建议。" if reconstructed else
                "后台已检查本版研究输入；缺少当前合格数据，未生成确定权重。"],
            "next_review_at": None, "next_conditions": ["合格研究输入更新后复核", "风险与流动性约束明确后复核"],
            "monitoring": "not_enabled", "scope": "research_model", "live_advice_eligible": False}


def prepare_research_job(connection, job, lease, *, clock=None, allow_synthetic=False, stop_requested=None):
    if type(allow_synthetic) is not bool:
        raise WorkbenchError("INVESTOR_RESEARCH_TEST_SWITCH_INVALID")
    clock = (lambda: None) if clock is None else clock
    try:
        request, profile, preferences, payload, current, qualification = _binding(connection, job, _milliseconds(clock()))
        if not current:
            return {"result": {"code": "INVESTOR_RESEARCH_SUPERSEDED", "live_advice_eligible": False}, "outcome": "skipped"}
        if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
        implementation = implementation_hash()
        result = None
        registry = None
        reference_source = None
        if payload is None:
            codes = [qualification] if qualification and qualification.startswith("REFERENCE_SOURCE_") else ["REFERENCE_DATASET_NOT_READY", "REFERENCE_STRATEGY_NOT_READY"]
        elif qualification == "synthetic_test_only" and not allow_synthetic:
            codes = ["SYNTHETIC_RESEARCH_DISABLED"]
        else:
            recorder = TrialRecorder(connection, job, lease, request, {**dict(profile), "preferences": preferences}, payload,
                implementation, lambda: _milliseconds(clock()), stop_requested)
            result = research_reference(**payload, profile=preferences, allow_synthetic=allow_synthetic,
                evaluate=recorder.evaluate, freeze=recorder.freeze)
            registry = recorder.receipt()
            codes = ["SYNTHETIC_RESEARCH_ONLY" if qualification == "synthetic_test_only" else "RECONSTRUCTED_RESEARCH_ONLY", *result["reason_codes"]]
            if qualification == "owner_reviewed_reconstructed" and result["status"] == "reference_ready":
                from .source_inputs import resolve_evidence_input
                reference_source = resolve_evidence_input(connection, job["scope"], request["evidence_input_id"], now=_milliseconds(clock()))
    except Exception:
        # JSON/schema errors can contain private inputs. Only a fixed code may
        # reach retry history, worker logs or the browser's failed-task state.
        raise WorkbenchError("INVESTOR_RESEARCH_PREPARATION_FAILED") from None

    def commit(db):
        try:
            now = _milliseconds(clock())
            bound, bound_profile, _, _, still_current, current_qualification = _binding(db, job, now, header_only=True)
            if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
            if not still_current or implementation_hash() != implementation or current_qualification != qualification:
                return JobCommit({"code": "INVESTOR_RESEARCH_SUPERSEDED", "live_advice_eligible": False}, "skipped")
            if bound["id"] != request["id"] or bound_profile["content_hash"] != profile["content_hash"]:
                raise WorkbenchError("INVESTOR_RESEARCH_BINDING_INVALID")
            observation_id, run_id = new_id("investor-observation"), new_id("investor-study")
            observation = _observation(request, profile, preferences, codes, now, reference_source is not None)
            run = {"schema_version": "investor-research-run-v1", "status": "calculated" if result else "blocked",
                   "request_id": request["id"], "profile_id": profile["id"], "input_version": request["input_version"],
                   "engine_version": _json(request["document_json"])["engine_version"], "implementation_hash": implementation, "reason_codes": codes,
                   "result": result, "registry": registry, "created_at": now}
            run_json = canonical_json(run)
            if len(run_json.encode()) > 1048576: raise WorkbenchError("INVESTOR_RESEARCH_RESULT_LIMIT")
            db.execute("INSERT INTO investor_observations(id,workspace_id,profile_id,candidate_plan_id,outcome,document_json,content_hash,input_version,created_at) VALUES(?,?,?,NULL,'insufficient_evidence',?,?,?,?)",
                       (observation_id, job["scope"], profile["id"], canonical_json(observation), content_hash(observation), request["input_version"], now))
            db.execute("INSERT INTO investor_research_runs(id,workspace_id,request_id,job_id,observation_id,status,document_json,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                       (run_id, job["scope"], request["id"], job["id"], observation_id, run["status"], run_json, content_hash(run), now))
            plan_id = None
            if reference_source is not None:
                from .reference_plan import persist_reference_plan
                plan_id = persist_reference_plan(db, job["scope"], profile["id"], request["id"], run_id, request["input_version"], reference_source, result, registry, now)
            db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?", (job["scope"],))
            return JobCommit({"research_run_id": run_id, "status": run["status"], "observation_id": observation_id, "reference_plan_id": plan_id, "live_advice_eligible": False})
        except Exception:
            raise WorkbenchError("INVESTOR_RESEARCH_PUBLICATION_FAILED") from None
    return {"effect": commit}
