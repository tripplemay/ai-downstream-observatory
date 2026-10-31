CREATE TABLE investor_issuer_authorities (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,content_hash),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-issuer-authority-v1'),
  CHECK(json_extract(document_json,'$.provider') IS 'vanguard_issuer_distributions'),
  CHECK(json_extract(document_json,'$.authorization_basis') IS 'owner_declared_private_use_not_provider_certified'),
  CHECK(json_extract(document_json,'$.collection_cadence') IS 'at_most_one_request_per_issuer_day')
);
CREATE TABLE investor_issuer_controls (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, authority_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>=1), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=4096),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(authority_id,workspace_id) REFERENCES investor_issuer_authorities(id,workspace_id),
  UNIQUE(authority_id,version), UNIQUE(id,workspace_id,authority_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-issuer-control-v1'),
  CHECK(json_extract(document_json,'$.authority_id') IS authority_id AND json_extract(document_json,'$.version') IS version),
  CHECK(json_type(document_json,'$.enabled') IN ('true','false') AND json_extract(document_json,'$.enabled') IS enabled),
  CHECK(json_extract(document_json,'$.created_at') IS created_at)
);
CREATE TABLE investor_issuer_requests (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, authority_id TEXT NOT NULL, control_id TEXT NOT NULL,
  request_key TEXT NOT NULL CHECK(length(request_key)=32 AND request_key NOT GLOB '*[^a-f0-9]*'),
  fund_id TEXT NOT NULL CHECK(length(fund_id)=4 AND fund_id NOT GLOB '*[^0-9]*'), issuer_day TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=8192),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(control_id,workspace_id,authority_id) REFERENCES investor_issuer_controls(id,workspace_id,authority_id),
  UNIQUE(workspace_id,request_key), UNIQUE(workspace_id,fund_id,issuer_day), UNIQUE(id,workspace_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-issuer-request-v1'),
  CHECK(json_extract(document_json,'$.authority_id') IS authority_id AND json_extract(document_json,'$.control_id') IS control_id),
  CHECK(json_extract(document_json,'$.request_key') IS request_key AND json_extract(document_json,'$.issuer_day') IS issuer_day),
  CHECK(json_extract(document_json,'$.fund_id') IS fund_id),
  CHECK(json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.collection_scope') IS 'unapproved_distribution_draft_only')
);
CREATE TABLE investor_issuer_captures (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
  qualification TEXT NOT NULL CHECK(qualification IN ('isolated_fixed_issuer_https','injected_test_issuer')),
  status TEXT NOT NULL CHECK(status IN ('captured','transport_failed','superseded')),
  raw_sha256 TEXT, raw_bytes INTEGER,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, retain_until TEXT, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(request_id,workspace_id) REFERENCES investor_issuer_requests(id,workspace_id),
  UNIQUE(id,workspace_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-issuer-capture-v1'),
  CHECK(json_extract(document_json,'$.capture_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id),
  CHECK(json_extract(document_json,'$.request_id') IS request_id AND json_extract(document_json,'$.qualification') IS qualification),
  CHECK(json_extract(document_json,'$.status') IS status AND json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_extract(document_json,'$.raw_sha256') IS raw_sha256 AND json_extract(document_json,'$.raw_bytes') IS raw_bytes),
  CHECK(json_extract(document_json,'$.retain_until') IS retain_until),
  CHECK(json_type(document_json,'$.owner_reviewed') IS 'false' AND json_type(document_json,'$.research_admitted') IS 'false'
    AND json_type(document_json,'$.corporate_actions_complete') IS 'false' AND json_type(document_json,'$.live_advice_eligible') IS 'false'),
  CHECK((status='captured' AND typeof(raw_sha256)='text' AND length(raw_sha256)=64 AND raw_sha256 NOT GLOB '*[^a-f0-9]*'
    AND typeof(raw_bytes)='integer' AND raw_bytes BETWEEN 1 AND 1048576 AND typeof(retain_until)='text' AND retain_until>created_at
    AND json_extract(document_json,'$.reason_code') IS 'ISSUER_DRAFT_CAPTURED')
    OR (status!='captured' AND raw_sha256 IS NULL AND raw_bytes IS NULL AND retain_until IS NULL))
);
CREATE TABLE investor_issuer_payloads (
  workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id),
  raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256)=64 AND raw_sha256 NOT GLOB '*[^a-f0-9]*'),
  raw_bytes INTEGER NOT NULL CHECK(raw_bytes BETWEEN 1 AND 1048576),
  payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload)=raw_bytes), created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,raw_sha256)
);
CREATE TABLE investor_issuer_purges (
  capture_id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('retention_expired','authority_no_longer_active')),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(capture_id,workspace_id) REFERENCES investor_issuer_captures(id,workspace_id)
);
CREATE INDEX investor_issuer_capture_retention ON investor_issuer_captures(retain_until,id);
CREATE INDEX investor_issuer_capture_payload_refs ON investor_issuer_captures(workspace_id,raw_sha256,id);
CREATE INDEX investor_issuer_request_order ON investor_issuer_requests(workspace_id,authority_id,created_at,id);
CREATE TRIGGER investor_issuer_authority_insert BEFORE INSERT ON investor_issuer_authorities BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_issuer_authorities WHERE id=NEW.id OR (workspace_id=NEW.workspace_id AND content_hash=NEW.content_hash))
    OR NOT EXISTS(SELECT 1 FROM investor_workspaces w JOIN audit_events a ON a.id=NEW.audit_id
      WHERE w.id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND a.actor_id=NEW.actor_id
      AND a.action='investor_register_issuer_authority' AND a.object_type='investor_issuer_authority' AND a.object_id=NEW.id
      AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'issuer authority audit differs') END;
