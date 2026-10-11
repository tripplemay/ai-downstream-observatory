CREATE TABLE investor_models (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  selection_id TEXT NOT NULL UNIQUE REFERENCES investor_plan_selections(id),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=32768),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  FOREIGN KEY(profile_id,workspace_id) REFERENCES investor_profiles(id,workspace_id),
  FOREIGN KEY(plan_id,workspace_id) REFERENCES investor_reference_plans(id,workspace_id),
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,plan_id),
  CHECK(json_extract(document_json,'$.model_id') IS id),
  CHECK(json_extract(document_json,'$.profile_id') IS profile_id),
  CHECK(json_extract(document_json,'$.plan_id') IS plan_id),
  CHECK(json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_extract(document_json,'$.scope') IS 'research_model'),
  CHECK(json_extract(document_json,'$.live_advice_eligible') IS 0)
);
CREATE TABLE investor_model_controls (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version>0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  actor_id TEXT NOT NULL,
  audit_id TEXT NOT NULL REFERENCES audit_events(id),
  created_at TEXT NOT NULL,
  FOREIGN KEY(model_id,workspace_id) REFERENCES investor_models(id,workspace_id),
  UNIQUE(model_id,version), UNIQUE(id,workspace_id,model_id)
);
CREATE TABLE investor_model_inputs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  source_qualification TEXT NOT NULL CHECK(source_qualification='synthetic_test_only'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=1048576),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  FOREIGN KEY(model_id,workspace_id) REFERENCES investor_models(id,workspace_id),
  UNIQUE(model_id,content_hash), UNIQUE(id,workspace_id,model_id),
  CHECK(json_extract(document_json,'$.model_id') IS model_id),
  CHECK(json_extract(document_json,'$.source_qualification') IS source_qualification)
);
CREATE INDEX investor_model_input_latest ON investor_model_inputs(model_id,created_at DESC);
CREATE TABLE investor_model_checkpoints (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  input_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence>0),
  previous_hash TEXT,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=4194304),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  FOREIGN KEY(model_id,workspace_id) REFERENCES investor_models(id,workspace_id),
  FOREIGN KEY(input_id,workspace_id,model_id) REFERENCES investor_model_inputs(id,workspace_id,model_id),
  UNIQUE(model_id,sequence), UNIQUE(id,workspace_id,model_id),
  CHECK(json_extract(document_json,'$.model_id') IS model_id),
  CHECK(json_extract(document_json,'$.sequence') IS sequence),
  CHECK(json_extract(document_json,'$.previous_hash') IS previous_hash),
  CHECK(json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_extract(document_json,'$.data_mode') IS 'synthetic'),
  CHECK(json_extract(document_json,'$.live_advice_eligible') IS 0)
);
CREATE TABLE investor_monitor_requests (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  control_id TEXT NOT NULL,
  input_id TEXT,
  checkpoint_id TEXT,
  period TEXT NOT NULL,
  request_key TEXT NOT NULL CHECK(length(request_key)=64 AND request_key NOT GLOB '*[^a-f0-9]*'),
  input_version TEXT NOT NULL CHECK(length(input_version)=64 AND input_version NOT GLOB '*[^a-f0-9]*'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=4096),
  created_at TEXT NOT NULL,
  FOREIGN KEY(model_id,workspace_id) REFERENCES investor_models(id,workspace_id),
  FOREIGN KEY(control_id,workspace_id,model_id) REFERENCES investor_model_controls(id,workspace_id,model_id),
  FOREIGN KEY(input_id,workspace_id,model_id) REFERENCES investor_model_inputs(id,workspace_id,model_id),
  FOREIGN KEY(checkpoint_id,workspace_id,model_id) REFERENCES investor_model_checkpoints(id,workspace_id,model_id),
  UNIQUE(model_id,period,request_key), UNIQUE(id,workspace_id,model_id)
);
CREATE INDEX investor_monitor_request_latest ON investor_monitor_requests(model_id,created_at DESC);
CREATE TABLE investor_monitor_runs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id),
  observation_id TEXT NOT NULL UNIQUE,
  checkpoint_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('blocked','synthetic_preview')),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=1048576),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  FOREIGN KEY(request_id,workspace_id,model_id) REFERENCES investor_monitor_requests(id,workspace_id,model_id),
  FOREIGN KEY(observation_id,workspace_id) REFERENCES investor_observations(id,workspace_id),
  FOREIGN KEY(checkpoint_id,workspace_id,model_id) REFERENCES investor_model_checkpoints(id,workspace_id,model_id),
  CHECK(json_extract(document_json,'$.request_id') IS request_id),
  CHECK(json_extract(document_json,'$.status') IS status),
  CHECK(json_extract(document_json,'$.created_at') IS created_at)
);

CREATE TRIGGER investor_model_insert BEFORE INSERT ON investor_models BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_models WHERE id=NEW.id OR selection_id=NEW.selection_id OR (workspace_id=NEW.workspace_id AND plan_id=NEW.plan_id))
    OR NOT EXISTS(SELECT 1 FROM investor_plan_selections WHERE id=NEW.selection_id AND workspace_id=NEW.workspace_id AND plan_id=NEW.plan_id)
    THEN RAISE(ABORT,'model selection binding differs') END;
