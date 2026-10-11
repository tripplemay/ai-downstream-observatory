CREATE TABLE investor_initial_price_requests (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, control_id TEXT NOT NULL,
  reference_input_id TEXT NOT NULL, listing_id TEXT NOT NULL, market TEXT NOT NULL CHECK(market IN ('CN','HK','US')), session_date TEXT NOT NULL,
  rights_review_id TEXT NOT NULL, listing_review_id TEXT NOT NULL, calendar_review_id TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=8192),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(model_id,workspace_id) REFERENCES investor_models(id,workspace_id),
  FOREIGN KEY(control_id,workspace_id,model_id) REFERENCES investor_model_controls(id,workspace_id,model_id),
  FOREIGN KEY(reference_input_id,workspace_id) REFERENCES investor_evidence_inputs(id,workspace_id),
  FOREIGN KEY(rights_review_id,workspace_id) REFERENCES investor_data_reviews(id,workspace_id),
  FOREIGN KEY(listing_review_id,workspace_id) REFERENCES investor_data_reviews(id,workspace_id),
  FOREIGN KEY(calendar_review_id,workspace_id) REFERENCES investor_data_reviews(id,workspace_id),
  UNIQUE(model_id,listing_id,session_date), UNIQUE(id,workspace_id,model_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-initial-price-request-v1'),
  CHECK(json_extract(document_json,'$.engine_version') IS 'investor-initial-price-producer-v1'),
  CHECK(json_extract(document_json,'$.workspace_id') IS workspace_id AND json_extract(document_json,'$.model_id') IS model_id),
  CHECK(json_extract(document_json,'$.control_id') IS control_id AND json_extract(document_json,'$.reference_input_id') IS reference_input_id),
  CHECK(json_extract(document_json,'$.listing_id') IS listing_id AND json_extract(document_json,'$.market') IS market AND json_extract(document_json,'$.session_date') IS session_date),
  CHECK(json_extract(document_json,'$.rights_review_id') IS rights_review_id AND json_extract(document_json,'$.listing_review_id') IS listing_review_id
    AND json_extract(document_json,'$.calendar_review_id') IS calendar_review_id),
  CHECK(json_extract(document_json,'$.live_advice_eligible') IS 0)
);
CREATE TABLE investor_initial_price_runs (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id), capture_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('collected','already_available','superseded','transport_failed')),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=4096),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(request_id,workspace_id,model_id) REFERENCES investor_initial_price_requests(id,workspace_id,model_id),
  FOREIGN KEY(capture_id,workspace_id) REFERENCES investor_price_captures(id,workspace_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-initial-price-run-v1'),
  CHECK(json_extract(document_json,'$.request_id') IS request_id AND json_extract(document_json,'$.job_id') IS job_id),
  CHECK(json_extract(document_json,'$.capture_id') IS capture_id AND json_extract(document_json,'$.status') IS status),
  CHECK(json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.live_advice_eligible') IS 0),
  CHECK(json_extract(document_json,'$.reason_code') IS CASE status WHEN 'collected' THEN 'INITIAL_PRICE_COLLECTED'
    WHEN 'already_available' THEN 'INITIAL_PRICE_ALREADY_AVAILABLE' WHEN 'superseded' THEN 'INITIAL_PRICE_SUPERSEDED' ELSE 'INITIAL_PRICE_TRANSPORT_FAILED' END),
  CHECK((json_extract(document_json,'$.receipt_hash') IS NOT NULL)=(capture_id IS NOT NULL)),
  CHECK((capture_id IS NOT NULL)=(status='collected'))
);
CREATE INDEX investor_initial_price_request_order ON investor_initial_price_requests(created_at,id);
CREATE TRIGGER investor_initial_price_request_insert BEFORE INSERT ON investor_initial_price_requests BEGIN
  SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NOT EXISTS(SELECT 1 FROM investor_models m JOIN investor_evidence_inputs i ON i.workspace_id=m.workspace_id
      WHERE m.id=NEW.model_id AND m.workspace_id=NEW.workspace_id AND i.id=NEW.reference_input_id AND i.created_at<=NEW.created_at
      AND m.created_at<=NEW.created_at AND m.content_hash IS json_extract(NEW.document_json,'$.model_hash')
      AND i.content_hash IS json_extract(NEW.document_json,'$.reference_input_hash'))
    OR NOT EXISTS(SELECT 1 FROM investor_model_controls WHERE id=NEW.control_id AND workspace_id=NEW.workspace_id
      AND model_id=NEW.model_id AND enabled=1 AND created_at<=NEW.created_at)
    OR NOT EXISTS(SELECT 1 FROM audit_events WHERE id=NEW.audit_id AND actor_id=NEW.actor_id AND action='investor_schedule_initial_price'
      AND object_type='investor_initial_price_request' AND object_id=NEW.id AND created_at=NEW.created_at
      AND json_extract(payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'initial price request binding differs') END;
END;
CREATE TRIGGER investor_initial_price_request_update BEFORE UPDATE ON investor_initial_price_requests BEGIN SELECT RAISE(ABORT,'initial price request is immutable'); END;
CREATE TRIGGER investor_initial_price_request_delete BEFORE DELETE ON investor_initial_price_requests BEGIN SELECT RAISE(ABORT,'initial price request is immutable'); END;
CREATE TRIGGER investor_initial_price_run_insert BEFORE INSERT ON investor_initial_price_runs BEGIN
  SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NOT EXISTS(SELECT 1 FROM investor_initial_price_requests r JOIN job_runs j ON j.period=r.id AND j.scope=r.workspace_id AND j.input_version=r.content_hash
      WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id AND r.model_id=NEW.model_id AND j.id=NEW.job_id
      AND j.job_type='investor_initial_prices' AND j.command_request_id IS NULL AND j.status='running' AND j.max_attempts=1
      AND r.created_at<=NEW.created_at AND j.created_at<=NEW.created_at AND json_extract(NEW.document_json,'$.request_hash') IS r.content_hash)
    OR (NEW.capture_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM investor_price_captures c JOIN investor_initial_price_requests r ON r.id=NEW.request_id
      WHERE c.id=NEW.capture_id AND c.workspace_id=NEW.workspace_id AND c.qualification='isolated_official_sdk' AND c.created_at<=NEW.created_at
      AND c.receipt_hash IS json_extract(NEW.document_json,'$.receipt_hash') AND c.rights_review_id=r.rights_review_id
      AND c.listing_review_id=r.listing_review_id AND c.calendar_review_id=r.calendar_review_id
      AND json_extract(c.receipt_json,'$.request.start_date') IS r.session_date AND json_extract(c.receipt_json,'$.request.end_date') IS r.session_date))
    OR NOT EXISTS(SELECT 1 FROM audit_events WHERE id=NEW.audit_id AND actor_id=NEW.actor_id AND action='investor_complete_initial_price'
      AND object_type='investor_initial_price_run' AND object_id=NEW.id AND created_at=NEW.created_at
      AND json_extract(payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'initial price run binding differs') END;
END;
CREATE TRIGGER investor_initial_price_run_update BEFORE UPDATE ON investor_initial_price_runs BEGIN SELECT RAISE(ABORT,'initial price run is immutable'); END;
CREATE TRIGGER investor_initial_price_run_delete BEFORE DELETE ON investor_initial_price_runs BEGIN SELECT RAISE(ABORT,'initial price run is immutable'); END;
