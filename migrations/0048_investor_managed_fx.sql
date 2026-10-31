CREATE TABLE investor_fx_authorities (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,content_hash),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-fx-authority-v1'),
  CHECK(json_extract(document_json,'$.provider') IS 'ecb_90d_reference'),
  CHECK(json_extract(document_json,'$.authorization_basis') IS 'owner_reviewed_standing_rule_not_provider_certified'),
  CHECK(json_type(document_json,'$.human_review_per_publication') IS 'false' AND json_type(document_json,'$.trading_permission') IS 'false')
);
CREATE TABLE investor_fx_controls (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, authority_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>=1), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=4096),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(authority_id,workspace_id) REFERENCES investor_fx_authorities(id,workspace_id),
  UNIQUE(authority_id,version), UNIQUE(id,workspace_id,authority_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-fx-control-v1'),
  CHECK(json_extract(document_json,'$.authority_id') IS authority_id AND json_extract(document_json,'$.version') IS version),
  CHECK(json_type(document_json,'$.enabled') IN ('true','false') AND json_extract(document_json,'$.enabled') IS enabled),
  CHECK(json_extract(document_json,'$.created_at') IS created_at)
);
CREATE TABLE investor_fx_requests (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, authority_id TEXT NOT NULL, control_id TEXT NOT NULL, feed_day TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=8192),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>created_at), audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(control_id,workspace_id,authority_id) REFERENCES investor_fx_controls(id,workspace_id,authority_id),
  UNIQUE(workspace_id,feed_day), UNIQUE(id,workspace_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-fx-request-v1'),
  CHECK(json_extract(document_json,'$.workspace_id') IS workspace_id AND json_extract(document_json,'$.authority_id') IS authority_id),
  CHECK(json_extract(document_json,'$.control_id') IS control_id AND json_extract(document_json,'$.feed_day') IS feed_day),
  CHECK(json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until)
);
CREATE TABLE investor_fx_captures (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id),
  status TEXT NOT NULL CHECK(status IN ('captured','transport_failed','superseded')), raw_sha256 TEXT, raw_bytes INTEGER, not_before TEXT,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, retain_until TEXT, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(request_id,workspace_id) REFERENCES investor_fx_requests(id,workspace_id), UNIQUE(id,workspace_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-fx-capture-v1'),
  CHECK(json_extract(document_json,'$.capture_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id),
  CHECK(json_extract(document_json,'$.request_id') IS request_id AND json_extract(document_json,'$.job_id') IS job_id),
  CHECK(json_extract(document_json,'$.status') IS status AND json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_extract(document_json,'$.raw_sha256') IS raw_sha256 AND json_extract(document_json,'$.raw_bytes') IS raw_bytes),
  CHECK(json_extract(document_json,'$.not_before') IS not_before AND json_extract(document_json,'$.retain_until') IS retain_until),
  CHECK(json_type(document_json,'$.owner_reviewed') IS 'false' AND json_type(document_json,'$.production_admitted') IS 'false'),
  CHECK((status='captured' AND typeof(raw_sha256)='text' AND length(raw_sha256)=64 AND raw_sha256 NOT GLOB '*[^a-f0-9]*'
    AND typeof(raw_bytes)='integer' AND raw_bytes BETWEEN 1 AND 2097152 AND typeof(retain_until)='text' AND retain_until>created_at AND typeof(not_before)='text')
    OR (status!='captured' AND raw_sha256 IS NULL AND raw_bytes IS NULL AND retain_until IS NULL AND not_before IS NULL))
);
CREATE TABLE investor_fx_payloads (
  workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id), raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256)=64 AND raw_sha256 NOT GLOB '*[^a-f0-9]*'),
  raw_bytes INTEGER NOT NULL CHECK(raw_bytes BETWEEN 1 AND 2097152), payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload)=raw_bytes),
  created_at TEXT NOT NULL, PRIMARY KEY(workspace_id,raw_sha256)
);
CREATE TABLE investor_fx_purges (
  capture_id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, reason TEXT NOT NULL CHECK(reason IN ('retention_expired','authority_no_longer_active')),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(capture_id,workspace_id) REFERENCES investor_fx_captures(id,workspace_id)
);
CREATE TABLE investor_fx_publications (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, authority_id TEXT NOT NULL, capture_id TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL CHECK(sequence>=1), previous_id TEXT, status TEXT NOT NULL CHECK(status IN ('published','unchanged','blocked')),
  usd_review_id TEXT UNIQUE, hkd_review_id TEXT UNIQUE,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(authority_id,workspace_id) REFERENCES investor_fx_authorities(id,workspace_id),
  FOREIGN KEY(capture_id,workspace_id) REFERENCES investor_fx_captures(id,workspace_id),
  FOREIGN KEY(previous_id,workspace_id,authority_id) REFERENCES investor_fx_publications(id,workspace_id,authority_id),
  FOREIGN KEY(usd_review_id,workspace_id) REFERENCES investor_data_reviews(id,workspace_id),
  FOREIGN KEY(hkd_review_id,workspace_id) REFERENCES investor_data_reviews(id,workspace_id),
  UNIQUE(id,workspace_id,authority_id), UNIQUE(authority_id,sequence),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-fx-publication-v1'),
  CHECK(json_extract(document_json,'$.publication_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id),
  CHECK(json_extract(document_json,'$.authority_id') IS authority_id AND json_extract(document_json,'$.capture_id') IS capture_id),
  CHECK(json_extract(document_json,'$.sequence') IS sequence AND json_extract(document_json,'$.previous_id') IS previous_id),
  CHECK(json_extract(document_json,'$.status') IS status AND json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_extract(document_json,'$.refs.USD.review_id') IS usd_review_id AND json_extract(document_json,'$.refs.HKD.review_id') IS hkd_review_id),
  CHECK(json_type(document_json,'$.human_review_performed') IS 'false' AND json_type(document_json,'$.trading_permission') IS 'false'),
  CHECK((status='published' AND (usd_review_id IS NOT NULL OR hkd_review_id IS NOT NULL)) OR (status!='published' AND usd_review_id IS NULL AND hkd_review_id IS NULL))
);
CREATE INDEX investor_fx_control_head ON investor_fx_controls(authority_id,version DESC);
CREATE INDEX investor_fx_request_order ON investor_fx_requests(created_at,id);
CREATE INDEX investor_fx_capture_retention ON investor_fx_captures(retain_until,id);
CREATE INDEX investor_fx_capture_payload_refs ON investor_fx_captures(workspace_id,raw_sha256,id);
CREATE INDEX investor_fx_publication_head ON investor_fx_publications(authority_id,status,sequence DESC);
CREATE TRIGGER investor_fx_authority_insert BEFORE INSERT ON investor_fx_authorities BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_fx_authorities WHERE id=NEW.id OR (workspace_id=NEW.workspace_id AND content_hash=NEW.content_hash))
    OR NOT EXISTS(SELECT 1 FROM investor_workspaces w JOIN audit_events a ON a.id=NEW.audit_id WHERE w.id=NEW.workspace_id AND w.owner_id=NEW.actor_id
      AND a.actor_id=NEW.actor_id AND a.action='investor_register_fx_authority' AND a.object_type='investor_fx_authority' AND a.object_id=NEW.id
      AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'fx authority audit differs') END;
END;
CREATE TRIGGER investor_fx_control_insert BEFORE INSERT ON investor_fx_controls BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_fx_controls WHERE id=NEW.id OR (authority_id=NEW.authority_id AND version=NEW.version))
    OR NEW.version IS NOT COALESCE((SELECT max(version)+1 FROM investor_fx_controls WHERE authority_id=NEW.authority_id),1)
    OR NOT EXISTS(SELECT 1 FROM investor_fx_authorities s JOIN investor_workspaces w ON w.id=s.workspace_id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE s.id=NEW.authority_id AND s.workspace_id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND s.actor_id=NEW.actor_id AND s.created_at<=NEW.created_at
      AND json_extract(NEW.document_json,'$.authority_hash') IS s.content_hash AND a.actor_id=NEW.actor_id AND a.action='investor_control_fx_authority'
      AND a.object_type='investor_fx_control' AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'fx control audit differs') END;
