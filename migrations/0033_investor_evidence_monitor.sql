CREATE TABLE investor_evidence_model_checkpoints (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, input_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 1000), previous_hash TEXT,
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  projection_hash TEXT NOT NULL CHECK(length(projection_hash)=64 AND projection_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>created_at),
  FOREIGN KEY(model_id,workspace_id) REFERENCES investor_models(id,workspace_id),
  FOREIGN KEY(input_id,workspace_id,model_id) REFERENCES investor_monitor_evidence_inputs(id,workspace_id,model_id),
  UNIQUE(model_id,sequence), UNIQUE(id,workspace_id,model_id)
);
CREATE TABLE investor_evidence_checkpoint_payloads (
  checkpoint_id TEXT PRIMARY KEY NOT NULL REFERENCES investor_evidence_model_checkpoints(id),
  payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload) BETWEEN 1 AND 4194304)
);
CREATE TABLE investor_evidence_monitor_requests (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, control_id TEXT NOT NULL,
  input_id TEXT NOT NULL, checkpoint_id TEXT, period TEXT NOT NULL,
  request_key TEXT NOT NULL CHECK(length(request_key)=64 AND request_key NOT GLOB '*[^a-f0-9]*'),
  input_version TEXT NOT NULL CHECK(length(input_version)=64 AND input_version NOT GLOB '*[^a-f0-9]*'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=4096),
  created_at TEXT NOT NULL,
  FOREIGN KEY(model_id,workspace_id) REFERENCES investor_models(id,workspace_id),
  FOREIGN KEY(control_id,workspace_id,model_id) REFERENCES investor_model_controls(id,workspace_id,model_id),
  FOREIGN KEY(input_id,workspace_id,model_id) REFERENCES investor_monitor_evidence_inputs(id,workspace_id,model_id),
  FOREIGN KEY(checkpoint_id,workspace_id,model_id) REFERENCES investor_evidence_model_checkpoints(id,workspace_id,model_id),
  UNIQUE(model_id,period,request_key), UNIQUE(id,workspace_id,model_id)
);
CREATE TABLE investor_evidence_monitor_runs (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id), observation_id TEXT NOT NULL UNIQUE, checkpoint_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('blocked','observe','decision_required')),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=8192),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>=created_at),
  FOREIGN KEY(request_id,workspace_id,model_id) REFERENCES investor_evidence_monitor_requests(id,workspace_id,model_id),
  FOREIGN KEY(observation_id,workspace_id) REFERENCES investor_observations(id,workspace_id),
  FOREIGN KEY(checkpoint_id,workspace_id,model_id) REFERENCES investor_evidence_model_checkpoints(id,workspace_id,model_id),
  CHECK(json_extract(document_json,'$.request_id') IS request_id), CHECK(json_extract(document_json,'$.model_id') IS model_id),
  CHECK(json_extract(document_json,'$.status') IS status), CHECK(json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_extract(document_json,'$.valid_until') IS valid_until), CHECK(json_extract(document_json,'$.live_advice_eligible') IS 0),
  CHECK(json_type(document_json,'$.quotes') IS NULL AND json_type(document_json,'$.fx') IS NULL AND json_type(document_json,'$.result') IS NULL)
);
CREATE TABLE investor_evidence_run_payloads (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES investor_evidence_monitor_runs(id),
  payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload) BETWEEN 1 AND 1048576)
);
CREATE TABLE investor_monitor_payload_purges (
  kind TEXT NOT NULL CHECK(kind IN ('checkpoint','run')), entity_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, reason TEXT NOT NULL CHECK(reason IN ('retention_expired','source_unavailable')),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  PRIMARY KEY(kind,entity_id), FOREIGN KEY(model_id,workspace_id) REFERENCES investor_models(id,workspace_id)
);
CREATE INDEX investor_evidence_request_latest ON investor_evidence_monitor_requests(model_id,created_at DESC);
CREATE TRIGGER investor_evidence_checkpoint_insert BEFORE INSERT ON investor_evidence_model_checkpoints BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_evidence_model_checkpoints WHERE id=NEW.id OR (model_id=NEW.model_id AND sequence=NEW.sequence))
    OR NEW.sequence IS NOT (SELECT COALESCE(MAX(sequence),0)+1 FROM investor_evidence_model_checkpoints WHERE model_id=NEW.model_id)
    OR NEW.previous_hash IS NOT (SELECT content_hash FROM investor_evidence_model_checkpoints WHERE model_id=NEW.model_id ORDER BY sequence DESC LIMIT 1)
    OR NEW.projection_hash IS NOT (SELECT json_extract(document_json,'$.projection_hash') FROM investor_monitor_evidence_inputs WHERE id=NEW.input_id AND workspace_id=NEW.workspace_id AND model_id=NEW.model_id)
    OR NOT EXISTS(SELECT 1 FROM investor_evidence_monitor_requests r JOIN job_runs j ON j.period=r.id AND j.scope=r.workspace_id
      WHERE r.model_id=NEW.model_id AND r.workspace_id=NEW.workspace_id AND r.input_id=NEW.input_id
      AND j.job_type='investor_evidence_monitor' AND j.command_request_id IS NULL AND j.status='running')
    THEN RAISE(ABORT,'evidence checkpoint binding differs') END;