END;
CREATE TRIGGER investor_issuer_control_insert BEFORE INSERT ON investor_issuer_controls BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_issuer_controls WHERE id=NEW.id OR (authority_id=NEW.authority_id AND version=NEW.version))
    OR NEW.version IS NOT COALESCE((SELECT max(version)+1 FROM investor_issuer_controls WHERE authority_id=NEW.authority_id),1)
    OR NOT EXISTS(SELECT 1 FROM investor_issuer_authorities s JOIN investor_workspaces w ON w.id=s.workspace_id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE s.id=NEW.authority_id AND s.workspace_id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND s.actor_id=NEW.actor_id AND s.created_at<=NEW.created_at
      AND json_extract(NEW.document_json,'$.authority_hash') IS s.content_hash
      AND a.actor_id=NEW.actor_id AND a.action='investor_control_issuer_authority' AND a.object_type='investor_issuer_control' AND a.object_id=NEW.id
      AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'issuer control audit differs') END;
END;
CREATE TRIGGER investor_issuer_request_insert BEFORE INSERT ON investor_issuer_requests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_issuer_requests WHERE id=NEW.id OR (workspace_id=NEW.workspace_id AND request_key=NEW.request_key)
      OR (workspace_id=NEW.workspace_id AND fund_id=NEW.fund_id AND issuer_day=NEW.issuer_day))
    OR NOT EXISTS(SELECT 1 FROM investor_issuer_authorities s JOIN investor_issuer_controls c ON c.authority_id=s.id AND c.workspace_id=s.workspace_id
      JOIN investor_workspaces w ON w.id=s.workspace_id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE s.id=NEW.authority_id AND s.workspace_id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND s.actor_id=NEW.actor_id
      AND s.created_at<=NEW.created_at AND c.id=NEW.control_id AND c.enabled=1 AND c.created_at<=NEW.created_at
      AND json_extract(s.document_json,'$.fund_id') IS NEW.fund_id
      AND c.version=(SELECT max(version) FROM investor_issuer_controls WHERE authority_id=s.id)
      AND json_extract(NEW.document_json,'$.authority_hash') IS s.content_hash AND json_extract(NEW.document_json,'$.control_hash') IS c.content_hash
      AND a.actor_id=NEW.actor_id AND a.action='investor_start_issuer_capture' AND a.object_type='investor_issuer_request' AND a.object_id=NEW.id
      AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'issuer request audit differs') END;
END;
CREATE TRIGGER investor_issuer_capture_insert BEFORE INSERT ON investor_issuer_captures BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_issuer_captures WHERE id=NEW.id OR request_id=NEW.request_id)
    OR NOT EXISTS(SELECT 1 FROM investor_issuer_requests r JOIN investor_workspaces w ON w.id=r.workspace_id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND r.actor_id=NEW.actor_id
      AND r.created_at<=NEW.created_at AND json_extract(NEW.document_json,'$.request_hash') IS r.content_hash
      AND a.actor_id=NEW.actor_id AND a.action='investor_finish_issuer_capture' AND a.object_type='investor_issuer_capture' AND a.object_id=NEW.id
      AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'issuer capture audit differs') END;
