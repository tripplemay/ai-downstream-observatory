CREATE TABLE investor_confirmed_captures (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id),
  watch_id TEXT NOT NULL CHECK(length(watch_id)=32 AND watch_id NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL,
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  qualification TEXT NOT NULL CHECK(qualification IN ('isolated_official_sdk_callback','injected_test_receiver')),
  status TEXT NOT NULL CHECK(status IN ('complete','partial','no_confirmed_events')),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^a-f0-9]*'),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json)='object' AND length(CAST(receipt_json AS BLOB))<=131072),
  receipt_hash TEXT NOT NULL CHECK(length(receipt_hash)=64 AND receipt_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  retain_until TEXT NOT NULL CHECK(retain_until>created_at),
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,watch_id),
  CHECK(json_extract(receipt_json,'$.schema_version') IS 'investor-confirmed-capture-v1'),
  CHECK(json_extract(receipt_json,'$.capture_id') IS id),
  CHECK(json_extract(receipt_json,'$.workspace_id') IS workspace_id),
  CHECK(json_extract(receipt_json,'$.watch_id') IS watch_id),
  CHECK(json_extract(receipt_json,'$.request.watch_id') IS watch_id),
  CHECK(json_extract(receipt_json,'$.qualification') IS qualification),
  CHECK(json_extract(receipt_json,'$.status') IS status),
  CHECK(json_extract(receipt_json,'$.payload_sha256') IS payload_sha256),
  CHECK(json_extract(receipt_json,'$.created_at') IS created_at),
  CHECK(json_extract(receipt_json,'$.retain_until') IS retain_until),
  CHECK(json_type(receipt_json,'$.bindings') IS 'array' AND json_array_length(receipt_json,'$.bindings') BETWEEN 1 AND 32),
  CHECK(json_type(receipt_json,'$.request.targets') IS 'array' AND json_array_length(receipt_json,'$.request.targets')=json_array_length(receipt_json,'$.bindings'))
);
CREATE TABLE investor_confirmed_targets (
  capture_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  rights_review_id TEXT NOT NULL,
  listing_review_id TEXT NOT NULL,
  calendar_review_id TEXT NOT NULL,
  PRIMARY KEY(capture_id,listing_id),
  FOREIGN KEY(capture_id,workspace_id) REFERENCES investor_confirmed_captures(id,workspace_id),
  FOREIGN KEY(rights_review_id,workspace_id) REFERENCES investor_data_reviews(id,workspace_id),
  FOREIGN KEY(listing_review_id,workspace_id) REFERENCES investor_data_reviews(id,workspace_id),
  FOREIGN KEY(calendar_review_id,workspace_id) REFERENCES investor_data_reviews(id,workspace_id)
);
CREATE INDEX investor_confirmed_targets_rights ON investor_confirmed_targets(rights_review_id,capture_id);
CREATE INDEX investor_confirmed_captures_retention ON investor_confirmed_captures(retain_until,id);
CREATE TABLE investor_confirmed_payloads (
  capture_id TEXT PRIMARY KEY NOT NULL REFERENCES investor_confirmed_captures(id),
  projection BLOB NOT NULL CHECK(typeof(projection)='blob' AND length(projection)>0 AND length(projection)<=3145728)
);
CREATE TABLE investor_confirmed_purges (
  capture_id TEXT PRIMARY KEY NOT NULL REFERENCES investor_confirmed_captures(id),
  reason TEXT NOT NULL CHECK(reason IN ('retention_expired','rights_no_longer_active')),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id)
);
CREATE TRIGGER investor_confirmed_capture_insert BEFORE INSERT ON investor_confirmed_captures BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_confirmed_captures WHERE id=NEW.id OR (workspace_id=NEW.workspace_id AND watch_id=NEW.watch_id))
    OR NOT EXISTS(SELECT 1 FROM investor_workspaces w JOIN audit_events a ON a.id=NEW.audit_id
      WHERE w.id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND a.actor_id=NEW.actor_id
      AND a.action='investor_store_confirmed_capture' AND a.object_type='investor_confirmed_capture' AND a.object_id=NEW.id
      AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.receipt_hash)
    THEN RAISE(ABORT,'investor confirmed capture audit differs') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.receipt_json,'$.bindings') b
    JOIN json_each(b.value,'$.reviews') ref WHERE ref.key NOT IN ('rights','listing','calendar') OR NOT EXISTS(
      SELECT 1 FROM investor_data_reviews r JOIN investor_data_sources s ON s.id=r.source_id
      WHERE r.id=json_extract(ref.value,'$.review_id') AND r.workspace_id=NEW.workspace_id AND s.kind=ref.key
      AND s.content_hash=json_extract(ref.value,'$.source_hash') AND s.id=json_extract(ref.value,'$.source_id')
      AND r.content_hash=json_extract(ref.value,'$.review_hash') AND r.decision='approved' AND r.created_at<=NEW.created_at AND NEW.created_at<r.valid_until
      AND r.version=(SELECT max(version) FROM investor_data_reviews WHERE source_id=r.source_id)))
    OR EXISTS(SELECT 1 FROM json_each(NEW.receipt_json,'$.bindings') b
      WHERE json_type(b.value,'$.reviews') IS NOT 'object' OR (SELECT count(*) FROM json_each(b.value,'$.reviews'))!=3)
    THEN RAISE(ABORT,'investor confirmed capture review differs') END;
