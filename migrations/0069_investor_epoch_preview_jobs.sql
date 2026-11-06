-- Explicit preparation intents, not epoch registration or activation.
CREATE TABLE investor_epoch_preview_requests (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision>=1),
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL,
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(model_id,workspace_id) REFERENCES investor_models(id,workspace_id),
  UNIQUE(id,workspace_id,model_id), UNIQUE(workspace_id,idempotency_key),
  CHECK(julianday(valid_until)>julianday(created_at) AND julianday(valid_until)-julianday(created_at)<=0.003472223),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-epoch-preview-request-v1'
    AND json_extract(document_json,'$.request_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id
    AND json_extract(document_json,'$.model_id') IS model_id AND json_extract(document_json,'$.actor_id') IS actor_id
    AND json_extract(document_json,'$.body.model_id') IS model_id AND json_extract(document_json,'$.body.expected_revision') IS expected_revision
    AND json_extract(document_json,'$.body.idempotency_key') IS idempotency_key AND json_extract(document_json,'$.request_hash') IS request_hash
    AND json_type(document_json,'$.body.acknowledged_preview_only') IS 'true'
    AND json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until
    AND json_type(document_json,'$.trading_permission') IS 'false')
);
CREATE TABLE investor_epoch_preview_results (
  id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id), fencing_token INTEGER NOT NULL CHECK(fencing_token>=1),
  outcome TEXT NOT NULL CHECK(outcome IN ('preview_ready','rejected')), code TEXT NOT NULL,
  preview_id TEXT,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(request_id,workspace_id,model_id) REFERENCES investor_epoch_preview_requests(id,workspace_id,model_id),
  FOREIGN KEY(preview_id,workspace_id,model_id) REFERENCES investor_model_epoch_previews(id,workspace_id,model_id),
  CHECK((outcome='preview_ready' AND preview_id IS NOT NULL AND code='EPOCH_PREVIEW_READY') OR (outcome='rejected' AND preview_id IS NULL AND code!='EPOCH_PREVIEW_READY')),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-epoch-preview-result-v1'
    AND json_extract(document_json,'$.result_id') IS id AND json_extract(document_json,'$.request_id') IS request_id
    AND json_extract(document_json,'$.workspace_id') IS workspace_id AND json_extract(document_json,'$.model_id') IS model_id
    AND json_extract(document_json,'$.actor_id') IS actor_id AND json_extract(document_json,'$.job_id') IS job_id
    AND json_extract(document_json,'$.fencing_token') IS fencing_token AND json_extract(document_json,'$.outcome') IS outcome
    AND json_extract(document_json,'$.code') IS code AND json_extract(document_json,'$.preview_id') IS preview_id
    AND json_extract(document_json,'$.created_at') IS created_at AND json_type(document_json,'$.epoch_registered') IS 'false'
    AND json_type(document_json,'$.monitoring_resumed') IS 'false' AND json_type(document_json,'$.trading_permission') IS 'false')
);
CREATE TRIGGER investor_epoch_preview_request_insert BEFORE INSERT ON investor_epoch_preview_requests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_epoch_preview_requests WHERE id=NEW.id OR (workspace_id=NEW.workspace_id AND idempotency_key=NEW.idempotency_key) OR audit_id=NEW.audit_id)
    OR NEW.expected_revision IS NOT (SELECT revision FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR EXISTS(SELECT 1 FROM investor_model_epochs WHERE workspace_id=NEW.workspace_id AND model_id=NEW.model_id)
    OR NOT EXISTS(SELECT 1 FROM investor_models m JOIN audit_events a ON a.id=NEW.audit_id
      WHERE m.id=NEW.model_id AND m.workspace_id=NEW.workspace_id AND m.created_at<=NEW.created_at
        AND json_extract(NEW.document_json,'$.body.expected_model_hash') IS m.content_hash
        AND julianday(NEW.valid_until)<=julianday(json_extract(m.document_json,'$.valid_until'))
        AND a.actor_id=NEW.actor_id AND a.action='investor_request_epoch_preview' AND a.object_type='investor_epoch_preview_request'
        AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'epoch preview request binding differs') END;
END;
CREATE TRIGGER investor_epoch_preview_result_insert BEFORE INSERT ON investor_epoch_preview_results BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_epoch_preview_results WHERE id=NEW.id OR request_id=NEW.request_id OR job_id=NEW.job_id OR audit_id=NEW.audit_id)
    OR NOT EXISTS(SELECT 1 FROM investor_epoch_preview_requests r JOIN job_runs j ON j.id=NEW.job_id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id AND r.model_id=NEW.model_id AND r.actor_id=NEW.actor_id AND r.created_at<=NEW.created_at
        AND json_extract(NEW.document_json,'$.request_hash') IS r.content_hash
        AND julianday(json_extract(NEW.document_json,'$.valid_until'))<=julianday(r.valid_until)
        AND j.job_type='investor_epoch_preview' AND j.scope=NEW.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
        AND j.command_request_id IS NULL AND j.status='running' AND j.max_attempts=1 AND j.attempt_count=1 AND j.fencing_token=NEW.fencing_token
        AND a.actor_id=NEW.actor_id AND a.action='investor_finish_epoch_preview' AND a.object_type='investor_epoch_preview_result'
        AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    OR (NEW.outcome='preview_ready' AND NOT EXISTS(SELECT 1 FROM investor_model_epoch_previews p JOIN investor_epoch_preview_requests r ON r.id=NEW.request_id
      WHERE p.id=NEW.preview_id AND p.workspace_id=NEW.workspace_id AND p.model_id=NEW.model_id AND p.actor_id=NEW.actor_id
        AND p.workspace_revision=r.expected_revision+1 AND p.content_hash IS json_extract(NEW.document_json,'$.preview_hash')
        AND r.created_at<=p.created_at AND p.created_at<=NEW.created_at AND NEW.created_at<json_extract(NEW.document_json,'$.valid_until')
        AND julianday(json_extract(NEW.document_json,'$.valid_until'))<=julianday(p.valid_until)))
    THEN RAISE(ABORT,'epoch preview result binding differs') END;
END;
CREATE TRIGGER investor_epoch_preview_request_update BEFORE UPDATE ON investor_epoch_preview_requests BEGIN SELECT RAISE(ABORT,'epoch preview request immutable'); END;
CREATE TRIGGER investor_epoch_preview_request_delete BEFORE DELETE ON investor_epoch_preview_requests BEGIN SELECT RAISE(ABORT,'epoch preview request immutable'); END;
CREATE TRIGGER investor_epoch_preview_result_update BEFORE UPDATE ON investor_epoch_preview_results BEGIN SELECT RAISE(ABORT,'epoch preview result immutable'); END;
CREATE TRIGGER investor_epoch_preview_result_delete BEFORE DELETE ON investor_epoch_preview_results BEGIN SELECT RAISE(ABORT,'epoch preview result immutable'); END;
