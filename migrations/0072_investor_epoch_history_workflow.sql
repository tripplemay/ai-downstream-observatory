CREATE TABLE investor_epoch_history_intents (
 id TEXT PRIMARY KEY NOT NULL,workspace_id TEXT NOT NULL,model_id TEXT NOT NULL,epoch_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('prepare','confirm')),expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),preview_id TEXT,
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 160),request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=16384),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),actor_id TEXT NOT NULL,created_at TEXT NOT NULL,valid_until TEXT NOT NULL,
 audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),UNIQUE(workspace_id,idempotency_key),UNIQUE(workspace_id,preview_id),UNIQUE(id,workspace_id,model_id),
 FOREIGN KEY(epoch_id,workspace_id,model_id) REFERENCES investor_model_epochs(id,workspace_id,model_id),
 FOREIGN KEY(preview_id,workspace_id,model_id) REFERENCES investor_epoch_history_results(id,workspace_id,model_id),
 CHECK((action='confirm')=(preview_id IS NOT NULL)),CHECK(julianday(valid_until)>julianday(created_at) AND julianday(valid_until)-julianday(created_at)<=0.003472223),
 CHECK(json_extract(document_json,'$.schema_version') IS 'investor-epoch-history-workflow-request-v1'),
 CHECK(json_extract(document_json,'$.request_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id AND json_extract(document_json,'$.model_id') IS model_id AND json_extract(document_json,'$.epoch_id') IS epoch_id),
 CHECK(json_extract(document_json,'$.actor_id') IS actor_id AND json_extract(document_json,'$.request_hash') IS request_hash AND json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until),
 CHECK(json_extract(document_json,'$.body.action') IS action AND json_extract(document_json,'$.body.model_id') IS model_id AND json_extract(document_json,'$.body.expected_revision') IS expected_revision
  AND json_extract(document_json,'$.body.idempotency_key') IS idempotency_key AND json_extract(document_json,'$.body.preview_id') IS preview_id),
 CHECK(json_type(document_json,'$.trading_permission') IS 'false')
);
CREATE TABLE investor_epoch_history_results (
 id TEXT PRIMARY KEY NOT NULL,request_id TEXT NOT NULL UNIQUE,workspace_id TEXT NOT NULL,model_id TEXT NOT NULL,epoch_id TEXT NOT NULL,
 job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id),fencing_token INTEGER NOT NULL CHECK(fencing_token>0),outcome TEXT NOT NULL CHECK(outcome IN ('plan_ready','download_queued','rejected')),code TEXT NOT NULL,
 document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=139264),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),actor_id TEXT NOT NULL,created_at TEXT NOT NULL,audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
 FOREIGN KEY(request_id,workspace_id,model_id) REFERENCES investor_epoch_history_intents(id,workspace_id,model_id),UNIQUE(id,workspace_id,model_id),
 CHECK(json_extract(document_json,'$.schema_version') IS 'investor-epoch-history-workflow-result-v1'),
 CHECK(json_extract(document_json,'$.result_id') IS id AND json_extract(document_json,'$.request_id') IS request_id AND json_extract(document_json,'$.workspace_id') IS workspace_id AND json_extract(document_json,'$.model_id') IS model_id AND json_extract(document_json,'$.epoch_id') IS epoch_id),
 CHECK(json_extract(document_json,'$.job_id') IS job_id AND json_extract(document_json,'$.fencing_token') IS fencing_token AND json_extract(document_json,'$.outcome') IS outcome AND json_extract(document_json,'$.code') IS code
  AND json_extract(document_json,'$.actor_id') IS actor_id AND json_extract(document_json,'$.created_at') IS created_at),
 CHECK((json_type(document_json,'$.plan')='object')=(outcome='plan_ready') AND (json_type(document_json,'$.history_request')='object')=(outcome='download_queued')),
 CHECK((json_extract(document_json,'$.source_fence') IS NOT NULL)=(outcome!='rejected')),
 CHECK((outcome='plan_ready' AND code='HISTORY_WORKFLOW_PLAN_READY') OR (outcome='download_queued' AND code='HISTORY_WORKFLOW_DOWNLOAD_QUEUED')
  OR (outcome='rejected' AND code IN ('HISTORY_WORKFLOW_EXPIRED','HISTORY_WORKFLOW_CHANGED','HISTORY_WORKFLOW_SOURCE_UNAVAILABLE','HISTORY_WORKFLOW_REVIEW_REQUIRED'))),
 CHECK(json_extract(document_json,'$.provider_calls') IS 0 AND json_type(document_json,'$.monitoring_resumed') IS 'false' AND json_type(document_json,'$.trading_permission') IS 'false')
);
CREATE TRIGGER investor_epoch_history_intent_insert BEFORE INSERT ON investor_epoch_history_intents BEGIN
 SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
  OR NEW.expected_revision IS NOT (SELECT revision FROM investor_workspaces WHERE id=NEW.workspace_id)
  OR NOT EXISTS(SELECT 1 FROM investor_model_epochs e JOIN investor_models m ON m.id=e.model_id AND m.workspace_id=e.workspace_id
    WHERE e.id=NEW.epoch_id AND e.workspace_id=NEW.workspace_id AND e.model_id=NEW.model_id AND e.created_at<=NEW.created_at AND e.valid_until>=NEW.valid_until
      AND e.content_hash IS json_extract(NEW.document_json,'$.registration_hash') AND m.content_hash IS json_extract(NEW.document_json,'$.model_hash'))
  OR (NEW.action='prepare' AND json_type(NEW.document_json,'$.body.acknowledged_plan_only') IS NOT 'true')
  OR (NEW.action='confirm' AND NOT EXISTS(SELECT 1 FROM investor_epoch_history_results u JOIN investor_epoch_history_intents r ON r.id=u.request_id
    WHERE u.id=NEW.preview_id AND u.workspace_id=NEW.workspace_id AND u.model_id=NEW.model_id AND u.epoch_id=NEW.epoch_id AND u.actor_id=NEW.actor_id
      AND u.outcome='plan_ready' AND r.action='prepare' AND r.expected_revision=NEW.expected_revision AND u.content_hash IS json_extract(NEW.document_json,'$.body.expected_preview_hash')
      AND u.created_at<=NEW.created_at AND NEW.created_at<json_extract(u.document_json,'$.valid_until') AND NEW.valid_until<=json_extract(u.document_json,'$.valid_until')))
  OR NOT EXISTS(SELECT 1 FROM audit_events WHERE id=NEW.audit_id AND actor_id=NEW.actor_id AND action='investor_request_history_workflow' AND object_type='investor_history_workflow_request'
    AND object_id=NEW.id AND created_at=NEW.created_at AND json_extract(payload_json,'$.content_hash') IS NEW.content_hash)
  THEN RAISE(ABORT,'history workflow request binding differs') END;
