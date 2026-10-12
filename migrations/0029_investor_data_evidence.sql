CREATE TABLE investor_data_sources (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id),
  kind TEXT NOT NULL CHECK(kind IN ('rights','listing','calendar','actions','fx')),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=131072),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,kind,content_hash)
);
CREATE TABLE investor_data_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected','withdrawn')),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=8388608),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  valid_until TEXT NOT NULL CHECK(valid_until>created_at),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(source_id,workspace_id) REFERENCES investor_data_sources(id,workspace_id),
  UNIQUE(id,workspace_id), UNIQUE(source_id,version),
  CHECK(json_extract(document_json,'$.source_id') IS source_id),
  CHECK(json_extract(document_json,'$.decision') IS decision),
  CHECK(json_extract(document_json,'$.version') IS version),
  CHECK(json_extract(document_json,'$.valid_until') IS valid_until),
  CHECK(json_extract(document_json,'$.review_basis') IS 'owner_reviewed_not_provider_certified')
);
CREATE INDEX investor_data_review_latest ON investor_data_reviews(source_id,version DESC);
CREATE TABLE investor_price_captures (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id),
  rights_review_id TEXT NOT NULL,
  listing_review_id TEXT NOT NULL,
  calendar_review_id TEXT NOT NULL,
  qualification TEXT NOT NULL CHECK(qualification IN ('isolated_official_sdk','injected_test_client')),
  projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256)=64 AND projection_sha256 NOT GLOB '*[^a-f0-9]*'),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json)='object' AND length(CAST(receipt_json AS BLOB))<=32768),
  receipt_hash TEXT NOT NULL CHECK(length(receipt_hash)=64 AND receipt_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  retain_until TEXT NOT NULL CHECK(retain_until>created_at),
  FOREIGN KEY(rights_review_id,workspace_id) REFERENCES investor_data_reviews(id,workspace_id),
  FOREIGN KEY(listing_review_id,workspace_id) REFERENCES investor_data_reviews(id,workspace_id),
  FOREIGN KEY(calendar_review_id,workspace_id) REFERENCES investor_data_reviews(id,workspace_id),
  UNIQUE(id,workspace_id),
  CHECK(json_extract(receipt_json,'$.capture_id') IS id),
  CHECK(json_extract(receipt_json,'$.projection_sha256') IS projection_sha256),
  CHECK(json_extract(receipt_json,'$.qualification') IS qualification),
  CHECK(json_extract(receipt_json,'$.created_at') IS created_at),
  CHECK(json_extract(receipt_json,'$.workspace_id') IS workspace_id),
  CHECK(json_extract(receipt_json,'$.rights_review_id') IS rights_review_id),
  CHECK(json_extract(receipt_json,'$.listing_review_id') IS listing_review_id),
  CHECK(json_extract(receipt_json,'$.calendar_review_id') IS calendar_review_id),
  CHECK(json_extract(receipt_json,'$.retain_until') IS retain_until)
);
CREATE TABLE investor_price_payloads (
  capture_id TEXT PRIMARY KEY NOT NULL REFERENCES investor_price_captures(id),
  projection BLOB NOT NULL CHECK(typeof(projection)='blob' AND length(projection)>0 AND length(projection)<=2097152)
);
CREATE TABLE investor_price_purges (
  capture_id TEXT PRIMARY KEY NOT NULL REFERENCES investor_price_captures(id),
  reason TEXT NOT NULL CHECK(reason IN ('retention_expired','rights_no_longer_active')),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id)
);
CREATE TRIGGER investor_data_source_insert BEFORE INSERT ON investor_data_sources BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_data_sources WHERE id=NEW.id OR (workspace_id=NEW.workspace_id AND kind=NEW.kind AND content_hash=NEW.content_hash))
    OR NOT EXISTS(SELECT 1 FROM investor_workspaces w JOIN audit_events a ON a.id=NEW.audit_id
      WHERE w.id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND a.actor_id=NEW.actor_id
      AND a.object_type='investor_data_source' AND a.object_id=NEW.id AND a.action='investor_store_data_source' AND a.created_at=NEW.created_at
      AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'investor data source binding differs') END;
