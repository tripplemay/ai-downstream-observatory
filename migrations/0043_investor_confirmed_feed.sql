CREATE TABLE investor_confirmed_feed_requests (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, control_id TEXT NOT NULL, input_id TEXT NOT NULL,
  market TEXT NOT NULL CHECK(market IN ('CN','HK','US')), session_date TEXT NOT NULL,
  not_before TEXT NOT NULL, latest_start TEXT NOT NULL CHECK(latest_start>=not_before), stop_at TEXT NOT NULL CHECK(stop_at>latest_start),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(model_id,workspace_id) REFERENCES investor_models(id,workspace_id),
  FOREIGN KEY(control_id,workspace_id,model_id) REFERENCES investor_model_controls(id,workspace_id,model_id),
  FOREIGN KEY(input_id,workspace_id,model_id) REFERENCES investor_monitor_evidence_inputs(id,workspace_id,model_id),
  UNIQUE(model_id,market,session_date), UNIQUE(id,workspace_id,model_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-confirmed-feed-request-v1'),
  CHECK(json_extract(document_json,'$.engine_version') IS 'investor-confirmed-market-producer-v1'),
  CHECK(json_extract(document_json,'$.workspace_id') IS workspace_id AND json_extract(document_json,'$.model_id') IS model_id),
  CHECK(json_extract(document_json,'$.control_id') IS control_id AND json_extract(document_json,'$.input_id') IS input_id),
  CHECK(json_extract(document_json,'$.market') IS market AND json_extract(document_json,'$.session_date') IS session_date),
  CHECK(json_extract(document_json,'$.not_before') IS not_before AND json_extract(document_json,'$.latest_start') IS latest_start AND json_extract(document_json,'$.stop_at') IS stop_at),
  CHECK(json_extract(document_json,'$.live_advice_eligible') IS 0)
);
CREATE TABLE investor_confirmed_feed_runs (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id), capture_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('complete','partial','no_confirmed_events','missed_window','superseded','transport_failed')),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=4096),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(request_id,workspace_id,model_id) REFERENCES investor_confirmed_feed_requests(id,workspace_id,model_id),
  FOREIGN KEY(capture_id,workspace_id) REFERENCES investor_confirmed_captures(id,workspace_id),
  UNIQUE(id,workspace_id,model_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-confirmed-feed-run-v1'),
  CHECK(json_extract(document_json,'$.request_id') IS request_id AND json_extract(document_json,'$.job_id') IS job_id),
  CHECK(json_extract(document_json,'$.capture_id') IS capture_id AND json_extract(document_json,'$.status') IS status),
  CHECK(json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.live_advice_eligible') IS 0),
  CHECK(json_extract(document_json,'$.reason_code') IS CASE status WHEN 'complete' THEN 'CONFIRMED_FEED_COMPLETE'
    WHEN 'partial' THEN 'CONFIRMED_FEED_PARTIAL' WHEN 'no_confirmed_events' THEN 'CONFIRMED_FEED_NO_EVENTS'
    WHEN 'missed_window' THEN 'CONFIRMED_FEED_MISSED_WINDOW' WHEN 'superseded' THEN 'CONFIRMED_FEED_SUPERSEDED' ELSE 'CONFIRMED_FEED_TRANSPORT_FAILED' END),
  CHECK((json_extract(document_json,'$.receipt_hash') IS NOT NULL)=(capture_id IS NOT NULL)),
  CHECK((capture_id IS NOT NULL)=(status IN ('complete','partial','no_confirmed_events')))
);
CREATE TABLE investor_confirmed_feed_admissions (
  run_id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, input_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('admitted','blocked','superseded')),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=4096),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(run_id,workspace_id,model_id) REFERENCES investor_confirmed_feed_runs(id,workspace_id,model_id),
  FOREIGN KEY(input_id,workspace_id,model_id) REFERENCES investor_monitor_evidence_inputs(id,workspace_id,model_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-confirmed-feed-admission-v1'),
  CHECK(json_extract(document_json,'$.run_id') IS run_id AND json_extract(document_json,'$.input_id') IS input_id),
  CHECK(json_extract(document_json,'$.status') IS status AND json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_extract(document_json,'$.reason_code') IS CASE status WHEN 'admitted' THEN 'CONFIRMED_FEED_ADMITTED'
    WHEN 'blocked' THEN 'CONFIRMED_FEED_INPUT_GAP' ELSE 'CONFIRMED_FEED_SUPERSEDED' END),
  CHECK((json_extract(document_json,'$.input_hash') IS NOT NULL)=(input_id IS NOT NULL)),
  CHECK(json_extract(document_json,'$.live_advice_eligible') IS 0 AND (input_id IS NOT NULL)=(status='admitted'))
);
CREATE INDEX investor_confirmed_feed_due ON investor_confirmed_feed_requests(not_before,created_at,id);
CREATE TRIGGER investor_confirmed_feed_request_insert BEFORE INSERT ON investor_confirmed_feed_requests BEGIN
  SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NOT EXISTS(SELECT 1 FROM investor_models m JOIN investor_monitor_evidence_inputs i ON i.model_id=m.id AND i.workspace_id=m.workspace_id
      WHERE m.id=NEW.model_id AND m.workspace_id=NEW.workspace_id AND i.id=NEW.input_id AND i.created_at<=NEW.created_at
      AND m.created_at<=NEW.created_at AND m.content_hash IS json_extract(NEW.document_json,'$.model_hash') AND i.content_hash IS json_extract(NEW.document_json,'$.input_hash'))
    OR NOT EXISTS(SELECT 1 FROM investor_model_controls WHERE id=NEW.control_id AND workspace_id=NEW.workspace_id
      AND model_id=NEW.model_id AND enabled=1 AND created_at<=NEW.created_at)
    OR NOT EXISTS(SELECT 1 FROM audit_events WHERE id=NEW.audit_id AND actor_id=NEW.actor_id AND action='investor_schedule_confirmed_feed'
      AND object_type='investor_confirmed_feed_request' AND object_id=NEW.id AND created_at=NEW.created_at AND json_extract(payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'confirmed feed request binding differs') END;
END;
CREATE TRIGGER investor_confirmed_feed_request_update BEFORE UPDATE ON investor_confirmed_feed_requests BEGIN SELECT RAISE(ABORT,'confirmed feed request is immutable'); END;
CREATE TRIGGER investor_confirmed_feed_request_delete BEFORE DELETE ON investor_confirmed_feed_requests BEGIN SELECT RAISE(ABORT,'confirmed feed request is immutable'); END;
CREATE TRIGGER investor_confirmed_feed_run_insert BEFORE INSERT ON investor_confirmed_feed_runs BEGIN
  SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NOT EXISTS(SELECT 1 FROM investor_confirmed_feed_requests r JOIN job_runs j ON j.period=r.id AND j.scope=r.workspace_id AND j.input_version=r.content_hash
      WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id AND r.model_id=NEW.model_id AND j.id=NEW.job_id
      AND j.job_type='investor_confirmed_watch' AND j.command_request_id IS NULL AND j.status='running' AND j.max_attempts=1
      AND r.created_at<=NEW.created_at AND j.created_at<=NEW.created_at
      AND json_extract(NEW.document_json,'$.request_hash') IS r.content_hash)
    OR (NEW.capture_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM investor_confirmed_captures c WHERE c.id=NEW.capture_id AND c.workspace_id=NEW.workspace_id
      AND c.qualification='isolated_official_sdk_callback' AND c.status=NEW.status AND c.created_at<=NEW.created_at
      AND c.receipt_hash IS json_extract(NEW.document_json,'$.receipt_hash')))
    OR NOT EXISTS(SELECT 1 FROM audit_events WHERE id=NEW.audit_id AND actor_id=NEW.actor_id AND action='investor_complete_confirmed_feed'
      AND object_type='investor_confirmed_feed_run' AND object_id=NEW.id AND created_at=NEW.created_at AND json_extract(payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'confirmed feed run binding differs') END;
END;
CREATE TRIGGER investor_confirmed_feed_run_update BEFORE UPDATE ON investor_confirmed_feed_runs BEGIN SELECT RAISE(ABORT,'confirmed feed run is immutable'); END;
CREATE TRIGGER investor_confirmed_feed_run_delete BEFORE DELETE ON investor_confirmed_feed_runs BEGIN SELECT RAISE(ABORT,'confirmed feed run is immutable'); END;
CREATE TRIGGER investor_confirmed_feed_admission_insert BEFORE INSERT ON investor_confirmed_feed_admissions BEGIN
  SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NOT EXISTS(SELECT 1 FROM investor_confirmed_feed_runs r JOIN job_runs j ON j.id=r.job_id WHERE r.id=NEW.run_id
      AND r.workspace_id=NEW.workspace_id AND r.model_id=NEW.model_id AND r.status='complete' AND j.status='succeeded'
      AND r.created_at<=NEW.created_at AND j.updated_at<=NEW.created_at
      AND json_extract(NEW.document_json,'$.run_hash') IS r.content_hash)
    OR (NEW.input_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM investor_monitor_evidence_inputs WHERE id=NEW.input_id AND workspace_id=NEW.workspace_id
      AND model_id=NEW.model_id AND created_at<=NEW.created_at AND content_hash IS json_extract(NEW.document_json,'$.input_hash')))
    OR NOT EXISTS(SELECT 1 FROM audit_events WHERE id=NEW.audit_id AND actor_id=NEW.actor_id AND action='investor_admit_confirmed_feed'
      AND object_type='investor_confirmed_feed_run' AND object_id=NEW.run_id AND created_at=NEW.created_at AND json_extract(payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'confirmed feed admission binding differs') END;
END;
CREATE TRIGGER investor_confirmed_feed_admission_update BEFORE UPDATE ON investor_confirmed_feed_admissions BEGIN SELECT RAISE(ABORT,'confirmed feed admission is immutable'); END;
CREATE TRIGGER investor_confirmed_feed_admission_delete BEFORE DELETE ON investor_confirmed_feed_admissions BEGIN SELECT RAISE(ABORT,'confirmed feed admission is immutable'); END;