END;
CREATE TRIGGER investor_epoch_history_result_insert BEFORE INSERT ON investor_epoch_history_results BEGIN
 SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
  OR NOT EXISTS(SELECT 1 FROM investor_epoch_history_intents r JOIN job_runs j ON j.id=NEW.job_id JOIN job_attempts a ON a.job_id=j.id AND a.attempt=j.attempt_count AND a.fencing_token=j.fencing_token
    WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id AND r.model_id=NEW.model_id AND r.epoch_id=NEW.epoch_id AND r.actor_id=NEW.actor_id AND r.created_at<=NEW.created_at
      AND r.content_hash IS json_extract(NEW.document_json,'$.request_hash') AND json_extract(NEW.document_json,'$.valid_until')<=r.valid_until
      AND j.job_type='investor_epoch_history_workflow' AND j.scope=NEW.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
      AND j.command_request_id IS NULL AND j.status='running' AND j.max_attempts=1 AND j.attempt_count=1 AND j.fencing_token=NEW.fencing_token AND j.lease_until>NEW.created_at
      AND a.status='running' AND a.finished_at IS NULL AND (substr(a.started_at,1,23)||'Z')<=NEW.created_at
      AND (NEW.outcome='rejected' OR NEW.created_at<json_extract(NEW.document_json,'$.valid_until')))
  OR (NEW.outcome='plan_ready' AND NOT EXISTS(SELECT 1 FROM investor_epoch_history_intents r WHERE r.id=NEW.request_id AND r.action='prepare'
    AND json_extract(NEW.document_json,'$.plan.workspace_revision') IS r.expected_revision AND json_extract(NEW.document_json,'$.plan.planned_at') IS r.created_at
    AND json_extract(NEW.document_json,'$.plan.epoch.id') IS r.epoch_id AND json_extract(NEW.document_json,'$.plan.model_id') IS r.model_id))
  OR (NEW.outcome='download_queued' AND NOT EXISTS(SELECT 1 FROM investor_epoch_history_requests h JOIN investor_epoch_history_intents r ON r.id=NEW.request_id
    WHERE h.id=json_extract(NEW.document_json,'$.history_request.id') AND h.content_hash IS json_extract(NEW.document_json,'$.history_request.content_hash')
      AND r.action='confirm' AND h.workspace_id=NEW.workspace_id AND h.model_id=NEW.model_id AND h.epoch_id=NEW.epoch_id AND h.actor_id=NEW.actor_id
      AND h.idempotency_key=r.idempotency_key AND h.expected_revision=r.expected_revision AND h.created_at<=NEW.created_at))
  OR NOT EXISTS(SELECT 1 FROM audit_events WHERE id=NEW.audit_id AND actor_id=NEW.actor_id AND action='investor_finish_history_workflow' AND object_type='investor_history_workflow_result'
    AND object_id=NEW.id AND created_at=NEW.created_at AND json_extract(payload_json,'$.content_hash') IS NEW.content_hash)
  THEN RAISE(ABORT,'history workflow result binding differs') END;
END;
CREATE TRIGGER investor_epoch_history_intent_update BEFORE UPDATE ON investor_epoch_history_intents BEGIN SELECT RAISE(ABORT,'history workflow request immutable'); END;
CREATE TRIGGER investor_epoch_history_intent_delete BEFORE DELETE ON investor_epoch_history_intents BEGIN SELECT RAISE(ABORT,'history workflow request immutable'); END;
CREATE TRIGGER investor_epoch_history_result_update BEFORE UPDATE ON investor_epoch_history_results BEGIN SELECT RAISE(ABORT,'history workflow result immutable'); END;
CREATE TRIGGER investor_epoch_history_result_delete BEFORE DELETE ON investor_epoch_history_results BEGIN SELECT RAISE(ABORT,'history workflow result immutable'); END;