END;
CREATE TRIGGER investor_data_source_no_update BEFORE UPDATE ON investor_data_sources BEGIN SELECT RAISE(ABORT,'investor data source is immutable'); END;
CREATE TRIGGER investor_data_source_no_delete BEFORE DELETE ON investor_data_sources BEGIN SELECT RAISE(ABORT,'investor data source is immutable'); END;
CREATE TRIGGER investor_data_review_insert BEFORE INSERT ON investor_data_reviews BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_data_reviews WHERE id=NEW.id OR (source_id=NEW.source_id AND version=NEW.version))
    OR NEW.version!=(SELECT coalesce(max(version),0)+1 FROM investor_data_reviews WHERE source_id=NEW.source_id)
    OR EXISTS(SELECT 1 FROM investor_data_reviews WHERE source_id=NEW.source_id AND created_at>NEW.created_at)
    OR NOT EXISTS(SELECT 1 FROM investor_workspaces w JOIN audit_events a ON a.id=NEW.audit_id JOIN investor_data_sources s ON s.id=NEW.source_id
      WHERE w.id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND s.workspace_id=w.id AND s.created_at<=NEW.created_at
      AND a.actor_id=NEW.actor_id AND a.object_type='investor_data_review' AND a.object_id=NEW.id
      AND a.action='investor_review_data_source' AND a.created_at=NEW.created_at
      AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash
      AND json_extract(NEW.document_json,'$.source_hash') IS s.content_hash AND json_extract(NEW.document_json,'$.kind') IS s.kind)
    THEN RAISE(ABORT,'investor data review binding differs') END;
END;
CREATE TRIGGER investor_data_review_no_update BEFORE UPDATE ON investor_data_reviews BEGIN SELECT RAISE(ABORT,'investor data review is immutable'); END;
CREATE TRIGGER investor_data_review_no_delete BEFORE DELETE ON investor_data_reviews BEGIN SELECT RAISE(ABORT,'investor data review is immutable'); END;
CREATE TRIGGER investor_price_capture_insert BEFORE INSERT ON investor_price_captures BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_price_captures WHERE id=NEW.id)
    THEN RAISE(ABORT,'investor price capture cannot be replaced') END;
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM json_each(json_object('rights',NEW.rights_review_id,'listing',NEW.listing_review_id,'calendar',NEW.calendar_review_id)) wanted
    WHERE NOT EXISTS(SELECT 1 FROM investor_data_reviews r JOIN investor_data_sources s ON s.id=r.source_id
      WHERE r.id=wanted.value AND r.workspace_id=NEW.workspace_id AND s.kind=wanted.key AND r.decision='approved'
      AND r.created_at<=NEW.created_at AND NEW.created_at<r.valid_until
      AND r.version=(SELECT max(version) FROM investor_data_reviews WHERE source_id=r.source_id)
      AND json_extract(NEW.receipt_json,'$.review_hashes.'||wanted.key) IS r.content_hash))
    THEN RAISE(ABORT,'investor price capture review binding differs') END;
END;
CREATE TRIGGER investor_price_capture_no_update BEFORE UPDATE ON investor_price_captures BEGIN SELECT RAISE(ABORT,'investor price capture is immutable'); END;
CREATE TRIGGER investor_price_capture_no_delete BEFORE DELETE ON investor_price_captures BEGIN SELECT RAISE(ABORT,'investor price capture is immutable'); END;
CREATE TRIGGER investor_price_payload_insert BEFORE INSERT ON investor_price_payloads BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_price_payloads WHERE capture_id=NEW.capture_id)
    OR EXISTS(SELECT 1 FROM investor_price_purges WHERE capture_id=NEW.capture_id)
    THEN RAISE(ABORT,'investor price payload cannot be replaced') END;
END;
CREATE TRIGGER investor_price_payload_no_update BEFORE UPDATE ON investor_price_payloads BEGIN SELECT RAISE(ABORT,'investor price payload is immutable'); END;
CREATE TRIGGER investor_price_payload_delete BEFORE DELETE ON investor_price_payloads BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM investor_price_purges WHERE capture_id=OLD.capture_id)
    THEN RAISE(ABORT,'investor price payload requires a purge record') END;
END;
CREATE TRIGGER investor_price_purge_insert BEFORE INSERT ON investor_price_purges BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_price_purges WHERE capture_id=NEW.capture_id)
    OR NOT EXISTS(SELECT 1 FROM investor_price_captures c JOIN investor_workspaces w ON w.id=c.workspace_id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE c.id=NEW.capture_id AND w.owner_id=NEW.actor_id AND a.actor_id=NEW.actor_id
      AND a.object_type='investor_price_capture' AND a.object_id=c.id AND a.action='investor_purge_price_payload' AND a.created_at=NEW.created_at)
    THEN RAISE(ABORT,'investor price purge binding differs') END;
END;
CREATE TRIGGER investor_price_purge_no_update BEFORE UPDATE ON investor_price_purges BEGIN SELECT RAISE(ABORT,'investor price purge is immutable'); END;
CREATE TRIGGER investor_price_purge_no_delete BEFORE DELETE ON investor_price_purges BEGIN SELECT RAISE(ABORT,'investor price purge is immutable'); END;
