CREATE TABLE investor_legacy_transition_job_requests (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id),
  kind TEXT NOT NULL CHECK(kind IN ('preview','confirmation')), model_id TEXT NOT NULL, preview_id TEXT,
  expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision>=0), idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=32768),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(created_at<valid_until),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(model_id,workspace_id) REFERENCES investor_models(id,workspace_id),
  FOREIGN KEY(preview_id,workspace_id,model_id) REFERENCES investor_legacy_transition_previews(id,workspace_id,model_id),
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,idempotency_key),
  CHECK((kind='preview' AND preview_id IS NULL) OR (kind='confirmation' AND preview_id IS NOT NULL)),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-legacy-transition-job-request-v1'
    AND json_extract(document_json,'$.request_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id
    AND json_extract(document_json,'$.model_id') IS model_id AND json_extract(document_json,'$.kind') IS kind
    AND json_extract(document_json,'$.request_hash') IS request_hash
    AND json_extract(document_json,'$.body.expected_revision') IS expected_revision AND json_extract(document_json,'$.body.idempotency_key') IS idempotency_key
    AND json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until),
  CHECK((kind='preview' AND json_extract(document_json,'$.body.model_id') IS model_id)
    OR (kind='confirmation' AND json_extract(document_json,'$.body.preview_id') IS preview_id))
);
CREATE TABLE investor_legacy_transition_job_results (
  id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id), fencing_token INTEGER NOT NULL CHECK(fencing_token>0),
  kind TEXT NOT NULL CHECK(kind IN ('preview','confirmation')), outcome TEXT NOT NULL CHECK(outcome IN ('preview_ready','registered','rejected')),
  resource_id TEXT, resource_hash TEXT, code TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(request_id,workspace_id) REFERENCES investor_legacy_transition_job_requests(id,workspace_id),
  CHECK(outcome='rejected' OR (kind='preview' AND outcome='preview_ready') OR (kind='confirmation' AND outcome='registered')),
  CHECK((outcome='rejected' AND resource_id IS NULL AND resource_hash IS NULL)
    OR (outcome!='rejected' AND resource_id IS NOT NULL AND length(resource_hash)=64 AND resource_hash NOT GLOB '*[^a-f0-9]*')),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-legacy-transition-job-result-v1'
    AND json_extract(document_json,'$.result_id') IS id AND json_extract(document_json,'$.request_id') IS request_id
    AND json_extract(document_json,'$.workspace_id') IS workspace_id AND json_extract(document_json,'$.kind') IS kind
    AND json_extract(document_json,'$.job_id') IS job_id AND json_extract(document_json,'$.fencing_token') IS fencing_token
    AND json_extract(document_json,'$.outcome') IS outcome AND json_extract(document_json,'$.resource_id') IS resource_id
    AND json_extract(document_json,'$.resource_hash') IS resource_hash AND json_extract(document_json,'$.code') IS code
    AND json_extract(document_json,'$.created_at') IS created_at),
  CHECK((outcome='registered' AND json_type(document_json,'$.monitor_source_registered') IS 'true')
    OR (outcome!='registered' AND json_type(document_json,'$.monitor_source_registered') IS 'false')),
  CHECK(json_type(document_json,'$.current_advice_certified') IS 'false' AND json_type(document_json,'$.monitoring_activated') IS 'false'
    AND json_type(document_json,'$.trading_permission') IS 'false' AND json_extract(document_json,'$.provider_calls') IS 0)
);
CREATE TRIGGER investor_legacy_transition_job_request_insert BEFORE INSERT ON investor_legacy_transition_job_requests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_legacy_transition_job_requests WHERE id=NEW.id OR audit_id=NEW.audit_id
    OR (workspace_id=NEW.workspace_id AND idempotency_key=NEW.idempotency_key))
    OR NOT EXISTS(SELECT 1 FROM investor_workspaces w JOIN investor_models m ON m.workspace_id=w.id
    JOIN audit_events a ON a.id=NEW.audit_id WHERE w.id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND w.revision=NEW.expected_revision
    AND m.id=NEW.model_id AND m.created_at<=NEW.created_at
    AND NOT EXISTS(SELECT 1 FROM investor_legacy_transition_confirmations WHERE model_id=m.id)
    AND a.actor_id=NEW.actor_id AND a.action='investor_enqueue_legacy_transition' AND a.object_type='investor_legacy_transition_job_request'
    AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'legacy transition job request binding differs') END;
  SELECT CASE WHEN NEW.kind='confirmation' AND NOT EXISTS(SELECT 1 FROM investor_legacy_transition_previews v
    WHERE v.id=NEW.preview_id AND v.workspace_id=NEW.workspace_id AND v.model_id=NEW.model_id AND v.actor_id=NEW.actor_id
    AND v.workspace_revision=NEW.expected_revision AND v.created_at<=NEW.created_at AND NEW.valid_until<=v.valid_until
    AND json_extract(NEW.document_json,'$.body.expected_preview_hash') IS v.content_hash)
    THEN RAISE(ABORT,'legacy transition job preview binding differs') END;