END;
CREATE TRIGGER investor_confirmed_capture_no_update BEFORE UPDATE ON investor_confirmed_captures BEGIN SELECT RAISE(ABORT,'investor confirmed capture is immutable'); END;
CREATE TRIGGER investor_confirmed_capture_no_delete BEFORE DELETE ON investor_confirmed_captures BEGIN SELECT RAISE(ABORT,'investor confirmed capture is immutable'); END;
CREATE TRIGGER investor_confirmed_target_insert BEFORE INSERT ON investor_confirmed_targets BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_confirmed_targets WHERE capture_id=NEW.capture_id AND listing_id=NEW.listing_id)
    OR EXISTS(SELECT 1 FROM investor_confirmed_payloads WHERE capture_id=NEW.capture_id)
    OR EXISTS(SELECT 1 FROM investor_confirmed_purges WHERE capture_id=NEW.capture_id)
    OR NOT EXISTS(SELECT 1 FROM investor_confirmed_captures c JOIN json_each(c.receipt_json,'$.bindings') b
      WHERE c.id=NEW.capture_id AND c.workspace_id=NEW.workspace_id AND json_extract(b.value,'$.target.mapping.listing_id') IS NEW.listing_id
      AND json_extract(b.value,'$.reviews.rights.review_id') IS NEW.rights_review_id
      AND json_extract(b.value,'$.reviews.listing.review_id') IS NEW.listing_review_id
      AND json_extract(b.value,'$.reviews.calendar.review_id') IS NEW.calendar_review_id)
    THEN RAISE(ABORT,'investor confirmed target differs') END;
END;
CREATE TRIGGER investor_confirmed_target_no_update BEFORE UPDATE ON investor_confirmed_targets BEGIN SELECT RAISE(ABORT,'investor confirmed target is immutable'); END;
CREATE TRIGGER investor_confirmed_target_no_delete BEFORE DELETE ON investor_confirmed_targets BEGIN SELECT RAISE(ABORT,'investor confirmed target is immutable'); END;
CREATE TRIGGER investor_confirmed_payload_insert BEFORE INSERT ON investor_confirmed_payloads BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_confirmed_payloads WHERE capture_id=NEW.capture_id)
    OR EXISTS(SELECT 1 FROM investor_confirmed_purges WHERE capture_id=NEW.capture_id)
    OR NOT EXISTS(SELECT 1 FROM investor_confirmed_captures c WHERE c.id=NEW.capture_id
      AND json_array_length(c.receipt_json,'$.bindings')=(SELECT count(*) FROM investor_confirmed_targets t WHERE t.capture_id=c.id))
    THEN RAISE(ABORT,'investor confirmed payload cannot be replaced or incomplete') END;
END;
CREATE TRIGGER investor_confirmed_payload_no_update BEFORE UPDATE ON investor_confirmed_payloads BEGIN SELECT RAISE(ABORT,'investor confirmed payload is immutable'); END;
CREATE TRIGGER investor_confirmed_payload_delete BEFORE DELETE ON investor_confirmed_payloads BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM investor_confirmed_purges WHERE capture_id=OLD.capture_id)
    THEN RAISE(ABORT,'investor confirmed payload requires a purge record') END;
END;
CREATE TRIGGER investor_confirmed_purge_insert BEFORE INSERT ON investor_confirmed_purges BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_confirmed_purges WHERE capture_id=NEW.capture_id)
    OR NOT EXISTS(SELECT 1 FROM investor_confirmed_captures c JOIN investor_workspaces w ON w.id=c.workspace_id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE c.id=NEW.capture_id AND c.created_at<=NEW.created_at AND w.owner_id=NEW.actor_id AND a.actor_id=NEW.actor_id
      AND a.action='investor_purge_confirmed_payload' AND a.object_type='investor_confirmed_capture' AND a.object_id=c.id AND a.created_at=NEW.created_at
      AND json_extract(a.payload_json,'$.reason') IS NEW.reason)
    THEN RAISE(ABORT,'investor confirmed purge audit differs') END;
END;
CREATE TRIGGER investor_confirmed_purge_no_update BEFORE UPDATE ON investor_confirmed_purges BEGIN SELECT RAISE(ABORT,'investor confirmed purge is immutable'); END;
CREATE TRIGGER investor_confirmed_purge_no_delete BEFORE DELETE ON investor_confirmed_purges BEGIN SELECT RAISE(ABORT,'investor confirmed purge is immutable'); END;
