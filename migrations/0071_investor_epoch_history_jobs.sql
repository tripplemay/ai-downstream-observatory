CREATE TABLE investor_epoch_history_requests (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, epoch_id TEXT NOT NULL, activation_id TEXT NOT NULL, control_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=0), idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 160),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'), authorized_calls INTEGER NOT NULL CHECK(authorized_calls BETWEEN 1 AND 4),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=139264),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'), actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>created_at),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id), UNIQUE(workspace_id,idempotency_key), UNIQUE(id,workspace_id,model_id),
  FOREIGN KEY(model_id,workspace_id) REFERENCES investor_models(id,workspace_id),
  FOREIGN KEY(epoch_id,workspace_id,model_id) REFERENCES investor_model_epochs(id,workspace_id,model_id),
  FOREIGN KEY(activation_id,workspace_id,model_id) REFERENCES investor_epoch_controls(id,workspace_id,model_id),
  FOREIGN KEY(control_id,workspace_id,model_id) REFERENCES investor_model_controls(id,workspace_id,model_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-epoch-history-request-v1'),
  CHECK(json_extract(document_json,'$.request_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id AND json_extract(document_json,'$.model_id') IS model_id),
  CHECK(json_extract(document_json,'$.actor_id') IS actor_id AND json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until),
  CHECK(json_extract(document_json,'$.request_hash') IS request_hash AND json_extract(document_json,'$.authorized_calls') IS authorized_calls AND json_extract(document_json,'$.trading_permission') IS 0),
  CHECK(json_extract(document_json,'$.body.epoch_id') IS epoch_id AND json_extract(document_json,'$.body.idempotency_key') IS idempotency_key AND json_extract(document_json,'$.body.expected_revision') IS expected_revision),
  CHECK(json_extract(document_json,'$.plan.epoch.id') IS epoch_id AND json_extract(document_json,'$.plan.activation.id') IS activation_id AND json_extract(document_json,'$.plan.model_control.id') IS control_id),
  CHECK(json_extract(document_json,'$.plan.plan_hash') IS json_extract(document_json,'$.body.expected_plan_hash') AND json_extract(document_json,'$.plan.workspace_revision') IS expected_revision),
  CHECK(json_extract(document_json,'$.plan.status') IS 'download_confirmation_required' AND json_extract(document_json,'$.plan.future_calls_authorized') IS 0),
  CHECK(json_extract(document_json,'$.body.acknowledgements.historical_not_live') IS 1 AND json_extract(document_json,'$.body.acknowledgements.old_attempts_unchanged') IS 1
    AND json_extract(document_json,'$.body.acknowledgements.bounded_download_only') IS 1 AND json_extract(document_json,'$.body.acknowledgements.no_trading') IS 1),
  CHECK(authorized_calls=min(json_extract(document_json,'$.body.max_calls'),json_array_length(document_json,'$.plan.tiles')))
);
CREATE TABLE investor_epoch_history_slots (
  id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL,
  slot_index INTEGER NOT NULL CHECK(slot_index BETWEEN 0 AND 3), listing_id TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL CHECK(end_date>=start_date),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'), actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id), UNIQUE(request_id,slot_index), UNIQUE(id,workspace_id,model_id),
  FOREIGN KEY(request_id,workspace_id,model_id) REFERENCES investor_epoch_history_requests(id,workspace_id,model_id)
);
CREATE INDEX investor_epoch_history_overlap ON investor_epoch_history_slots(workspace_id,listing_id,start_date,end_date);
CREATE TABLE investor_epoch_history_attempts (
  id TEXT PRIMARY KEY NOT NULL, slot_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id), fencing_token INTEGER NOT NULL CHECK(fencing_token>0),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=4096),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'), actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(slot_id,workspace_id,model_id) REFERENCES investor_epoch_history_slots(id,workspace_id,model_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-epoch-history-attempt-v1'),
  CHECK(json_extract(document_json,'$.attempt_id') IS id AND json_extract(document_json,'$.slot.id') IS slot_id AND json_extract(document_json,'$.job_id') IS job_id),
  CHECK(json_extract(document_json,'$.fencing_token') IS fencing_token AND json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_extract(document_json,'$.network_outcome_known') IS 0 AND json_extract(document_json,'$.trading_permission') IS 0)
);
CREATE TABLE investor_epoch_history_runs (
  id TEXT PRIMARY KEY NOT NULL, slot_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id),
  attempt_id TEXT UNIQUE REFERENCES investor_epoch_history_attempts(id), capture_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('collected','already_available','superseded','blocked_predecessor','transport_unknown')),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=8192),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'), actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(slot_id,workspace_id,model_id) REFERENCES investor_epoch_history_slots(id,workspace_id,model_id), FOREIGN KEY(capture_id,workspace_id) REFERENCES investor_price_captures(id,workspace_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-epoch-history-run-v1'),
  CHECK(json_extract(document_json,'$.run_id') IS id AND json_extract(document_json,'$.slot.id') IS slot_id AND json_extract(document_json,'$.job_id') IS job_id),
  CHECK(json_extract(document_json,'$.attempt_id') IS attempt_id AND json_extract(document_json,'$.capture_id') IS capture_id AND json_extract(document_json,'$.status') IS status),
  CHECK(json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.trading_permission') IS 0),
  CHECK((attempt_id IS NOT NULL)=(status IN ('collected','transport_unknown')) AND (capture_id IS NOT NULL)=(status='collected')),
  CHECK((json_extract(document_json,'$.receipt_hash') IS NOT NULL)=(capture_id IS NOT NULL)),
  CHECK((json_extract(document_json,'$.source_fence') IS NOT NULL)=(status IN ('collected','already_available'))),
  CHECK(json_extract(document_json,'$.code') IS 'EPOCH_HISTORY_'||upper(status))
);
CREATE TRIGGER investor_epoch_history_request_insert BEFORE INSERT ON investor_epoch_history_requests BEGIN
  SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NEW.expected_revision IS NOT (SELECT revision FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NOT EXISTS(SELECT 1 FROM investor_model_epochs e JOIN investor_epoch_controls c ON c.epoch_id=e.id AND c.workspace_id=e.workspace_id AND c.model_id=e.model_id
      JOIN investor_models m ON m.id=e.model_id AND m.workspace_id=e.workspace_id
      JOIN investor_model_controls g ON g.id=NEW.control_id AND g.workspace_id=e.workspace_id AND g.model_id=e.model_id
      WHERE e.id=NEW.epoch_id AND e.workspace_id=NEW.workspace_id AND e.model_id=NEW.model_id AND c.id=NEW.activation_id
        AND c.enabled=1 AND c.valid_until>=NEW.valid_until AND c.created_at<=NEW.created_at AND c.version=(SELECT max(version) FROM investor_epoch_controls WHERE epoch_id=e.id)
        AND g.enabled=1 AND g.created_at<=NEW.created_at AND g.version=(SELECT max(version) FROM investor_model_controls WHERE model_id=e.model_id)
        AND e.content_hash IS json_extract(NEW.document_json,'$.plan.registration_hash') AND c.content_hash IS json_extract(NEW.document_json,'$.plan.activation.content_hash')
        AND m.content_hash IS json_extract(NEW.document_json,'$.plan.model_hash'))
    OR NOT EXISTS(SELECT 1 FROM audit_events WHERE id=NEW.audit_id AND actor_id=NEW.actor_id AND action='investor_confirm_epoch_history' AND object_type='investor_epoch_history_request'
      AND object_id=NEW.id AND created_at=NEW.created_at AND json_extract(payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'epoch history request binding differs') END;
END;
CREATE TRIGGER investor_epoch_history_slot_insert BEFORE INSERT ON investor_epoch_history_slots BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM investor_epoch_history_requests r WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id AND r.model_id=NEW.model_id
    AND r.actor_id=NEW.actor_id AND r.created_at=NEW.created_at AND NEW.slot_index<r.authorized_calls
    AND NEW.listing_id IS json_extract(r.document_json,'$.plan.tiles['||NEW.slot_index||'].listing_id')
    AND NEW.start_date IS json_extract(r.document_json,'$.plan.tiles['||NEW.slot_index||'].start_date') AND NEW.end_date IS json_extract(r.document_json,'$.plan.tiles['||NEW.slot_index||'].end_date'))
    OR NOT EXISTS(SELECT 1 FROM audit_events WHERE id=NEW.audit_id AND actor_id=NEW.actor_id AND action='investor_queue_epoch_history' AND object_type='investor_epoch_history_slot'
      AND object_id=NEW.id AND created_at=NEW.created_at AND json_extract(payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'epoch history slot binding differs') END;
END;
CREATE TRIGGER investor_epoch_history_attempt_insert BEFORE INSERT ON investor_epoch_history_attempts BEGIN
  SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NOT EXISTS(SELECT 1 FROM investor_epoch_history_slots s JOIN investor_epoch_history_requests r ON r.id=s.request_id
      JOIN job_runs j ON j.period=s.id AND j.scope=s.workspace_id AND j.input_version=s.content_hash
      JOIN job_attempts a ON a.job_id=j.id AND a.attempt=j.attempt_count AND a.fencing_token=j.fencing_token
      WHERE s.id=NEW.slot_id AND s.workspace_id=NEW.workspace_id AND s.model_id=NEW.model_id AND r.actor_id=NEW.actor_id
        AND j.id=NEW.job_id AND j.job_type='investor_epoch_history' AND j.status='running' AND j.command_request_id IS NULL AND j.max_attempts=1 AND j.attempt_count=1
        AND j.fencing_token=NEW.fencing_token AND j.lease_until>NEW.created_at AND a.status='running' AND a.finished_at IS NULL AND (substr(a.started_at,1,23)||'Z')<=NEW.created_at
        AND r.valid_until>NEW.created_at AND r.valid_until IS json_extract(NEW.document_json,'$.valid_until')
        AND s.content_hash IS json_extract(NEW.document_json,'$.slot.content_hash') AND r.id IS json_extract(NEW.document_json,'$.request.id') AND r.content_hash IS json_extract(NEW.document_json,'$.request.content_hash'))
    OR NOT EXISTS(SELECT 1 FROM audit_events WHERE id=NEW.audit_id AND actor_id=NEW.actor_id AND action='investor_reserve_epoch_history' AND object_type='investor_epoch_history_attempt'
      AND object_id=NEW.id AND created_at=NEW.created_at AND json_extract(payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'epoch history attempt binding differs') END;
END;
CREATE TRIGGER investor_epoch_history_run_insert BEFORE INSERT ON investor_epoch_history_runs BEGIN
  SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NOT EXISTS(SELECT 1 FROM investor_epoch_history_slots s JOIN investor_epoch_history_requests r ON r.id=s.request_id
      JOIN job_runs j ON j.period=s.id AND j.scope=s.workspace_id AND j.input_version=s.content_hash
      JOIN job_attempts a ON a.job_id=j.id AND a.attempt=j.attempt_count AND a.fencing_token=j.fencing_token
      WHERE s.id=NEW.slot_id AND s.workspace_id=NEW.workspace_id AND s.model_id=NEW.model_id AND r.actor_id=NEW.actor_id
        AND j.id=NEW.job_id AND j.job_type='investor_epoch_history' AND j.status='running' AND j.command_request_id IS NULL AND j.max_attempts=1 AND j.attempt_count=1
        AND json_extract(NEW.document_json,'$.fencing_token')=j.fencing_token AND j.lease_until>NEW.created_at AND a.status='running' AND a.finished_at IS NULL
        AND (substr(a.started_at,1,23)||'Z')<=NEW.created_at AND r.created_at<=NEW.created_at
        AND r.valid_until IS json_extract(NEW.document_json,'$.valid_until') AND s.content_hash IS json_extract(NEW.document_json,'$.slot.content_hash')
        AND r.id IS json_extract(NEW.document_json,'$.request.id') AND r.content_hash IS json_extract(NEW.document_json,'$.request.content_hash'))
    OR (NEW.attempt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM investor_epoch_history_attempts WHERE id=NEW.attempt_id AND slot_id=NEW.slot_id AND workspace_id=NEW.workspace_id
      AND model_id=NEW.model_id AND job_id=NEW.job_id AND created_at<=NEW.created_at AND fencing_token=json_extract(NEW.document_json,'$.fencing_token')))
    OR (NEW.capture_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM investor_price_captures c JOIN investor_epoch_history_slots s ON s.id=NEW.slot_id
      JOIN investor_epoch_history_requests r ON r.id=s.request_id WHERE c.id=NEW.capture_id AND c.workspace_id=NEW.workspace_id AND c.qualification='isolated_official_sdk'
        AND c.receipt_hash IS json_extract(NEW.document_json,'$.receipt_hash') AND c.created_at<=NEW.created_at
        AND json_extract(c.receipt_json,'$.request.mapping.listing_id') IS s.listing_id AND json_extract(c.receipt_json,'$.request.start_date') IS s.start_date AND json_extract(c.receipt_json,'$.request.end_date') IS s.end_date
        AND c.rights_review_id IS json_extract(r.document_json,'$.plan.tiles['||s.slot_index||'].rights_review_id') AND c.listing_review_id IS json_extract(r.document_json,'$.plan.tiles['||s.slot_index||'].listing_review_id')
        AND c.calendar_review_id IS json_extract(r.document_json,'$.plan.tiles['||s.slot_index||'].calendar_review_id')))
    OR NOT EXISTS(SELECT 1 FROM audit_events WHERE id=NEW.audit_id AND actor_id=NEW.actor_id AND action='investor_finish_epoch_history' AND object_type='investor_epoch_history_run'
      AND object_id=NEW.id AND created_at=NEW.created_at AND json_extract(payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'epoch history run binding differs') END;
END;
CREATE TRIGGER investor_epoch_history_request_update BEFORE UPDATE ON investor_epoch_history_requests BEGIN SELECT RAISE(ABORT,'epoch history request is immutable'); END;
CREATE TRIGGER investor_epoch_history_request_delete BEFORE DELETE ON investor_epoch_history_requests BEGIN SELECT RAISE(ABORT,'epoch history request is immutable'); END;
CREATE TRIGGER investor_epoch_history_slot_update BEFORE UPDATE ON investor_epoch_history_slots BEGIN SELECT RAISE(ABORT,'epoch history slot is immutable'); END;
CREATE TRIGGER investor_epoch_history_slot_delete BEFORE DELETE ON investor_epoch_history_slots BEGIN SELECT RAISE(ABORT,'epoch history slot is immutable'); END;
CREATE TRIGGER investor_epoch_history_attempt_update BEFORE UPDATE ON investor_epoch_history_attempts BEGIN SELECT RAISE(ABORT,'epoch history attempt is immutable'); END;
CREATE TRIGGER investor_epoch_history_attempt_delete BEFORE DELETE ON investor_epoch_history_attempts BEGIN SELECT RAISE(ABORT,'epoch history attempt is immutable'); END;
CREATE TRIGGER investor_epoch_history_run_update BEFORE UPDATE ON investor_epoch_history_runs BEGIN SELECT RAISE(ABORT,'epoch history run is immutable'); END;
CREATE TRIGGER investor_epoch_history_run_delete BEFORE DELETE ON investor_epoch_history_runs BEGIN SELECT RAISE(ABORT,'epoch history run is immutable'); END;