END;
CREATE TRIGGER investor_fx_request_insert BEFORE INSERT ON investor_fx_requests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_fx_requests WHERE id=NEW.id OR (workspace_id=NEW.workspace_id AND feed_day=NEW.feed_day))
    OR NOT EXISTS(SELECT 1 FROM investor_fx_authorities s JOIN investor_fx_controls c ON c.authority_id=s.id AND c.workspace_id=s.workspace_id
      JOIN investor_workspaces w ON w.id=s.workspace_id JOIN audit_events a ON a.id=NEW.audit_id WHERE s.id=NEW.authority_id AND s.workspace_id=NEW.workspace_id
      AND w.owner_id=NEW.actor_id AND s.actor_id=NEW.actor_id AND s.created_at<=NEW.created_at AND c.id=NEW.control_id AND c.enabled=1
      AND c.version=(SELECT max(version) FROM investor_fx_controls WHERE authority_id=s.id) AND c.created_at<=NEW.created_at
      AND json_extract(NEW.document_json,'$.authority_hash') IS s.content_hash AND json_extract(NEW.document_json,'$.control_hash') IS c.content_hash
      AND a.actor_id=NEW.actor_id AND a.action='investor_schedule_fx_capture' AND a.object_type='investor_fx_request' AND a.object_id=NEW.id
      AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'fx request audit differs') END;
