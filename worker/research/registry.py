"""Pre-registration, trial audit and irreversible holdout exposure records."""

from dataclasses import dataclass
from hashlib import sha256
from importlib.resources import files as package_files
import json
from pathlib import Path
import sys
from zoneinfo import TZPATH

from worker.orchestration.db import (
    ROOT, WorkbenchError, canonical_json, content_hash, new_id, stamp, transaction,
)
from .backtest import ENGINE_VERSION, compare_backtest
from .snapshot import snapshot_from_publications, validate_dataset, validate_parameters, validate_plan


@dataclass(frozen=True)
class PreparedResearch:
    trial_id: str
    run_id: str
    input_manifest: str
    result_json: str


def implementation_manifest(evaluation_timezone="UTC"):
    files = [ROOT / "worker/research/backtest.py", ROOT / "worker/research/snapshot.py",
             ROOT / "worker/research/registry.py", ROOT / "worker/orchestration/db.py",
             ROOT / "worker/market/contracts.py", ROOT / "requirements-workbench.txt",
             *sorted((ROOT / "worker/accounting").glob("*.py")),
             *sorted((ROOT / "contracts/v1").glob("*research*.schema.json")),
             ROOT / "contracts/v1/common.schema.json", ROOT / "contracts/v1/market-observation.schema.json"]
    timezone_hashes = {}
    for name in sorted({"UTC", "Asia/Shanghai", "Asia/Hong_Kong", "America/New_York", evaluation_timezone}):
        source = next((Path(path) / name for path in TZPATH if (Path(path) / name).is_file()), None)
        try:
            payload = source.read_bytes() if source else package_files("tzdata.zoneinfo").joinpath(*name.split("/")).read_bytes()
        except (ModuleNotFoundError, OSError) as exc:
            raise WorkbenchError("RESEARCH_TIMEZONE_DATA_UNAVAILABLE:" + name) from exc
        timezone_hashes[name] = sha256(payload).hexdigest()
    return {"engine_version": ENGINE_VERSION, "python_version": sys.version.split()[0], "timezone_hashes": timezone_hashes,
            "source_hashes": {str(path.relative_to(ROOT)): sha256(path.read_bytes()).hexdigest() for path in files}}


def _actor(actor_id):
    if not isinstance(actor_id, str) or not actor_id.strip():
        raise WorkbenchError("RESEARCH_ACTOR_REQUIRED")


def _experiment(connection, experiment_id):
    row = connection.execute("SELECT * FROM research_experiments WHERE id=?", (experiment_id,)).fetchone()
    if row is None:
        raise WorkbenchError("RESEARCH_EXPERIMENT_NOT_FOUND")
    result = dict(row)
    result["plan"] = json.loads(row["plan_json"])
    result["snapshot"] = json.loads(row["dataset_manifest_json"])
    result["dataset"] = result["snapshot"]["dataset"]
    if content_hash(result["plan"]) != row["plan_hash"] or content_hash(result["dataset"]) != row["dataset_hash"]:
        raise WorkbenchError("RESEARCH_SNAPSHOT_HASH_MISMATCH")
    return result


def register_experiment(connection, experiment_id, portfolio_id, plan, dataset, actor_id, now=None):
    _actor(actor_id)
    validate_dataset(dataset)
    validate_plan(plan, dataset)
    if dataset["mode"] != "synthetic":
        if not dataset["publication_refs"]:
            raise WorkbenchError("PUBLISHED_MARKET_SNAPSHOT_REQUIRED")
        metadata = {key: value for key, value in dataset.items() if key not in ("observations", "publication_refs")}
        verified = snapshot_from_publications(connection, metadata, dataset["publication_refs"])
        if sorted(verified["observations"], key=lambda row: row["id"]) != sorted(dataset["observations"], key=lambda row: row["id"]):
            raise WorkbenchError("RESEARCH_OBSERVATIONS_DO_NOT_MATCH_PUBLICATIONS")
    plan_hash, dataset_hash = content_hash(plan), content_hash(dataset)
    with transaction(connection):
        old = connection.execute("SELECT * FROM research_experiments WHERE id=?", (experiment_id,)).fetchone()
        if old:
            if old["portfolio_id"] != portfolio_id or old["plan_hash"] != plan_hash or old["dataset_hash"] != dataset_hash:
                raise WorkbenchError("RESEARCH_REGISTRATION_IDEMPOTENCY_CONFLICT")
            return dict(old)
        exposed = [row[0] for row in connection.execute("""SELECT DISTINCT e.id FROM research_experiments e
            JOIN research_holdout_events h ON h.experiment_id=e.id WHERE e.dataset_hash=? AND h.action='unseal'""", (dataset_hash,))]
        snapshot = {"dataset": dataset, "previously_exposed_experiments": exposed,
                    "holdout_unseen_status": "contaminated" if exposed else "not_independently_verified"}
        connection.execute("""INSERT INTO research_experiments
            (id,portfolio_id,plan_json,plan_hash,dataset_manifest_json,dataset_hash,created_by,created_at)
            VALUES(?,?,?,?,?,?,?,?)""",
                           (experiment_id, portfolio_id, canonical_json(plan), plan_hash, canonical_json(snapshot),
                            dataset_hash, actor_id, stamp(now)))
        return dict(connection.execute("SELECT * FROM research_experiments WHERE id=?", (experiment_id,)).fetchone())


