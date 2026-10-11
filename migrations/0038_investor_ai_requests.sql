CREATE TABLE investor_ai_requests (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL,
  observation_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  binding_hash TEXT NOT NULL CHECK(length(binding_hash)=64 AND binding_hash NOT GLOB '*[^a-f0-9]*'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB)) BETWEEN 1 AND 4096),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>created_at),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,binding_hash),
  FOREIGN KEY(observation_id,workspace_id) REFERENCES investor_observations(id,workspace_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-ai-request-v1'),
  CHECK(json_extract(document_json,'$.id') IS id),
  CHECK(json_extract(document_json,'$.workspace_id') IS workspace_id),
  CHECK(json_extract(document_json,'$.observation_id') IS observation_id),
  CHECK(json_extract(document_json,'$.actor_id') IS actor_id),
  CHECK(json_extract(document_json,'$.binding_hash') IS binding_hash),
  CHECK(json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_extract(document_json,'$.valid_until') IS valid_until)
);
CREATE TABLE investor_ai_dispatches (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES investor_ai_requests(id),
  token TEXT NOT NULL UNIQUE CHECK(length(token)=48 AND token NOT GLOB '*[^a-f0-9]*'),
  started_at TEXT NOT NULL, deadline TEXT NOT NULL CHECK(deadline>started_at),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id)
);
CREATE TABLE investor_ai_outcomes (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES investor_ai_dispatches(request_id),
  token TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('complete','failed','unknown')),
  reason_code TEXT, review_hash TEXT CHECK(review_hash IS NULL OR (length(review_hash)=64 AND review_hash NOT GLOB '*[^a-f0-9]*')),
  created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  CHECK((status='complete' AND reason_code IS NULL AND review_hash IS NOT NULL)
    OR (status!='complete' AND reason_code IS NOT NULL AND review_hash IS NULL)),
  CHECK(reason_code IS NULL OR (length(reason_code) BETWEEN 1 AND 80 AND reason_code NOT GLOB '*[^A-Z0-9_]*')),
  CHECK(status!='unknown' OR reason_code='INVESTOR_AI_OUTCOME_UNKNOWN')
);
CREATE TABLE investor_ai_payloads (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES investor_ai_outcomes(request_id),
  payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload) BETWEEN 1 AND 16384)
);
CREATE TABLE investor_ai_purges (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES investor_ai_requests(id),
  actor_id TEXT NOT NULL, reason TEXT NOT NULL CHECK(reason IN ('retention_expired','binding_changed')),
  created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id)
);
CREATE INDEX investor_ai_expiry ON investor_ai_requests(valid_until);
CREATE INDEX investor_ai_actor ON investor_ai_requests(actor_id);
CREATE INDEX investor_ai_deadlines ON investor_ai_dispatches(deadline);
CREATE TRIGGER investor_ai_request_insert BEFORE INSERT ON investor_ai_requests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_ai_requests WHERE id=NEW.id OR audit_id=NEW.audit_id
      OR (workspace_id=NEW.workspace_id AND binding_hash=NEW.binding_hash))
    OR NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NOT EXISTS(SELECT 1 FROM investor_observations WHERE id=NEW.observation_id AND workspace_id=NEW.workspace_id AND created_at<=NEW.created_at)
    OR NOT EXISTS(SELECT 1 FROM audit_events WHERE id=NEW.audit_id AND actor_id=NEW.actor_id AND action='investor_ai_request'
      AND object_type='investor_ai_request' AND object_id=NEW.id AND portfolio_id IS NULL AND ledger_revision IS NULL
      AND created_at=NEW.created_at AND json_extract(payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'AI request scope or audit differs') END;
END;
CREATE TRIGGER investor_ai_request_update BEFORE UPDATE ON investor_ai_requests BEGIN SELECT RAISE(ABORT,'AI request is immutable'); END;
CREATE TRIGGER investor_ai_request_delete BEFORE DELETE ON investor_ai_requests BEGIN SELECT RAISE(ABORT,'AI request is immutable'); END;
CREATE TRIGGER investor_ai_dispatch_insert BEFORE INSERT ON investor_ai_dispatches BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_ai_dispatches WHERE request_id=NEW.request_id OR token=NEW.token OR audit_id=NEW.audit_id)
    OR (SELECT count(*) FROM investor_ai_dispatches d LEFT JOIN investor_ai_outcomes o ON o.request_id=d.request_id
      WHERE o.request_id IS NULL AND d.deadline>NEW.started_at)>=2
    OR EXISTS(SELECT 1 FROM investor_ai_dispatches d JOIN investor_ai_requests r ON r.id=d.request_id
      LEFT JOIN investor_ai_outcomes o ON o.request_id=d.request_id
      WHERE o.request_id IS NULL AND d.deadline>NEW.started_at
        AND r.workspace_id=(SELECT workspace_id FROM investor_ai_requests WHERE id=NEW.request_id))
    OR NOT EXISTS(SELECT 1 FROM investor_ai_requests r JOIN audit_events a ON a.id=NEW.audit_id
      WHERE r.id=NEW.request_id AND r.created_at<=NEW.started_at AND NEW.deadline<=r.valid_until
        AND julianday(NEW.deadline)-julianday(NEW.started_at)<=45.001/86400
        AND a.actor_id=r.actor_id AND a.action='investor_ai_dispatch' AND a.object_type='investor_ai_request' AND a.object_id=r.id
        AND a.portfolio_id IS NULL AND a.ledger_revision IS NULL AND a.created_at=NEW.started_at
        AND json_extract(a.payload_json,'$.token') IS NEW.token AND json_extract(a.payload_json,'$.deadline') IS NEW.deadline)
    THEN RAISE(ABORT,'AI dispatch binding differs') END;