END;
CREATE TRIGGER investor_fx_capture_insert BEFORE INSERT ON investor_fx_captures BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_fx_captures WHERE id=NEW.id OR request_id=NEW.request_id OR job_id=NEW.job_id)
    OR NOT EXISTS(SELECT 1 FROM investor_fx_requests r JOIN investor_workspaces w ON w.id=r.workspace_id JOIN audit_events a ON a.id=NEW.audit_id
      JOIN job_runs j ON j.id=NEW.job_id WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id AND w.owner_id=NEW.actor_id
      AND r.actor_id=NEW.actor_id AND r.created_at<=NEW.created_at AND json_extract(NEW.document_json,'$.request_hash') IS r.content_hash
      AND j.job_type='investor_current_fx' AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash AND j.max_attempts=1 AND j.status='running'
      AND json_extract(NEW.document_json,'$.fencing_token') IS j.fencing_token AND j.lease_until>NEW.created_at
      AND a.actor_id=NEW.actor_id AND a.action='investor_finish_fx_capture' AND a.object_type='investor_fx_capture' AND a.object_id=NEW.id
      AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'fx capture audit differs') END;
END;
CREATE TRIGGER investor_fx_payload_insert BEFORE INSERT ON investor_fx_payloads BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_fx_payloads WHERE workspace_id=NEW.workspace_id AND raw_sha256=NEW.raw_sha256)
    OR NOT EXISTS(SELECT 1 FROM investor_fx_captures c WHERE c.workspace_id=NEW.workspace_id AND c.raw_sha256=NEW.raw_sha256
      AND c.raw_bytes=NEW.raw_bytes AND c.created_at=NEW.created_at AND c.status='captured' AND NOT EXISTS(SELECT 1 FROM investor_fx_purges p WHERE p.capture_id=c.id))
    THEN RAISE(ABORT,'fx payload requires capture') END;
END;
CREATE TRIGGER investor_fx_payload_delete BEFORE DELETE ON investor_fx_payloads BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_fx_captures c WHERE c.workspace_id=OLD.workspace_id AND c.raw_sha256=OLD.raw_sha256
      AND NOT EXISTS(SELECT 1 FROM investor_fx_purges p WHERE p.capture_id=c.id)) THEN RAISE(ABORT,'fx payload still referenced') END;