END;
CREATE TRIGGER investor_evidence_checkpoint_no_update BEFORE UPDATE ON investor_evidence_model_checkpoints BEGIN SELECT RAISE(ABORT,'evidence checkpoint is immutable'); END;
CREATE TRIGGER investor_evidence_checkpoint_no_delete BEFORE DELETE ON investor_evidence_model_checkpoints BEGIN SELECT RAISE(ABORT,'evidence checkpoint is immutable'); END;
CREATE TRIGGER investor_evidence_request_insert BEFORE INSERT ON investor_evidence_monitor_requests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_evidence_monitor_requests WHERE id=NEW.id OR (model_id=NEW.model_id AND period=NEW.period AND request_key=NEW.request_key))
    OR NOT EXISTS(SELECT 1 FROM investor_models m JOIN investor_monitor_evidence_inputs i ON i.model_id=m.id AND i.workspace_id=m.workspace_id
      WHERE m.id=NEW.model_id AND m.workspace_id=NEW.workspace_id AND i.id=NEW.input_id AND i.created_at<=NEW.created_at
      AND json_extract(m.document_json,'$.data_mode')='reconstructed' AND json_extract(NEW.document_json,'$.input_hash') IS i.content_hash)
    THEN RAISE(ABORT,'evidence monitor request binding differs') END;
END;
CREATE TRIGGER investor_evidence_request_no_update BEFORE UPDATE ON investor_evidence_monitor_requests BEGIN SELECT RAISE(ABORT,'evidence monitor request is immutable'); END;
CREATE TRIGGER investor_evidence_request_no_delete BEFORE DELETE ON investor_evidence_monitor_requests BEGIN SELECT RAISE(ABORT,'evidence monitor request is immutable'); END;
CREATE TRIGGER investor_evidence_run_insert BEFORE INSERT ON investor_evidence_monitor_runs BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_evidence_monitor_runs WHERE id=NEW.id OR request_id=NEW.request_id OR job_id=NEW.job_id OR observation_id=NEW.observation_id)
    OR NOT EXISTS(SELECT 1 FROM investor_evidence_monitor_requests r JOIN job_runs j ON j.period=r.id AND j.scope=r.workspace_id
      JOIN investor_observations o ON o.id=NEW.observation_id AND o.workspace_id=r.workspace_id
      WHERE r.id=NEW.request_id AND r.model_id=NEW.model_id AND j.id=NEW.job_id AND j.input_version=r.input_version
      AND j.job_type='investor_evidence_monitor' AND j.command_request_id IS NULL AND j.status='running'
      AND o.input_version=r.input_version AND o.created_at=NEW.created_at
      AND json_extract(o.document_json,'$.run_id') IS NEW.id)
    THEN RAISE(ABORT,'evidence monitor run binding differs') END;
