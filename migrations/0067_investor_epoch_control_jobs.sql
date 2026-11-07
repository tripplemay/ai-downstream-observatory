-- Frozen owner activation intents; saving an intent does not enable monitoring.
CREATE TABLE investor_epoch_control_requests (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, epoch_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision>=1),
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL,
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(epoch_id,workspace_id,model_id) REFERENCES investor_model_epochs(id,workspace_id,model_id),
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,idempotency_key),
  CHECK(julianday(valid_until)>julianday(created_at) AND julianday(valid_until)-julianday(created_at)<=0.003472223),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-epoch-control-request-v1'
    AND json_extract(document_json,'$.request_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id
    AND json_extract(document_json,'$.model_id') IS model_id AND json_extract(document_json,'$.epoch_id') IS epoch_id
    AND json_extract(document_json,'$.actor_id') IS actor_id AND json_extract(document_json,'$.body.enabled') IS 1
    AND json_extract(document_json,'$.body.epoch_id') IS epoch_id AND json_extract(document_json,'$.body.expected_revision') IS expected_revision
    AND json_extract(document_json,'$.body.idempotency_key') IS idempotency_key AND json_extract(document_json,'$.request_hash') IS request_hash
    AND json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until
    AND json_extract(document_json,'$.trading_permission') IS 0)
);
CREATE TABLE investor_epoch_control_results (
  id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id), fencing_token INTEGER NOT NULL CHECK(fencing_token>=1),
  outcome TEXT NOT NULL CHECK(outcome IN ('applied','rejected')), code TEXT NOT NULL,
  control_id TEXT REFERENCES investor_epoch_controls(id),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(request_id,workspace_id) REFERENCES investor_epoch_control_requests(id,workspace_id),
  CHECK((outcome='applied' AND control_id IS NOT NULL AND code='EPOCH_CONTROL_APPLIED') OR (outcome='rejected' AND control_id IS NULL AND code!='EPOCH_CONTROL_APPLIED')),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-epoch-control-result-v1'
    AND json_extract(document_json,'$.result_id') IS id AND json_extract(document_json,'$.request_id') IS request_id
    AND json_extract(document_json,'$.workspace_id') IS workspace_id AND json_extract(document_json,'$.actor_id') IS actor_id
    AND json_extract(document_json,'$.job_id') IS job_id AND json_extract(document_json,'$.fencing_token') IS fencing_token
    AND json_extract(document_json,'$.outcome') IS outcome AND json_extract(document_json,'$.code') IS code
    AND json_extract(document_json,'$.control_id') IS control_id AND json_extract(document_json,'$.created_at') IS created_at
    AND json_extract(document_json,'$.trading_permission') IS 0)
);
CREATE TRIGGER investor_epoch_control_request_insert BEFORE INSERT ON investor_epoch_control_requests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_epoch_control_requests WHERE id=NEW.id OR (workspace_id=NEW.workspace_id AND idempotency_key=NEW.idempotency_key) OR audit_id=NEW.audit_id)
    OR NEW.expected_revision IS NOT (SELECT revision FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NOT EXISTS(SELECT 1 FROM investor_model_epochs e JOIN audit_events a ON a.id=NEW.audit_id
      WHERE e.id=NEW.epoch_id AND e.workspace_id=NEW.workspace_id AND e.model_id=NEW.model_id AND e.actor_id=NEW.actor_id
        AND e.created_at<=NEW.created_at AND NEW.valid_until<=e.valid_until
        AND json_extract(NEW.document_json,'$.body.expected_registration_hash') IS e.content_hash
        AND json_extract(NEW.document_json,'$.body.expected_checkpoint.id') IS (SELECT id FROM investor_evidence_model_checkpoints WHERE model_id=NEW.model_id ORDER BY sequence DESC LIMIT 1)
        AND json_extract(NEW.document_json,'$.body.expected_checkpoint.content_hash') IS (SELECT content_hash FROM investor_evidence_model_checkpoints WHERE model_id=NEW.model_id ORDER BY sequence DESC LIMIT 1)
        AND a.actor_id=NEW.actor_id AND a.action='investor_request_epoch_control' AND a.object_type='investor_epoch_control_request'
        AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'epoch control request binding differs') END;
END;
CREATE TRIGGER investor_epoch_control_result_insert BEFORE INSERT ON investor_epoch_control_results BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_epoch_control_results WHERE id=NEW.id OR request_id=NEW.request_id OR job_id=NEW.job_id OR audit_id=NEW.audit_id)
    OR NOT EXISTS(SELECT 1 FROM investor_epoch_control_requests r JOIN job_runs j ON j.id=NEW.job_id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id AND r.actor_id=NEW.actor_id AND r.created_at<=NEW.created_at
        AND json_extract(NEW.document_json,'$.request_hash') IS r.content_hash
        AND julianday(json_extract(NEW.document_json,'$.valid_until'))<=julianday(r.valid_until)
        AND j.job_type='investor_epoch_control' AND j.scope=NEW.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
        AND j.command_request_id IS NULL AND j.status='running' AND j.max_attempts=1 AND j.attempt_count=1 AND j.fencing_token=NEW.fencing_token
        AND a.actor_id=NEW.actor_id AND a.action='investor_finish_epoch_control' AND a.object_type='investor_epoch_control_result'
        AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    OR (NEW.outcome='applied' AND NOT EXISTS(SELECT 1 FROM investor_epoch_controls c JOIN investor_epoch_control_requests r ON r.id=NEW.request_id
      WHERE c.id=NEW.control_id AND c.workspace_id=NEW.workspace_id AND c.epoch_id=r.epoch_id AND c.actor_id=NEW.actor_id AND c.enabled=1
        AND c.content_hash IS json_extract(NEW.document_json,'$.control_hash') AND json(c.document_json->'$.body') IS json(r.document_json->'$.body')
        AND NEW.created_at<json_extract(NEW.document_json,'$.valid_until') AND c.created_at<=NEW.created_at))
    THEN RAISE(ABORT,'epoch control result binding differs') END;
END;
CREATE TRIGGER investor_epoch_control_request_update BEFORE UPDATE ON investor_epoch_control_requests BEGIN SELECT RAISE(ABORT,'epoch control request immutable'); END;
CREATE TRIGGER investor_epoch_control_request_delete BEFORE DELETE ON investor_epoch_control_requests BEGIN SELECT RAISE(ABORT,'epoch control request immutable'); END;
CREATE TRIGGER investor_epoch_control_result_update BEFORE UPDATE ON investor_epoch_control_results BEGIN SELECT RAISE(ABORT,'epoch control result immutable'); END;
CREATE TRIGGER investor_epoch_control_result_delete BEFORE DELETE ON investor_epoch_control_results BEGIN SELECT RAISE(ABORT,'epoch control result immutable'); END;
