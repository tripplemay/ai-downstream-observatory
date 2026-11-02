CREATE TABLE investor_correction_impact_requests (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id),
  model_id TEXT NOT NULL, preview_id TEXT NOT NULL, expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision>=0),
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(CAST(document_json AS BLOB))<=1048576),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64), actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(created_at<valid_until), audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,idempotency_key),
  FOREIGN KEY(model_id,workspace_id) REFERENCES investor_models(id,workspace_id),
  FOREIGN KEY(preview_id,workspace_id) REFERENCES investor_action_review_previews(id,workspace_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-correction-impact-job-request-v1'
    AND json_extract(document_json,'$.request_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id
    AND json_extract(document_json,'$.request_hash') IS request_hash
    AND json_extract(document_json,'$.body.model_id') IS model_id AND json_extract(document_json,'$.body.preview_id') IS preview_id
    AND json_extract(document_json,'$.body.expected_revision') IS expected_revision AND json_extract(document_json,'$.body.idempotency_key') IS idempotency_key
    AND json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until)
);
CREATE TABLE investor_correction_impact_results (
  id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id), fencing_token INTEGER NOT NULL CHECK(fencing_token>0),
  outcome TEXT NOT NULL CHECK(outcome IN ('preview_ready','rejected')), code TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(CAST(document_json AS BLOB))<=5242880),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64), actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(request_id,workspace_id) REFERENCES investor_correction_impact_requests(id,workspace_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-correction-impact-job-result-v1'
    AND json_extract(document_json,'$.result_id') IS id AND json_extract(document_json,'$.request_id') IS request_id
    AND json_extract(document_json,'$.workspace_id') IS workspace_id AND json_extract(document_json,'$.job_id') IS job_id
    AND json_extract(document_json,'$.fencing_token') IS fencing_token AND json_extract(document_json,'$.outcome') IS outcome
    AND json_extract(document_json,'$.code') IS code AND json_extract(document_json,'$.created_at') IS created_at),
  CHECK((outcome='preview_ready' AND json_type(document_json,'$.impact') IS 'object' AND json_type(document_json,'$.change_fence') IS 'text')
    OR (outcome='rejected' AND json_type(document_json,'$.impact') IS 'null' AND json_type(document_json,'$.change_fence') IS 'null'))
);
CREATE TRIGGER investor_correction_impact_request_insert BEFORE INSERT ON investor_correction_impact_requests BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM investor_workspaces w JOIN investor_models m ON m.workspace_id=w.id
    JOIN investor_action_review_previews p ON p.workspace_id=w.id JOIN audit_events a ON a.id=NEW.audit_id
    WHERE w.id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND w.revision=NEW.expected_revision
    AND m.id=NEW.model_id AND m.created_at<=NEW.created_at AND p.id=NEW.preview_id AND p.actor_id=NEW.actor_id
    AND p.workspace_revision=NEW.expected_revision AND p.created_at<=NEW.created_at AND NEW.valid_until<=p.valid_until
    AND a.actor_id=NEW.actor_id AND a.action='investor_enqueue_correction_impact' AND a.object_type='investor_correction_impact_request'
    AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'correction impact request binding differs') END;
END;
CREATE TRIGGER investor_correction_impact_result_insert BEFORE INSERT ON investor_correction_impact_results BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM investor_correction_impact_requests r JOIN job_runs j ON j.id=NEW.job_id
    JOIN job_attempts t ON t.job_id=j.id AND t.attempt=1 JOIN audit_events a ON a.id=NEW.audit_id
    WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id AND r.actor_id=NEW.actor_id
    AND json_extract(NEW.document_json,'$.request_hash') IS r.content_hash AND r.created_at<=NEW.created_at
    AND j.job_type='investor_correction_impact' AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
    AND j.command_request_id IS NULL AND j.status='running' AND j.attempt_count=1 AND j.max_attempts=1 AND j.fencing_token=NEW.fencing_token
    AND t.status='running' AND t.fencing_token=j.fencing_token AND t.started_at<=NEW.created_at AND NEW.created_at<j.lease_until
    AND a.actor_id=NEW.actor_id AND a.action='investor_finish_correction_impact' AND a.object_type='investor_correction_impact_result'
    AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash
    AND (NEW.outcome='rejected' OR (NEW.created_at<r.valid_until AND NEW.created_at<json_extract(NEW.document_json,'$.impact.valid_until')
      AND json_extract(NEW.document_json,'$.impact.request_hash') IS r.request_hash
      AND json_extract(NEW.document_json,'$.impact.model_id') IS r.model_id AND json_extract(NEW.document_json,'$.impact.preview_id') IS r.preview_id
      AND json_extract(NEW.document_json,'$.impact.workspace_id') IS r.workspace_id
      AND json_extract(NEW.document_json,'$.impact.workspace_revision') IS r.expected_revision)))
    THEN RAISE(ABORT,'correction impact result binding differs') END;
END;
CREATE TRIGGER investor_correction_impact_request_update BEFORE UPDATE ON investor_correction_impact_requests BEGIN SELECT RAISE(ABORT,'correction impact request immutable'); END;
CREATE TRIGGER investor_correction_impact_request_delete BEFORE DELETE ON investor_correction_impact_requests BEGIN SELECT RAISE(ABORT,'correction impact request immutable'); END;
CREATE TRIGGER investor_correction_impact_result_update BEFORE UPDATE ON investor_correction_impact_results BEGIN SELECT RAISE(ABORT,'correction impact result immutable'); END;
CREATE TRIGGER investor_correction_impact_result_delete BEFORE DELETE ON investor_correction_impact_results BEGIN SELECT RAISE(ABORT,'correction impact result immutable'); END;
