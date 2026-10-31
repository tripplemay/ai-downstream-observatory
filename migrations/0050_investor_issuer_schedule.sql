CREATE TABLE investor_issuer_schedules (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, authority_id TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=4096),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(authority_id,workspace_id) REFERENCES investor_issuer_authorities(id,workspace_id),
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,content_hash),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-issuer-schedule-policy-v1'),
  CHECK(json_extract(document_json,'$.authority_id') IS authority_id),
  CHECK(json_type(document_json,'$.standing_collection_authorized') IS 'true'
    AND json_type(document_json,'$.automatic_retry_permitted') IS 'false'
    AND json_extract(document_json,'$.collection_scope') IS 'unapproved_distribution_draft_only')
);
CREATE TABLE investor_issuer_schedule_controls (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, schedule_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 1000), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=4096),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(schedule_id,workspace_id) REFERENCES investor_issuer_schedules(id,workspace_id),
  UNIQUE(schedule_id,version), UNIQUE(id,workspace_id,schedule_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-issuer-schedule-control-v1'),
  CHECK(json_extract(document_json,'$.schedule_id') IS schedule_id AND json_extract(document_json,'$.version') IS version),
  CHECK(json_type(document_json,'$.enabled') IN ('true','false') AND json_extract(document_json,'$.enabled') IS enabled),
  CHECK(json_extract(document_json,'$.created_at') IS created_at)
);
CREATE TABLE investor_issuer_schedule_requests (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, schedule_id TEXT NOT NULL, control_id TEXT NOT NULL,
  issuer_request_id TEXT NOT NULL UNIQUE,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=8192),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>created_at), audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(control_id,workspace_id,schedule_id) REFERENCES investor_issuer_schedule_controls(id,workspace_id,schedule_id),
  FOREIGN KEY(issuer_request_id,workspace_id) REFERENCES investor_issuer_requests(id,workspace_id), UNIQUE(id,workspace_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-issuer-scheduled-request-v1'),
  CHECK(json_extract(document_json,'$.workspace_id') IS workspace_id AND json_extract(document_json,'$.schedule_id') IS schedule_id),
  CHECK(json_extract(document_json,'$.control_id') IS control_id AND json_extract(document_json,'$.issuer_request_id') IS issuer_request_id),
  CHECK(json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until)
);
CREATE TABLE investor_issuer_schedule_results (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id), capture_id TEXT NOT NULL UNIQUE,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=4096),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(request_id,workspace_id) REFERENCES investor_issuer_schedule_requests(id,workspace_id),
  FOREIGN KEY(capture_id,workspace_id) REFERENCES investor_issuer_captures(id,workspace_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-issuer-scheduled-result-v1'),
  CHECK(json_extract(document_json,'$.workspace_id') IS workspace_id AND json_extract(document_json,'$.request_id') IS request_id),
  CHECK(json_extract(document_json,'$.job_id') IS job_id AND json_extract(document_json,'$.capture_id') IS capture_id),
  CHECK(json_extract(document_json,'$.created_at') IS created_at AND json_type(document_json,'$.research_admitted') IS 'false')
);
CREATE INDEX investor_issuer_schedule_request_order ON investor_issuer_schedule_requests(created_at,id);
CREATE TRIGGER investor_issuer_schedule_insert BEFORE INSERT ON investor_issuer_schedules BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_issuer_schedules WHERE id=NEW.id OR (workspace_id=NEW.workspace_id AND content_hash=NEW.content_hash))
    OR NOT EXISTS(SELECT 1 FROM investor_issuer_authorities s JOIN investor_workspaces w ON w.id=s.workspace_id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE s.id=NEW.authority_id AND s.workspace_id=NEW.workspace_id AND s.actor_id=NEW.actor_id AND w.owner_id=NEW.actor_id
      AND json_extract(NEW.document_json,'$.authority_hash') IS s.content_hash AND s.created_at<=NEW.created_at
      AND a.actor_id=NEW.actor_id AND a.action='investor_register_issuer_schedule' AND a.object_type='investor_issuer_schedule'
      AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'issuer schedule audit differs') END;
END;
CREATE TRIGGER investor_issuer_schedule_control_insert BEFORE INSERT ON investor_issuer_schedule_controls BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_issuer_schedule_controls WHERE id=NEW.id OR (schedule_id=NEW.schedule_id AND version=NEW.version))
    OR NEW.version IS NOT COALESCE((SELECT max(version)+1 FROM investor_issuer_schedule_controls WHERE schedule_id=NEW.schedule_id),1)
    OR NOT EXISTS(SELECT 1 FROM investor_issuer_schedules s JOIN audit_events a ON a.id=NEW.audit_id
      WHERE s.id=NEW.schedule_id AND s.workspace_id=NEW.workspace_id AND s.actor_id=NEW.actor_id AND s.created_at<=NEW.created_at
      AND json_extract(NEW.document_json,'$.schedule_hash') IS s.content_hash
      AND a.actor_id=NEW.actor_id AND a.action='investor_control_issuer_schedule' AND a.object_type='investor_issuer_schedule_control'
      AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'issuer schedule control audit differs') END;