END;
CREATE TRIGGER investor_fx_purge_insert BEFORE INSERT ON investor_fx_purges BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_fx_purges WHERE capture_id=NEW.capture_id)
    OR NOT EXISTS(SELECT 1 FROM investor_fx_captures c JOIN investor_workspaces w ON w.id=c.workspace_id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE c.id=NEW.capture_id AND c.workspace_id=NEW.workspace_id AND c.status='captured' AND c.created_at<=NEW.created_at
      AND w.owner_id=NEW.actor_id AND c.actor_id=NEW.actor_id AND a.actor_id=NEW.actor_id AND a.action='investor_purge_fx_capture'
      AND a.object_type='investor_fx_capture' AND a.object_id=c.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.reason') IS NEW.reason)
    THEN RAISE(ABORT,'fx purge audit differs') END;
END;
CREATE TRIGGER investor_fx_publication_insert BEFORE INSERT ON investor_fx_publications BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_fx_publications WHERE id=NEW.id OR capture_id=NEW.capture_id OR (authority_id=NEW.authority_id AND sequence=NEW.sequence))
    OR NEW.sequence IS NOT COALESCE((SELECT max(sequence)+1 FROM investor_fx_publications WHERE authority_id=NEW.authority_id),1)
    OR NEW.previous_id IS NOT (SELECT id FROM investor_fx_publications WHERE authority_id=NEW.authority_id AND status='published' ORDER BY sequence DESC LIMIT 1)
    OR json_extract(NEW.document_json,'$.previous_hash') IS NOT (SELECT content_hash FROM investor_fx_publications WHERE id=NEW.previous_id)
    OR (NEW.status='published' AND EXISTS(SELECT 1 FROM investor_fx_publications WHERE authority_id=NEW.authority_id AND status='blocked'))
    OR NOT EXISTS(SELECT 1 FROM investor_fx_captures c JOIN investor_fx_requests r ON r.id=c.request_id AND r.workspace_id=c.workspace_id
      JOIN investor_fx_authorities s ON s.id=r.authority_id AND s.workspace_id=r.workspace_id JOIN investor_fx_controls control ON control.id=r.control_id
      JOIN investor_workspaces w ON w.id=s.workspace_id JOIN audit_events a ON a.id=NEW.audit_id WHERE c.id=NEW.capture_id AND c.workspace_id=NEW.workspace_id
      AND s.id=NEW.authority_id AND c.status='captured' AND c.created_at<=NEW.created_at AND c.not_before<=NEW.created_at AND c.retain_until>NEW.created_at
      AND control.enabled=1 AND control.version=(SELECT max(version) FROM investor_fx_controls WHERE authority_id=s.id)
      AND json_extract(NEW.document_json,'$.capture_hash') IS c.content_hash AND json_extract(NEW.document_json,'$.authority_hash') IS s.content_hash
      AND json_extract(NEW.document_json,'$.control_id') IS control.id AND json_extract(NEW.document_json,'$.control_hash') IS control.content_hash
      AND NOT EXISTS(SELECT 1 FROM investor_fx_purges p WHERE p.capture_id=c.id) AND w.owner_id=NEW.actor_id AND c.actor_id=NEW.actor_id
      AND a.actor_id=NEW.actor_id AND a.action='investor_publish_fx_source' AND a.object_type='investor_fx_publication' AND a.object_id=NEW.id
      AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'fx publication binding differs') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.document_json,'$.refs') ref WHERE NOT EXISTS(
    SELECT 1 FROM investor_data_reviews d JOIN investor_data_sources s ON s.id=d.source_id AND s.workspace_id=d.workspace_id
      WHERE d.id=json_extract(ref.value,'$.review_id') AND d.workspace_id=NEW.workspace_id AND s.kind='fx' AND d.decision='approved'
      AND d.created_at=NEW.created_at AND s.created_at=NEW.created_at AND json_extract(d.document_json,'$.facts.currency') IS ref.key
      AND json_extract(d.document_json,'$.facts.monitor_series.authority_id') IS NEW.authority_id
      AND json_extract(ref.value,'$.review_hash') IS d.content_hash AND json_extract(ref.value,'$.source_hash') IS s.content_hash
      AND json_extract(ref.value,'$.source_id') IS s.id)) THEN RAISE(ABORT,'fx publication review differs') END;
END;
CREATE TRIGGER investor_fx_authority_update BEFORE UPDATE ON investor_fx_authorities BEGIN SELECT RAISE(ABORT,'fx authority immutable'); END;
CREATE TRIGGER investor_fx_authority_delete BEFORE DELETE ON investor_fx_authorities BEGIN SELECT RAISE(ABORT,'fx authority immutable'); END;
CREATE TRIGGER investor_fx_control_update BEFORE UPDATE ON investor_fx_controls BEGIN SELECT RAISE(ABORT,'fx control immutable'); END;
CREATE TRIGGER investor_fx_control_delete BEFORE DELETE ON investor_fx_controls BEGIN SELECT RAISE(ABORT,'fx control immutable'); END;
CREATE TRIGGER investor_fx_request_update BEFORE UPDATE ON investor_fx_requests BEGIN SELECT RAISE(ABORT,'fx request immutable'); END;
CREATE TRIGGER investor_fx_request_delete BEFORE DELETE ON investor_fx_requests BEGIN SELECT RAISE(ABORT,'fx request immutable'); END;
CREATE TRIGGER investor_fx_capture_update BEFORE UPDATE ON investor_fx_captures BEGIN SELECT RAISE(ABORT,'fx capture immutable'); END;
CREATE TRIGGER investor_fx_capture_delete BEFORE DELETE ON investor_fx_captures BEGIN SELECT RAISE(ABORT,'fx capture immutable'); END;
CREATE TRIGGER investor_fx_payload_update BEFORE UPDATE ON investor_fx_payloads BEGIN SELECT RAISE(ABORT,'fx payload immutable'); END;
CREATE TRIGGER investor_fx_purge_update BEFORE UPDATE ON investor_fx_purges BEGIN SELECT RAISE(ABORT,'fx purge immutable'); END;
CREATE TRIGGER investor_fx_purge_delete BEFORE DELETE ON investor_fx_purges BEGIN SELECT RAISE(ABORT,'fx purge immutable'); END;
CREATE TRIGGER investor_fx_publication_update BEFORE UPDATE ON investor_fx_publications BEGIN SELECT RAISE(ABORT,'fx publication immutable'); END;
CREATE TRIGGER investor_fx_publication_delete BEFORE DELETE ON investor_fx_publications BEGIN SELECT RAISE(ABORT,'fx publication immutable'); END;