END;
CREATE TRIGGER investor_model_no_update BEFORE UPDATE ON investor_models BEGIN SELECT RAISE(ABORT,'model is immutable'); END;
CREATE TRIGGER investor_model_no_delete BEFORE DELETE ON investor_models BEGIN SELECT RAISE(ABORT,'model is immutable'); END;
CREATE TRIGGER investor_model_control_insert BEFORE INSERT ON investor_model_controls BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_model_controls WHERE id=NEW.id OR (model_id=NEW.model_id AND version=NEW.version))
    OR NEW.version IS NOT (SELECT COALESCE(MAX(version),0)+1 FROM investor_model_controls WHERE model_id=NEW.model_id)
    OR NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    THEN RAISE(ABORT,'model control version or owner differs') END;
END;
CREATE TRIGGER investor_model_control_no_update BEFORE UPDATE ON investor_model_controls BEGIN SELECT RAISE(ABORT,'model control is immutable'); END;
CREATE TRIGGER investor_model_control_no_delete BEFORE DELETE ON investor_model_controls BEGIN SELECT RAISE(ABORT,'model control is immutable'); END;
CREATE TRIGGER investor_model_input_insert BEFORE INSERT ON investor_model_inputs BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_model_inputs WHERE id=NEW.id OR (model_id=NEW.model_id AND content_hash=NEW.content_hash)) THEN RAISE(ABORT,'model input cannot be replaced') END;
END;
CREATE TRIGGER investor_model_input_no_update BEFORE UPDATE ON investor_model_inputs BEGIN SELECT RAISE(ABORT,'model input is immutable'); END;
CREATE TRIGGER investor_model_input_no_delete BEFORE DELETE ON investor_model_inputs BEGIN SELECT RAISE(ABORT,'model input is immutable'); END;
CREATE TRIGGER investor_model_checkpoint_insert BEFORE INSERT ON investor_model_checkpoints BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_model_checkpoints WHERE id=NEW.id OR (model_id=NEW.model_id AND sequence=NEW.sequence))
    OR NEW.sequence IS NOT (SELECT COALESCE(MAX(sequence),0)+1 FROM investor_model_checkpoints WHERE model_id=NEW.model_id)
    OR NEW.previous_hash IS NOT (SELECT content_hash FROM investor_model_checkpoints WHERE model_id=NEW.model_id ORDER BY sequence DESC LIMIT 1)
    OR json_extract(NEW.document_json,'$.input_hash') IS NOT (SELECT content_hash FROM investor_model_inputs WHERE id=NEW.input_id)
    THEN RAISE(ABORT,'model checkpoint chain differs') END;
END;
CREATE TRIGGER investor_model_checkpoint_no_update BEFORE UPDATE ON investor_model_checkpoints BEGIN SELECT RAISE(ABORT,'model checkpoint is immutable'); END;
CREATE TRIGGER investor_model_checkpoint_no_delete BEFORE DELETE ON investor_model_checkpoints BEGIN SELECT RAISE(ABORT,'model checkpoint is immutable'); END;
CREATE TRIGGER investor_monitor_request_insert BEFORE INSERT ON investor_monitor_requests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_monitor_requests WHERE id=NEW.id OR (model_id=NEW.model_id AND period=NEW.period AND request_key=NEW.request_key)) THEN RAISE(ABORT,'monitor request cannot be replaced') END;
END;
CREATE TRIGGER investor_monitor_request_no_update BEFORE UPDATE ON investor_monitor_requests BEGIN SELECT RAISE(ABORT,'monitor request is immutable'); END;
CREATE TRIGGER investor_monitor_request_no_delete BEFORE DELETE ON investor_monitor_requests BEGIN SELECT RAISE(ABORT,'monitor request is immutable'); END;
CREATE TRIGGER investor_monitor_run_insert BEFORE INSERT ON investor_monitor_runs BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_monitor_runs WHERE id=NEW.id OR request_id=NEW.request_id OR job_id=NEW.job_id OR observation_id=NEW.observation_id)
    OR NOT EXISTS(SELECT 1 FROM job_runs j JOIN investor_monitor_requests r ON r.id=NEW.request_id
      WHERE j.id=NEW.job_id AND j.job_type='investor_monitor' AND j.command_request_id IS NULL AND j.status='running'
      AND j.scope=NEW.workspace_id AND j.period=r.id AND j.input_version=r.input_version AND r.model_id=NEW.model_id)
    OR NOT EXISTS(SELECT 1 FROM investor_observations o JOIN investor_models m ON m.id=NEW.model_id JOIN investor_monitor_requests r ON r.id=NEW.request_id
      WHERE o.id=NEW.observation_id AND o.workspace_id=NEW.workspace_id AND o.profile_id=m.profile_id
      AND o.input_version=r.input_version AND o.created_at=NEW.created_at AND o.outcome='insufficient_evidence')
    THEN RAISE(ABORT,'monitor run binding differs') END;
END;
CREATE TRIGGER investor_monitor_run_no_update BEFORE UPDATE ON investor_monitor_runs BEGIN SELECT RAISE(ABORT,'monitor run is immutable'); END;
CREATE TRIGGER investor_monitor_run_no_delete BEFORE DELETE ON investor_monitor_runs BEGIN SELECT RAISE(ABORT,'monitor run is immutable'); END;