END;
CREATE TRIGGER investor_legacy_transition_job_result_insert BEFORE INSERT ON investor_legacy_transition_job_results BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_legacy_transition_job_results WHERE id=NEW.id OR request_id=NEW.request_id
    OR job_id=NEW.job_id OR audit_id=NEW.audit_id)
    OR NOT EXISTS(SELECT 1 FROM investor_legacy_transition_job_requests r JOIN job_runs j ON j.id=NEW.job_id
    JOIN job_attempts t ON t.job_id=j.id AND t.attempt=1 JOIN audit_events a ON a.id=NEW.audit_id
    WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id AND r.actor_id=NEW.actor_id AND r.kind=NEW.kind
    AND json_extract(NEW.document_json,'$.request_hash') IS r.content_hash AND r.created_at<=NEW.created_at
    AND j.job_type='investor_legacy_transition' AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
    AND j.command_request_id IS NULL AND j.status='running' AND j.attempt_count=1 AND j.max_attempts=1 AND j.fencing_token=NEW.fencing_token
    AND t.status='running' AND t.fencing_token=j.fencing_token AND t.started_at<=NEW.created_at AND NEW.created_at<j.lease_until
    AND a.actor_id=NEW.actor_id AND a.action='investor_finish_legacy_transition' AND a.object_type='investor_legacy_transition_job_result'
    AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash
    AND (NEW.outcome='rejected' OR NEW.created_at<r.valid_until))
    THEN RAISE(ABORT,'legacy transition job result binding differs') END;
  SELECT CASE WHEN NEW.outcome='preview_ready' AND NOT EXISTS(SELECT 1 FROM investor_legacy_transition_previews v
    JOIN investor_legacy_transition_job_requests r ON r.id=NEW.request_id WHERE v.id=NEW.resource_id AND v.workspace_id=NEW.workspace_id
    AND v.model_id=r.model_id AND v.actor_id=NEW.actor_id AND v.content_hash=NEW.resource_hash AND v.request_hash=r.request_hash
    AND v.workspace_revision=r.expected_revision+1 AND r.created_at<=v.created_at AND v.created_at<=NEW.created_at)
    THEN RAISE(ABORT,'legacy transition job preview result differs') END;
  SELECT CASE WHEN NEW.outcome='registered' AND NOT EXISTS(SELECT 1 FROM investor_legacy_transition_admissions s
    JOIN investor_legacy_transition_confirmations c ON c.id=s.transition_id AND c.workspace_id=s.workspace_id AND c.model_id=s.model_id
    JOIN investor_legacy_transition_job_requests r ON r.id=NEW.request_id WHERE s.id=NEW.resource_id AND s.workspace_id=NEW.workspace_id
    AND s.model_id=r.model_id AND s.actor_id=NEW.actor_id AND s.content_hash=NEW.resource_hash AND c.actor_id=NEW.actor_id
    AND c.preview_id=r.preview_id AND c.request_hash=r.request_hash AND c.workspace_revision=r.expected_revision+1
    AND s.workspace_revision=r.expected_revision+2 AND json_extract(s.document_json,'$.transition_hash') IS c.content_hash
    AND r.created_at<=c.created_at AND c.created_at<=s.created_at AND s.created_at<=NEW.created_at)
    THEN RAISE(ABORT,'legacy transition job registration result differs') END;
END;
CREATE TRIGGER investor_legacy_transition_job_request_update BEFORE UPDATE ON investor_legacy_transition_job_requests BEGIN SELECT RAISE(ABORT,'legacy transition job request immutable'); END;
CREATE TRIGGER investor_legacy_transition_job_request_delete BEFORE DELETE ON investor_legacy_transition_job_requests BEGIN SELECT RAISE(ABORT,'legacy transition job request immutable'); END;
CREATE TRIGGER investor_legacy_transition_job_result_update BEFORE UPDATE ON investor_legacy_transition_job_results BEGIN SELECT RAISE(ABORT,'legacy transition job result immutable'); END;
CREATE TRIGGER investor_legacy_transition_job_result_delete BEFORE DELETE ON investor_legacy_transition_job_results BEGIN SELECT RAISE(ABORT,'legacy transition job result immutable'); END;
