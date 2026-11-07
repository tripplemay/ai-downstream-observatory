"""Owner acknowledgement preserves unknown outcomes; it never retries an old call."""
from datetime import timedelta
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError,canonical_json,content_hash,instant
from .data_evidence import _audit_binding,_object,_owner,_milliseconds

SCHEMA="investor-epoch-history-resolution.schema.json"
JOB_FIELDS=("id","job_type","scope","period","input_version","command_request_id","status","lease_owner","lease_until","fencing_token","attempt_count","max_attempts","not_before","created_at","updated_at","result_json")
ATTEMPT_FIELDS=("job_id","attempt","fencing_token","status","started_at","finished_at","error_json")
TERMINAL=("succeeded","failed","skipped","cancelled")

def _check(value,code="CHANGED"):
    if not value:raise WorkbenchError("HISTORY_RESOLUTION_"+code)

def unknown_state(db,workspace,actor,slot_id,at):
    from . import epoch_history_jobs as history,epoch_continuation as epochs
    _owner(db,workspace,actor)
    slot,parent,doc,tile=history.slot_header(db,workspace,slot_id,at)
    marker=db.execute("SELECT * FROM investor_epoch_history_attempts WHERE slot_id=?",(slot_id,)).fetchone();_check(marker is not None,"NOT_UNKNOWN")
    reserved=history._attempt_header(db,marker,at)
    _check(marker["workspace_id"]==workspace and marker["model_id"]==parent["model_id"] and marker["actor_id"]==actor
        and reserved["slot"]==epochs._ref(slot) and reserved["request"]==epochs._ref(parent),"CHANGED")
    slots=db.execute("SELECT * FROM investor_epoch_history_slots WHERE request_id=? ORDER BY slot_index",(parent["id"],)).fetchall()
    _check(len(slots)==parent["authorized_calls"]);entries=[];terminal=True;available=instant(parent["valid_until"])
    for item in slots:
        history.slot_header(db,workspace,item["id"],at)
        job=db.execute("SELECT * FROM job_runs WHERE job_type=? AND scope=? AND period=? AND input_version=?",(history.JOB_TYPE,workspace,item["id"],item["content_hash"])).fetchone()
        _check(job and job["command_request_id"] is None and job["max_attempts"]==1 and job["attempt_count"] in (0,1))
        attempt=db.execute("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1",(job["id"],)).fetchone()
        done=job["status"] in TERMINAL and job["lease_owner"] is None and job["lease_until"] is None
        if job["attempt_count"]:
            _check(attempt is not None)
            _check(instant(job["created_at"])<=instant(attempt["started_at"]))
            expired=job["status"]=="failed" and attempt["status"]=="lease_expired" and job["fencing_token"]==attempt["fencing_token"]+1
            if expired:_check(_object(attempt["error_json"])==_object(job["result_json"])=={"code":"LEASE_EXPIRED"})
            else:_check(attempt["fencing_token"]==job["fencing_token"])
            if done:_check((attempt["status"]==job["status"] or expired) and attempt["finished_at"]==job["updated_at"] and instant(attempt["finished_at"])<=instant(at))
        else:_check(attempt is None)
        run=db.execute("SELECT * FROM investor_epoch_history_runs WHERE slot_id=?",(item["id"],)).fetchone()
        if run:history._run_header(db,run,at)
        if item["id"]==slot_id:
            _check(marker["job_id"]==job["id"] and attempt and marker["fencing_token"]==attempt["fencing_token"] and job["attempt_count"]==1)
            _check(epochs._job_started_by_millisecond(attempt["started_at"],marker["created_at"]))
            _check(not run or run["status"]=="transport_unknown","NOT_UNKNOWN")
            _check(job["status"]!="succeeded","NOT_UNKNOWN")
        terminal=terminal and done;available=max(available,instant(job["updated_at"]))
        entries.append({"slot":epochs._ref(item),"job":{k:job[k] for k in JOB_FIELDS},"attempt":{k:attempt[k] for k in ATTEMPT_FIELDS} if attempt else None,"run":epochs._ref(run) if run else None})
    snapshot={"batch":epochs._ref(parent),"slot":epochs._ref(slot),"attempt":epochs._ref(marker),"jobs":entries}
    available+=timedelta(seconds=30,microseconds=(-available.microsecond)%1000)
    return {"state_hash":content_hash(snapshot),"batch":snapshot["batch"],"slot":snapshot["slot"],"attempt":snapshot["attempt"],"model_id":parent["model_id"],
        "available_after":_milliseconds(available),"terminal":terminal,"tile":tile}

def read_resolution(db,workspace,actor,slot_id,at):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='investor_epoch_history_resolutions'").fetchone():return None
    row=db.execute("SELECT * FROM investor_epoch_history_resolutions WHERE workspace_id=? AND slot_id=?",(workspace,slot_id)).fetchone()
    if row is None:return None
    _owner(db,workspace,actor);doc=_object(row["document_json"]);validate_contract(doc,SCHEMA,fragment="$defs/record");body=doc["body"]
    _audit_binding(db,row,"investor_acknowledge_history_unknown","investor_history_resolution",row["id"])
    state=unknown_state(db,workspace,actor,slot_id,at)
    _check(canonical_json(doc)==row["document_json"] and content_hash(doc)==row["content_hash"] and doc["resolution_id"]==row["id"] and doc["request_hash"]==content_hash(body)
        and all(doc[k]==row[k] for k in ("workspace_id","model_id","actor_id","request_hash","created_at")) and row["actor_id"]==actor
        and body["model_id"]==row["model_id"] and body["idempotency_key"]==row["idempotency_key"] and body["expected_revision"]==row["expected_revision"]
        and body["batch"]["id"]==row["batch_id"] and body["slot"]["id"]==row["slot_id"] and body["attempt"]["id"]==row["attempt_id"]
        and all(body[k]==state[k] for k in ("batch","slot","attempt","state_hash")) and state["terminal"]
        and instant(state["available_after"])<=instant(body["reviewed_at"])<=instant(row["created_at"])<instant(body["valid_until"])
        and 0<(instant(body["valid_until"])-instant(body["reviewed_at"])).total_seconds()<=300 and instant(row["created_at"])<=instant(at))
    return row,doc