def register_trial(connection, experiment_id, phase, parameters, idempotency_key, actor_id, now=None):
    _actor(actor_id)
    if phase not in ("train", "validation", "holdout") or not isinstance(idempotency_key, str) or not idempotency_key:
        raise WorkbenchError("INVALID_RESEARCH_TRIAL_IDENTITY")
    with transaction(connection):
        experiment = _experiment(connection, experiment_id)
        validate_parameters(parameters, experiment["dataset"])
        digest = content_hash(parameters)
        if digest not in {content_hash(item) for item in experiment["plan"]["parameter_candidates"]}:
            raise WorkbenchError("PARAMETERS_OUTSIDE_PREREGISTERED_SEARCH_SPACE")
        existing = connection.execute("SELECT * FROM research_trials WHERE experiment_id=? AND idempotency_key=?", (experiment_id, idempotency_key)).fetchone()
        if existing:
            if existing["parameters_hash"] != digest or existing["phase"] != phase:
                raise WorkbenchError("TRIAL_IDEMPOTENCY_CONFLICT")
            return dict(existing)
        freeze = connection.execute("SELECT * FROM research_holdout_events WHERE experiment_id=? AND action='freeze_candidate'", (experiment_id,)).fetchone()
        if phase == "holdout":
            unsealed = connection.execute("SELECT * FROM research_holdout_events WHERE experiment_id=? AND action='unseal'", (experiment_id,)).fetchone()
            if not freeze or not unsealed or freeze["parameters_hash"] != digest:
                raise WorkbenchError("HOLDOUT_SEALED_OR_CANDIDATE_MISMATCH")
        elif freeze:
            raise WorkbenchError("SEARCH_CLOSED_AFTER_CANDIDATE_FREEZE")
        count = connection.execute("SELECT COUNT(*) FROM research_trials WHERE experiment_id=? AND phase=?", (experiment_id, phase)).fetchone()[0]
        if count >= experiment["plan"]["trial_budgets"][phase]:
            raise WorkbenchError("PREREGISTERED_TRIAL_BUDGET_EXHAUSTED")
        number = connection.execute("SELECT COUNT(*)+1 FROM research_trials WHERE experiment_id=?", (experiment_id,)).fetchone()[0]
        trial_id, run_id = new_id("trial"), new_id("research")
        manifest = {"experiment_id": experiment_id, "dataset_hash": experiment["dataset_hash"], "plan_hash": experiment["plan_hash"],
                    "parameters_hash": digest, "phase": phase,
                    "implementation": implementation_manifest(experiment["plan"]["evaluation_timezone"]), "actor_id": actor_id}
        connection.execute("""INSERT INTO research_runs
            (id,portfolio_id,environment,input_manifest,experiment_plan_json,status,created_at)
            VALUES(?,?,'research',?,?,'queued',?)""",
                           (run_id, experiment["portfolio_id"], canonical_json(manifest), experiment["plan_json"], stamp(now)))
        connection.execute("""INSERT INTO research_trials
            (id,experiment_id,run_id,trial_number,phase,parameters_json,parameters_hash,idempotency_key,created_at)
            VALUES(?,?,?,?,?,?,?,?,?)""",
                           (trial_id, experiment_id, run_id, number, phase, canonical_json(parameters), digest, idempotency_key, stamp(now)))
        return dict(connection.execute("SELECT * FROM research_trials WHERE id=?", (trial_id,)).fetchone())