END;
CREATE TRIGGER investor_issuer_payload_insert BEFORE INSERT ON investor_issuer_payloads BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_issuer_payloads WHERE workspace_id=NEW.workspace_id AND raw_sha256=NEW.raw_sha256)
    OR NOT EXISTS(SELECT 1 FROM investor_issuer_captures c WHERE c.workspace_id=NEW.workspace_id AND c.raw_sha256=NEW.raw_sha256
      AND c.raw_bytes=NEW.raw_bytes AND c.status='captured' AND c.created_at=NEW.created_at
      AND NOT EXISTS(SELECT 1 FROM investor_issuer_purges p WHERE p.capture_id=c.id))
    THEN RAISE(ABORT,'issuer payload requires a capture') END;
END;
CREATE TRIGGER investor_issuer_payload_delete BEFORE DELETE ON investor_issuer_payloads BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_issuer_captures c WHERE c.workspace_id=OLD.workspace_id AND c.raw_sha256=OLD.raw_sha256
      AND NOT EXISTS(SELECT 1 FROM investor_issuer_purges p WHERE p.capture_id=c.id))
    THEN RAISE(ABORT,'issuer payload still referenced') END;
END;
CREATE TRIGGER investor_issuer_purge_insert BEFORE INSERT ON investor_issuer_purges BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_issuer_purges WHERE capture_id=NEW.capture_id)
    OR NOT EXISTS(SELECT 1 FROM investor_issuer_captures c JOIN investor_workspaces w ON w.id=c.workspace_id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE c.id=NEW.capture_id AND c.workspace_id=NEW.workspace_id AND c.status='captured' AND c.created_at<=NEW.created_at
      AND w.owner_id=NEW.actor_id AND c.actor_id=NEW.actor_id AND a.actor_id=NEW.actor_id
      AND a.action='investor_purge_issuer_capture' AND a.object_type='investor_issuer_capture' AND a.object_id=c.id
      AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.reason') IS NEW.reason)
    THEN RAISE(ABORT,'issuer purge audit differs') END;
END;
CREATE TRIGGER investor_issuer_authority_update BEFORE UPDATE ON investor_issuer_authorities BEGIN SELECT RAISE(ABORT,'issuer authority is immutable'); END;
CREATE TRIGGER investor_issuer_authority_delete BEFORE DELETE ON investor_issuer_authorities BEGIN SELECT RAISE(ABORT,'issuer authority is immutable'); END;
CREATE TRIGGER investor_issuer_control_update BEFORE UPDATE ON investor_issuer_controls BEGIN SELECT RAISE(ABORT,'issuer control is immutable'); END;
CREATE TRIGGER investor_issuer_control_delete BEFORE DELETE ON investor_issuer_controls BEGIN SELECT RAISE(ABORT,'issuer control is immutable'); END;
CREATE TRIGGER investor_issuer_request_update BEFORE UPDATE ON investor_issuer_requests BEGIN SELECT RAISE(ABORT,'issuer request is immutable'); END;
CREATE TRIGGER investor_issuer_request_delete BEFORE DELETE ON investor_issuer_requests BEGIN SELECT RAISE(ABORT,'issuer request is immutable'); END;
CREATE TRIGGER investor_issuer_capture_update BEFORE UPDATE ON investor_issuer_captures BEGIN SELECT RAISE(ABORT,'issuer capture is immutable'); END;
CREATE TRIGGER investor_issuer_capture_delete BEFORE DELETE ON investor_issuer_captures BEGIN SELECT RAISE(ABORT,'issuer capture is immutable'); END;
CREATE TRIGGER investor_issuer_payload_update BEFORE UPDATE ON investor_issuer_payloads BEGIN SELECT RAISE(ABORT,'issuer payload is immutable'); END;
CREATE TRIGGER investor_issuer_purge_update BEFORE UPDATE ON investor_issuer_purges BEGIN SELECT RAISE(ABORT,'issuer purge is immutable'); END;
CREATE TRIGGER investor_issuer_purge_delete BEFORE DELETE ON investor_issuer_purges BEGIN SELECT RAISE(ABORT,'issuer purge is immutable'); END;
