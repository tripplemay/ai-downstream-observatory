"""Durable local search/exposure audit, not independent holdout certification."""

from datetime import datetime, timezone
import json
import math

from worker.accounting.decimal_math import financial, decimal
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, new_id, transaction
from worker.orchestration.jobs import assert_lease, heartbeat
from worker.research.backtest import compare_backtest
from .strategy import _summary, _stress, _within_risk, validate_reference_inputs


def _sealed(row, field="document_json"):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError()
            result[key] = value
        return result
    try:
        value = json.loads(row[field], object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        if content_hash(value) != row["content_hash"]:
            raise ValueError()
        return value
    except Exception:
        raise WorkbenchError("INVESTOR_TRIAL_EVIDENCE_INVALID") from None


def _micros(value):
    delta = instant(value) - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (delta.days * 86400 + delta.seconds) * 1000000 + delta.microseconds


class TrialRecorder:
    def __init__(self, connection, job, lease, request, profile, payload, implementation, clock, stop_requested=None):
        self.db, self.job, self.lease = connection, job, lease
        self.request, self.profile, self.payload = request, profile, payload
        self.implementation, self.clock, self.stop_requested = implementation, clock, stop_requested
        self.last_pulse = instant(clock())
        duration = math.ceil((instant(job["lease_until"]) - instant(job["heartbeat_at"])).total_seconds())
        if not 1 <= duration <= 3600:
            raise WorkbenchError("INVESTOR_TRIAL_LEASE_DURATION_INVALID")
        self.lease_seconds, self.interval = duration, min(10, duration / 3)
        validate_reference_inputs(**payload, profile=profile["preferences"], allow_synthetic=True)
        qualification = "synthetic_test_only"
        if payload["dataset"]["mode"] == "reconstructed":
            from .source_inputs import resolve_evidence_input
            admitted = resolve_evidence_input(connection, request["workspace_id"], request["evidence_input_id"], now=clock())
            if admitted["payload"] != payload:
                raise WorkbenchError("INVESTOR_TRIAL_SOURCE_BINDING_INVALID")
            qualification = admitted["row"]["source_qualification"]
        elif payload["dataset"]["mode"] != "synthetic":
            raise WorkbenchError("INVESTOR_TRIAL_SOURCE_BINDING_INVALID")
        self.source_qualification = qualification
        self.pulse(force=True)
        with transaction(connection):
            assert_lease(connection, lease, now=clock())
            existing = connection.execute("SELECT * FROM investor_experiments WHERE request_id=? AND implementation_hash=?",
                                          (request["id"], implementation)).fetchone()
            if existing:
                document = _sealed(existing)
                identifier, created = existing["id"], existing["created_at"]
            else:
                identifier, created = new_id("investor-experiment"), clock()
            expected = {"schema_version": "investor-experiment-v1", "experiment_id": identifier,
                "workspace_id": request["workspace_id"], "request_id": request["id"], "input_version": request["input_version"],
                "profile_hash": profile["content_hash"], "dataset_hash": content_hash(payload["dataset"]),
                "plan_hash": content_hash(payload["plan"]), "policy_hash": content_hash(payload["policy"]),
                "implementation_hash": implementation, "candidate_hashes": sorted(content_hash(row) for row in payload["policy"]["candidates"]),
                "benchmark_hash": content_hash(payload["plan"]["benchmark"]),
                "trial_budgets": {"train": len(payload["policy"]["candidates"]), "validation": 1, "holdout": 1},
                "windows": payload["plan"]["windows"], "source_qualification": qualification,
                "created_at": created, "live_advice_eligible": False}
            validate_contract(expected, "investor-experiment.schema.json")
            if not instant(request["created_at"]) <= instant(created) <= instant(clock()):
                raise WorkbenchError("INVESTOR_TRIAL_CLOCK_BINDING_INVALID")
            if existing and document != expected:
                raise WorkbenchError("INVESTOR_TRIAL_REGISTRATION_CONFLICT")
            if not existing:
                connection.execute("INSERT INTO investor_experiments(id,workspace_id,request_id,implementation_hash,document_json,content_hash,created_at) VALUES(?,?,?,?,?,?,?)",
                    (identifier, request["workspace_id"], request["id"], implementation, canonical_json(expected), content_hash(expected), created))
            self.experiment, self.manifest = identifier, expected

    def pulse(self, force=False):
        now = self.clock()
        current = instant(now)
        if self.stop_requested and self.stop_requested():
            raise WorkbenchError("WORKER_STOP_REQUESTED")
        if current < self.last_pulse:
            raise WorkbenchError("INVESTOR_TRIAL_CLOCK_REGRESSION")
        if force or (current - self.last_pulse).total_seconds() >= self.interval:
            if self.source_qualification == "owner_reviewed_reconstructed":
                from .source_inputs import source_document, source_unavailable_reason
                _, document = source_document(self.db, self.request["workspace_id"], self.request["evidence_input_id"], now)
                if source_unavailable_reason(self.db, self.request["workspace_id"], document, now):
                    raise WorkbenchError("INVESTOR_TRIAL_SOURCE_NO_LONGER_CURRENT")
            self.lease = heartbeat(self.db, self.lease, self.lease_seconds, now=now)
            self.last_pulse = current

    def _summary(self, row, parameters, phase):
        value = _sealed(row)
        validate_contract(value, "investor-strategy-result.schema.json", "$defs/summary")
        if (value["phase"] != phase or value["window"] != self.manifest["windows"][phase] or parameters not in self.manifest["candidate_hashes"]
                or not instant(self.manifest["created_at"]) <= instant(row["created_at"]) <= instant(self.clock())):
            raise WorkbenchError("INVESTOR_TRIAL_RESULT_BINDING_INVALID")
        return value

    def evaluate(self, parameters, phase):
        self.pulse(force=True)
        digest = content_hash(parameters)
        if digest not in self.manifest["candidate_hashes"] or phase not in self.manifest["windows"]:
            raise WorkbenchError("INVESTOR_TRIAL_OUTSIDE_REGISTRATION")
        window = self.manifest["windows"][phase]
        with transaction(self.db):
            assert_lease(self.db, self.lease, now=self.clock())
            trial = self.db.execute("SELECT * FROM investor_trial_intents WHERE experiment_id=? AND phase=? AND parameters_hash=?",
                                    (self.experiment, phase, digest)).fetchone()
            if trial is None:
                identifier = new_id("investor-trial")
                self.db.execute("INSERT INTO investor_trial_intents(id,experiment_id,phase,parameters_hash,window_start_us,window_end_us,job_id,fencing_token,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                    (identifier, self.experiment, phase, digest, _micros(window["start"]), _micros(window["end"]), self.job["id"], self.lease.fencing_token, self.clock()))
            else:
                identifier = trial["id"]
                if (trial["window_start_us"], trial["window_end_us"]) != (_micros(window["start"]), _micros(window["end"])):
                    raise WorkbenchError("INVESTOR_TRIAL_WINDOW_BINDING_INVALID")
            previous = self.db.execute("SELECT * FROM investor_trial_results WHERE trial_id=?", (identifier,)).fetchone()
            if previous is not None:
                return self._summary(previous, digest, phase)
        # Intent commits BEFORE reading the phase; crashes cannot erase exposure.
        result = _summary(compare_backtest(self.payload["dataset"], self.payload["plan"], parameters, phase, progress=self.pulse))
        validate_contract(result, "investor-strategy-result.schema.json", "$defs/summary")
        self.pulse(force=True)
        with transaction(self.db):
            assert_lease(self.db, self.lease, now=self.clock())
            self.db.execute("INSERT INTO investor_trial_results(trial_id,document_json,content_hash,job_id,fencing_token,created_at) VALUES(?,?,?,?,?,?)",
                (identifier, canonical_json(result), content_hash(result), self.job["id"], self.lease.fencing_token, self.clock()))
        return result

    @financial
    def freeze(self, parameters):
        self.pulse(force=True)
        with transaction(self.db):
            assert_lease(self.db, self.lease, now=self.clock())
            rows = self.db.execute("SELECT t.parameters_hash,r.* FROM investor_trial_intents t JOIN investor_trial_results r ON r.trial_id=t.id WHERE t.experiment_id=? AND t.phase='train' ORDER BY t.parameters_hash", (self.experiment,)).fetchall()
            if [row["parameters_hash"] for row in rows] != self.manifest["candidate_hashes"]:
                raise WorkbenchError("INVESTOR_TRIAL_TRAIN_INCOMPLETE")
            by_hash = {content_hash(row): row for row in self.payload["policy"]["candidates"]}
            budget = self.profile["preferences"]["loss_tolerance"]
            if budget is None:
                raise WorkbenchError("INVESTOR_TRIAL_RISK_UNCONFIRMED")
            eligible = [(row, self._summary(row, row["parameters_hash"], "train")) for row in rows
                if _within_risk(self._summary(row, row["parameters_hash"], "train"), _stress(by_hash[row["parameters_hash"]], self.payload["policy"]), decimal(budget))]
            if not eligible:
                raise WorkbenchError("INVESTOR_TRIAL_NO_ELIGIBLE_CANDIDATE")
            chosen, _ = min(eligible, key=lambda item: (-decimal(item[1]["annualized_unit_return"]), -decimal(item[1]["max_drawdown"]),
                decimal(item[1]["buy_turnover_on_mean_observed_nav"]) + decimal(item[1]["sell_turnover_on_mean_observed_nav"]), item[0]["parameters_hash"]))
            if chosen["parameters_hash"] != content_hash(parameters):
                raise WorkbenchError("INVESTOR_TRIAL_SELECTION_NOT_TRAIN_ONLY")
            evidence = {"experiment_id": self.experiment, "parameters_hash": content_hash(parameters), "selection_basis": "train_only",
                "manifest_hash": content_hash(self.manifest), "train_result_hashes": {row["parameters_hash"]: row["content_hash"] for row in rows}}
            previous = self.db.execute("SELECT * FROM investor_candidate_freezes WHERE experiment_id=?", (self.experiment,)).fetchone()
            if previous:
                if _sealed(previous, "evidence_json") != evidence:
                    raise WorkbenchError("INVESTOR_TRIAL_SELECTION_CONFLICT")
                return
            self.db.execute("INSERT INTO investor_candidate_freezes(experiment_id,parameters_hash,evidence_json,content_hash,job_id,fencing_token,created_at) VALUES(?,?,?,?,?,?,?)",
                (self.experiment, content_hash(parameters), canonical_json(evidence), content_hash(evidence), self.job["id"], self.lease.fencing_token, self.clock()))

    def receipt(self):
        self.pulse(force=True)
        with transaction(self.db):
            assert_lease(self.db, self.lease, now=self.clock())
            return self._receipt()

    def _receipt(self):
        phases = {}
        for phase in ("train", "validation", "holdout"):
            row = self.db.execute("SELECT count(*) registered,count(r.trial_id) completed FROM investor_trial_intents t LEFT JOIN investor_trial_results r ON r.trial_id=t.id WHERE t.experiment_id=? AND t.phase=?", (self.experiment, phase)).fetchone()
            phases[phase] = {"registered": row["registered"], "completed": row["completed"]}
        window = self.manifest["windows"]["holdout"]
        # Deliberately conservative: changed labels, values, or universe hashes
        # do not reset overlapping local exposure. Intent counts even if failed.
        exposed = self.db.execute("SELECT count(DISTINCT experiment_id) FROM investor_trial_intents WHERE experiment_id!=? AND window_start_us<=? AND window_end_us>=?",
                                 (self.experiment, _micros(window["end"]), _micros(window["start"]))).fetchone()[0]
        frozen = self.db.execute("SELECT content_hash FROM investor_candidate_freezes WHERE experiment_id=?", (self.experiment,)).fetchone()
        watermark = self.db.execute("SELECT coalesce(max(rowid),0) FROM investor_trial_intents").fetchone()[0]
        return {"experiment_id": self.experiment, "manifest_hash": content_hash(self.manifest), "phases": phases,
            "freeze_hash": frozen[0] if frozen else None, "prior_window_exposures": exposed,
            "exposure_watermark": watermark,
            "holdout_status": "previously_exposed" if exposed else "not_independently_verified",
            "coverage": "local_investor_trials_only", "live_advice_eligible": False}