def prepare_trial(connection, trial_id):
    with transaction(connection, immediate=False):
        trial = connection.execute("SELECT * FROM research_trials WHERE id=?", (trial_id,)).fetchone()
        if trial is None:
            raise WorkbenchError("RESEARCH_TRIAL_NOT_FOUND")
        run = connection.execute("SELECT * FROM research_runs WHERE id=?", (trial["run_id"],)).fetchone()
        if run["status"] in ("succeeded", "failed", "cancelled"):
            raise WorkbenchError("RESEARCH_RUN_ALREADY_TERMINAL")
        if run["status"] != "queued":
            raise WorkbenchError("RESEARCH_RUN_ALREADY_RUNNING")
        experiment = _experiment(connection, trial["experiment_id"])
        parameters = json.loads(trial["parameters_json"])
        if content_hash(parameters) != trial["parameters_hash"]:
            raise WorkbenchError("RESEARCH_PARAMETER_HASH_MISMATCH")
        manifest = json.loads(run["input_manifest"])
        if manifest["implementation"] != implementation_manifest(experiment["plan"]["evaluation_timezone"]):
            raise WorkbenchError("RESEARCH_IMPLEMENTATION_CHANGED_REGISTER_NEW_TRIAL")
    report = compare_backtest(experiment["dataset"], experiment["plan"], parameters, trial["phase"])
    report["experiment_id"], report["trial_id"] = experiment["id"], trial_id
    report["implementation"] = manifest["implementation"]
    report["holdout_exposure"] = experiment["snapshot"]["holdout_unseen_status"]
    report["result_hash"] = content_hash({key: value for key, value in report.items() if key != "result_hash"})
    return PreparedResearch(trial_id, run["id"], run["input_manifest"], canonical_json(report))


def persist_trial(connection, prepared, now=None):
    with transaction(connection):
        run = connection.execute("SELECT * FROM research_runs WHERE id=?", (prepared.run_id,)).fetchone()
        trial = connection.execute("SELECT * FROM research_trials WHERE id=? AND run_id=?", (prepared.trial_id, prepared.run_id)).fetchone()
        if run is None or trial is None or run["input_manifest"] != prepared.input_manifest:
            raise WorkbenchError("RESEARCH_PREPARED_INPUT_MISMATCH")
        if run["status"] == "succeeded":
            if run["result_json"] != prepared.result_json:
                raise WorkbenchError("RESEARCH_NONDETERMINISTIC_REPLAY_CONFLICT")
            return dict(run)
        if run["status"] != "queued":
            raise WorkbenchError("RESEARCH_RUN_NOT_QUEUED")
        report = json.loads(prepared.result_json)
        if content_hash({key: value for key, value in report.items() if key != "result_hash"}) != report["result_hash"]:
            raise WorkbenchError("RESEARCH_RESULT_HASH_MISMATCH")
        manifest = json.loads(run["input_manifest"])
        expected = {key: manifest[key] for key in ("experiment_id", "dataset_hash", "plan_hash", "parameters_hash", "phase", "implementation")}
        expected["trial_id"] = trial["id"]
        if any(report.get(key) != value for key, value in expected.items()) or report.get("live_advice_eligible") is not False:
            raise WorkbenchError("RESEARCH_RESULT_INPUT_BINDING_MISMATCH")
        if manifest["implementation"] != implementation_manifest(json.loads(run["experiment_plan_json"])["evaluation_timezone"]):
            raise WorkbenchError("RESEARCH_IMPLEMENTATION_CHANGED_DURING_COMPUTATION")
        connection.execute("UPDATE research_runs SET status='running' WHERE id=?", (run["id"],))
        for sequence, event in enumerate(report["strategy"]["events"]):
            connection.execute("""INSERT INTO simulation_events
                (id,run_id,environment,sequence,event_type,effective_at,payload_json)
                VALUES(?,?,'research',?,?,?,?)""",
                               (new_id("simulation"), run["id"], sequence, event["type"], event["at"], canonical_json(event)))
        connection.execute("UPDATE research_runs SET status='succeeded',result_json=?,completed_at=? WHERE id=?",
                           (prepared.result_json, stamp(now), run["id"]))
        return dict(connection.execute("SELECT * FROM research_runs WHERE id=?", (run["id"],)).fetchone())


def record_trial_failure(connection, trial_id, error, now=None):
    with transaction(connection):
        run = connection.execute("SELECT r.* FROM research_trials t JOIN research_runs r ON r.id=t.run_id WHERE t.id=?", (trial_id,)).fetchone()
        if run is None:
            raise WorkbenchError("RESEARCH_TRIAL_NOT_FOUND")
        if run["status"] != "queued":
            return dict(run)
        connection.execute("UPDATE research_runs SET status='failed',result_json=?,completed_at=? WHERE id=?",
                           (canonical_json({"error": type(error).__name__, "code": str(error)}), stamp(now), run["id"]))
        return dict(connection.execute("SELECT * FROM research_runs WHERE id=?", (run["id"],)).fetchone())