END;
CREATE TRIGGER investor_evidence_run_no_update BEFORE UPDATE ON investor_evidence_monitor_runs BEGIN SELECT RAISE(ABORT,'evidence monitor run is immutable'); END;
CREATE TRIGGER investor_evidence_run_no_delete BEFORE DELETE ON investor_evidence_monitor_runs BEGIN SELECT RAISE(ABORT,'evidence monitor run is immutable'); END;
CREATE TRIGGER investor_evidence_checkpoint_payload_insert BEFORE INSERT ON investor_evidence_checkpoint_payloads BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_evidence_checkpoint_payloads WHERE checkpoint_id=NEW.checkpoint_id)
    OR EXISTS(SELECT 1 FROM investor_monitor_payload_purges WHERE kind='checkpoint' AND entity_id=NEW.checkpoint_id)
    THEN RAISE(ABORT,'evidence checkpoint payload cannot be replaced') END;
END;
CREATE TRIGGER investor_evidence_checkpoint_payload_update BEFORE UPDATE ON investor_evidence_checkpoint_payloads BEGIN SELECT RAISE(ABORT,'evidence checkpoint payload is immutable'); END;
CREATE TRIGGER investor_evidence_checkpoint_payload_delete BEFORE DELETE ON investor_evidence_checkpoint_payloads BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM investor_monitor_payload_purges WHERE kind='checkpoint' AND entity_id=OLD.checkpoint_id) THEN RAISE(ABORT,'evidence checkpoint payload requires purge') END;
END;
CREATE TRIGGER investor_evidence_run_payload_insert BEFORE INSERT ON investor_evidence_run_payloads BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_evidence_run_payloads WHERE run_id=NEW.run_id)
    OR EXISTS(SELECT 1 FROM investor_monitor_payload_purges WHERE kind='run' AND entity_id=NEW.run_id)
    THEN RAISE(ABORT,'evidence run payload cannot be replaced') END;
END;
CREATE TRIGGER investor_evidence_run_payload_update BEFORE UPDATE ON investor_evidence_run_payloads BEGIN SELECT RAISE(ABORT,'evidence run payload is immutable'); END;
CREATE TRIGGER investor_evidence_run_payload_delete BEFORE DELETE ON investor_evidence_run_payloads BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM investor_monitor_payload_purges WHERE kind='run' AND entity_id=OLD.run_id) THEN RAISE(ABORT,'evidence run payload requires purge') END;
END;
CREATE TRIGGER investor_monitor_payload_purge_insert BEFORE INSERT ON investor_monitor_payload_purges BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_monitor_payload_purges WHERE kind=NEW.kind AND entity_id=NEW.entity_id)
    OR NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR (NEW.kind='checkpoint' AND NOT EXISTS(SELECT 1 FROM investor_evidence_model_checkpoints WHERE id=NEW.entity_id AND workspace_id=NEW.workspace_id AND model_id=NEW.model_id))
    OR (NEW.kind='run' AND NOT EXISTS(SELECT 1 FROM investor_evidence_monitor_runs WHERE id=NEW.entity_id AND workspace_id=NEW.workspace_id AND model_id=NEW.model_id))
    OR NOT EXISTS(SELECT 1 FROM audit_events WHERE id=NEW.audit_id AND actor_id=NEW.actor_id AND action='investor_purge_monitor_payload'
      AND object_type='investor_monitor_payload' AND object_id=NEW.entity_id AND created_at=NEW.created_at
      AND json_extract(payload_json,'$.kind') IS NEW.kind AND json_extract(payload_json,'$.reason') IS NEW.reason)
    THEN RAISE(ABORT,'monitor payload purge binding differs') END;
END;
CREATE TRIGGER investor_monitor_payload_purge_update BEFORE UPDATE ON investor_monitor_payload_purges BEGIN SELECT RAISE(ABORT,'monitor payload purge is immutable'); END;
CREATE TRIGGER investor_monitor_payload_purge_delete BEFORE DELETE ON investor_monitor_payload_purges BEGIN SELECT RAISE(ABORT,'monitor payload purge is immutable'); END;