END;
CREATE TRIGGER investor_ai_dispatch_update BEFORE UPDATE ON investor_ai_dispatches BEGIN SELECT RAISE(ABORT,'AI dispatch cannot be retried'); END;
CREATE TRIGGER investor_ai_dispatch_delete BEFORE DELETE ON investor_ai_dispatches BEGIN SELECT RAISE(ABORT,'AI dispatch cannot be retried'); END;
CREATE TRIGGER investor_ai_outcome_insert BEFORE INSERT ON investor_ai_outcomes BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_ai_outcomes WHERE request_id=NEW.request_id OR audit_id=NEW.audit_id)
    OR NOT EXISTS(SELECT 1 FROM investor_ai_dispatches d JOIN investor_ai_requests r ON r.id=d.request_id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE d.request_id=NEW.request_id AND d.token=NEW.token AND NEW.created_at>=d.started_at
        AND (NEW.status!='complete' OR (NEW.created_at<d.deadline AND NEW.created_at<r.valid_until
          AND NOT EXISTS(SELECT 1 FROM investor_ai_purges WHERE request_id=r.id)))
        AND (NEW.status!='unknown' OR NEW.created_at>=d.deadline)
        AND a.actor_id=r.actor_id AND a.action='investor_ai_outcome' AND a.object_type='investor_ai_request' AND a.object_id=r.id
        AND a.portfolio_id IS NULL AND a.ledger_revision IS NULL AND a.created_at=NEW.created_at
        AND json_extract(a.payload_json,'$.token') IS NEW.token AND json_extract(a.payload_json,'$.status') IS NEW.status
        AND json_extract(a.payload_json,'$.reason_code') IS NEW.reason_code AND json_extract(a.payload_json,'$.review_hash') IS NEW.review_hash)
    THEN RAISE(ABORT,'AI outcome fence or audit differs') END;
END;
CREATE TRIGGER investor_ai_outcome_update BEFORE UPDATE ON investor_ai_outcomes BEGIN SELECT RAISE(ABORT,'AI outcome is immutable'); END;
CREATE TRIGGER investor_ai_outcome_delete BEFORE DELETE ON investor_ai_outcomes BEGIN SELECT RAISE(ABORT,'AI outcome is immutable'); END;
CREATE TRIGGER investor_ai_payload_insert BEFORE INSERT ON investor_ai_payloads BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_ai_payloads WHERE request_id=NEW.request_id)
    OR (SELECT count(*) FROM investor_ai_payloads)>=64
    OR EXISTS(SELECT 1 FROM investor_ai_purges WHERE request_id=NEW.request_id)
    OR NOT EXISTS(SELECT 1 FROM investor_ai_outcomes WHERE request_id=NEW.request_id AND status='complete')
    THEN RAISE(ABORT,'AI payload cannot be replaced or resurrected') END;
END;
CREATE TRIGGER investor_ai_payload_update BEFORE UPDATE ON investor_ai_payloads BEGIN SELECT RAISE(ABORT,'AI payload is immutable'); END;
CREATE TRIGGER investor_ai_payload_delete BEFORE DELETE ON investor_ai_payloads BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM investor_ai_purges WHERE request_id=OLD.request_id)
    THEN RAISE(ABORT,'AI payload requires purge') END;
END;
CREATE TRIGGER investor_ai_purge_insert BEFORE INSERT ON investor_ai_purges BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_ai_purges WHERE request_id=NEW.request_id OR audit_id=NEW.audit_id)
    OR NOT EXISTS(SELECT 1 FROM investor_ai_requests r JOIN audit_events a ON a.id=NEW.audit_id
      WHERE r.id=NEW.request_id AND r.actor_id=NEW.actor_id AND NEW.created_at>=r.created_at
        AND (NEW.reason!='retention_expired' OR NEW.created_at>=r.valid_until)
        AND a.actor_id=r.actor_id AND a.action='investor_ai_purge' AND a.object_type='investor_ai_request' AND a.object_id=r.id
        AND a.portfolio_id IS NULL AND a.ledger_revision IS NULL AND a.created_at=NEW.created_at
        AND json_extract(a.payload_json,'$.reason') IS NEW.reason)
    THEN RAISE(ABORT,'AI purge scope or audit differs') END;
END;
CREATE TRIGGER investor_ai_purge_update BEFORE UPDATE ON investor_ai_purges BEGIN SELECT RAISE(ABORT,'AI purge is immutable'); END;
CREATE TRIGGER investor_ai_purge_delete BEFORE DELETE ON investor_ai_purges BEGIN SELECT RAISE(ABORT,'AI purge is immutable'); END;