def run_trial(connection, trial_id, now=None):
    existing = connection.execute("SELECT r.* FROM research_trials t JOIN research_runs r ON r.id=t.run_id WHERE t.id=?", (trial_id,)).fetchone()
    if existing is not None and existing["status"] in ("succeeded", "failed", "cancelled"):
        return dict(existing)
    try:
        return persist_trial(connection, prepare_trial(connection, trial_id), now=now)
    except Exception as exc:
        record_trial_failure(connection, trial_id, exc, now=now)
        raise


def freeze_candidate(connection, experiment_id, validation_trial_id, actor_id, evidence, now=None):
    _actor(actor_id)
    if not isinstance(evidence, str) or not evidence.strip():
        raise WorkbenchError("CANDIDATE_SELECTION_EVIDENCE_REQUIRED")
    with transaction(connection):
        _experiment(connection, experiment_id)
        trial = connection.execute("""SELECT t.*,r.status FROM research_trials t JOIN research_runs r ON r.id=t.run_id
            WHERE t.id=? AND t.experiment_id=? AND t.phase='validation'""", (validation_trial_id, experiment_id)).fetchone()
        if trial is None or trial["status"] != "succeeded":
            raise WorkbenchError("SUCCESSFUL_VALIDATION_TRIAL_REQUIRED")
        trained = connection.execute("""SELECT 1 FROM research_trials t JOIN research_runs r ON r.id=t.run_id
            WHERE t.experiment_id=? AND t.phase='train' AND t.parameters_hash=? AND r.status='succeeded'""",
                                     (experiment_id, trial["parameters_hash"])).fetchone()
        if not trained:
            raise WorkbenchError("MATCHING_SUCCESSFUL_TRAIN_TRIAL_REQUIRED")
        existing = connection.execute("SELECT * FROM research_holdout_events WHERE experiment_id=? AND action='freeze_candidate'", (experiment_id,)).fetchone()
        if existing:
            if existing["trial_id"] != validation_trial_id:
                raise WorkbenchError("CANDIDATE_ALREADY_FROZEN")
            return dict(existing)
        unfinished = connection.execute("""SELECT 1 FROM research_trials t JOIN research_runs r ON r.id=t.run_id
            WHERE t.experiment_id=? AND t.phase IN ('train','validation') AND r.status IN ('queued','running')""",
                                        (experiment_id,)).fetchone()
        if unfinished:
            raise WorkbenchError("UNFINISHED_SEARCH_TRIALS_BLOCK_CANDIDATE_FREEZE")
        event_id = new_id("holdout")
        connection.execute("""INSERT INTO research_holdout_events
            (id,experiment_id,trial_id,action,parameters_hash,actor_id,evidence_json,created_at)
            VALUES(?,?,?,'freeze_candidate',?,?,?,?)""",
                           (event_id, experiment_id, validation_trial_id, trial["parameters_hash"], actor_id, canonical_json({"reason": evidence}), stamp(now)))
        return dict(connection.execute("SELECT * FROM research_holdout_events WHERE id=?", (event_id,)).fetchone())


def unseal_holdout(connection, experiment_id, actor_id, evidence, now=None):
    _actor(actor_id)
    if not isinstance(evidence, str) or not evidence.strip():
        raise WorkbenchError("HOLDOUT_UNSEAL_EVIDENCE_REQUIRED")
    with transaction(connection):
        frozen = connection.execute("SELECT * FROM research_holdout_events WHERE experiment_id=? AND action='freeze_candidate'", (experiment_id,)).fetchone()
        if not frozen:
            raise WorkbenchError("CANDIDATE_NOT_FROZEN")
        existing = connection.execute("SELECT * FROM research_holdout_events WHERE experiment_id=? AND action='unseal'", (experiment_id,)).fetchone()
        if existing:
            return dict(existing)
        event_id = new_id("holdout")
        connection.execute("""INSERT INTO research_holdout_events
            (id,experiment_id,trial_id,action,parameters_hash,actor_id,evidence_json,created_at)
            VALUES(?,?,?,'unseal',?,?,?,?)""",
                           (event_id, experiment_id, frozen["trial_id"], frozen["parameters_hash"], actor_id, canonical_json({"reason": evidence}), stamp(now)))
        return dict(connection.execute("SELECT * FROM research_holdout_events WHERE id=?", (event_id,)).fetchone())