END;
CREATE TRIGGER investor_issuer_schedule_request_insert BEFORE INSERT ON investor_issuer_schedule_requests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_issuer_schedule_requests WHERE id=NEW.id OR issuer_request_id=NEW.issuer_request_id)
    OR NOT EXISTS(SELECT 1 FROM investor_issuer_schedules s JOIN investor_issuer_schedule_controls c ON c.schedule_id=s.id AND c.workspace_id=s.workspace_id
      JOIN investor_issuer_requests r ON r.id=NEW.issuer_request_id AND r.workspace_id=s.workspace_id AND r.authority_id=s.authority_id
      JOIN audit_events a ON a.id=NEW.audit_id WHERE s.id=NEW.schedule_id AND s.workspace_id=NEW.workspace_id AND s.actor_id=NEW.actor_id
      AND c.id=NEW.control_id AND c.enabled=1 AND c.version=(SELECT max(version) FROM investor_issuer_schedule_controls WHERE schedule_id=s.id)
      AND s.created_at<=NEW.created_at AND c.created_at<=NEW.created_at AND r.created_at=NEW.created_at
      AND json_extract(NEW.document_json,'$.schedule_hash') IS s.content_hash AND json_extract(NEW.document_json,'$.control_hash') IS c.content_hash
      AND json_extract(NEW.document_json,'$.issuer_request_hash') IS r.content_hash
      AND a.actor_id=NEW.actor_id AND a.action='investor_schedule_issuer_capture' AND a.object_type='investor_issuer_schedule_request'
      AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'issuer scheduled request audit differs') END;
END;
CREATE TRIGGER investor_issuer_schedule_result_insert BEFORE INSERT ON investor_issuer_schedule_results BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_issuer_schedule_results WHERE id=NEW.id OR request_id=NEW.request_id OR job_id=NEW.job_id OR capture_id=NEW.capture_id)
    OR NOT EXISTS(SELECT 1 FROM investor_issuer_schedule_requests r JOIN investor_issuer_captures c ON c.request_id=r.issuer_request_id AND c.workspace_id=r.workspace_id
      JOIN job_runs j ON j.id=NEW.job_id JOIN job_attempts t ON t.job_id=j.id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id AND r.actor_id=NEW.actor_id AND c.id=NEW.capture_id AND c.created_at=NEW.created_at
      AND j.job_type='investor_issuer_capture' AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
      AND j.command_request_id IS NULL AND j.max_attempts=1 AND j.status='running' AND t.attempt=j.attempt_count AND t.status='running'
      AND t.fencing_token=j.fencing_token AND json_extract(NEW.document_json,'$.fencing_token') IS j.fencing_token
      AND json_extract(NEW.document_json,'$.request_hash') IS r.content_hash AND json_extract(NEW.document_json,'$.capture_hash') IS c.content_hash
      AND json_extract(NEW.document_json,'$.status') IS c.status
      AND a.actor_id=NEW.actor_id AND a.action='investor_finish_issuer_schedule' AND a.object_type='investor_issuer_schedule_result'
      AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'issuer scheduled result binding differs') END;
END;
CREATE TRIGGER investor_issuer_schedule_update BEFORE UPDATE ON investor_issuer_schedules BEGIN SELECT RAISE(ABORT,'issuer schedule is immutable'); END;
CREATE TRIGGER investor_issuer_schedule_delete BEFORE DELETE ON investor_issuer_schedules BEGIN SELECT RAISE(ABORT,'issuer schedule is immutable'); END;
CREATE TRIGGER investor_issuer_schedule_control_update BEFORE UPDATE ON investor_issuer_schedule_controls BEGIN SELECT RAISE(ABORT,'issuer schedule control is immutable'); END;
CREATE TRIGGER investor_issuer_schedule_control_delete BEFORE DELETE ON investor_issuer_schedule_controls BEGIN SELECT RAISE(ABORT,'issuer schedule control is immutable'); END;
CREATE TRIGGER investor_issuer_schedule_request_update BEFORE UPDATE ON investor_issuer_schedule_requests BEGIN SELECT RAISE(ABORT,'issuer scheduled request is immutable'); END;
CREATE TRIGGER investor_issuer_schedule_request_delete BEFORE DELETE ON investor_issuer_schedule_requests BEGIN SELECT RAISE(ABORT,'issuer scheduled request is immutable'); END;
CREATE TRIGGER investor_issuer_schedule_result_update BEFORE UPDATE ON investor_issuer_schedule_results BEGIN SELECT RAISE(ABORT,'issuer scheduled result is immutable'); END;
CREATE TRIGGER investor_issuer_schedule_result_delete BEFORE DELETE ON investor_issuer_schedule_results BEGIN SELECT RAISE(ABORT,'issuer scheduled result is immutable'); END;
