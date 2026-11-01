CREATE TABLE investor_action_authorities (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id), listing_id TEXT NOT NULL,
  base_review_id TEXT NOT NULL, listing_review_id TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(base_review_id,workspace_id) REFERENCES investor_data_reviews(id,workspace_id),
  FOREIGN KEY(listing_review_id,workspace_id) REFERENCES investor_data_reviews(id,workspace_id),
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,content_hash),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-action-maintenance-policy-v1'),
  CHECK(json_extract(document_json,'$.listing_id') IS listing_id AND json_extract(document_json,'$.base_review_id') IS base_review_id
    AND json_extract(document_json,'$.listing_review_id') IS listing_review_id),
  CHECK(json_extract(document_json,'$.coverage_basis') IS 'selected_two_source_reports_not_objective_absence'
    AND json_type(document_json,'$.standing_rule_authorized') IS 'true'
    AND json_type(document_json,'$.registered_nominal_differences_accepted') IS 'true'
    AND json_extract(document_json,'$.additional_source_requests') IS 0
    AND json_type(document_json,'$.tax_changes_permitted') IS 'false'
    AND json_type(document_json,'$.trading_permission') IS 'false')
);
CREATE TABLE investor_action_controls (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, authority_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 1000), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=4096),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(authority_id,workspace_id) REFERENCES investor_action_authorities(id,workspace_id),
  UNIQUE(authority_id,version), UNIQUE(id,workspace_id,authority_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-action-maintenance-control-v1'),
  CHECK(json_extract(document_json,'$.authority_id') IS authority_id AND json_extract(document_json,'$.version') IS version
    AND json_extract(document_json,'$.enabled') IS enabled AND json_type(document_json,'$.enabled') IN ('true','false')
    AND json_extract(document_json,'$.created_at') IS created_at)
);
CREATE TABLE investor_action_requests (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, authority_id TEXT NOT NULL, control_id TEXT NOT NULL, source_day TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=8192),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>created_at), audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(control_id,workspace_id,authority_id) REFERENCES investor_action_controls(id,workspace_id,authority_id),
  UNIQUE(authority_id,source_day), UNIQUE(id,workspace_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-action-maintenance-request-v1'),
  CHECK(json_extract(document_json,'$.workspace_id') IS workspace_id AND json_extract(document_json,'$.authority_id') IS authority_id
    AND json_extract(document_json,'$.control_id') IS control_id AND json_extract(document_json,'$.source_day') IS source_day
    AND json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until)
);
CREATE TABLE investor_action_publications (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, authority_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 10000), previous_id TEXT, source_day TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('published','blocked','unchanged','superseded')),
  source_id TEXT, review_hash TEXT, coverage_end TEXT, valid_until TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=32768),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(authority_id,workspace_id) REFERENCES investor_action_authorities(id,workspace_id),
  FOREIGN KEY(request_id,workspace_id) REFERENCES investor_action_requests(id,workspace_id),
  FOREIGN KEY(previous_id,workspace_id) REFERENCES investor_action_publications(id,workspace_id),
  FOREIGN KEY(source_id,workspace_id) REFERENCES investor_data_sources(id,workspace_id),
  UNIQUE(authority_id,sequence), UNIQUE(authority_id,source_day), UNIQUE(id,workspace_id), UNIQUE(source_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-action-maintenance-publication-v1'),
  CHECK(json_extract(document_json,'$.publication_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id
    AND json_extract(document_json,'$.authority_id') IS authority_id AND json_extract(document_json,'$.request_id') IS request_id
    AND json_extract(document_json,'$.sequence') IS sequence AND json_extract(document_json,'$.previous_id') IS previous_id
    AND json_extract(document_json,'$.source_day') IS source_day AND json_extract(document_json,'$.status') IS status
    AND json_extract(document_json,'$.source_id') IS source_id AND json_extract(document_json,'$.review_hash') IS review_hash
    AND json_extract(document_json,'$.coverage_end') IS coverage_end AND json_extract(document_json,'$.valid_until') IS valid_until
    AND json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_type(document_json,'$.human_review_performed') IS 'false'
    AND json_type(document_json,'$.trading_permission') IS 'false' AND json_extract(document_json,'$.additional_source_requests') IS 0),
  CHECK((status='published' AND typeof(source_id)='text' AND typeof(review_hash)='text' AND length(review_hash)=64
    AND review_hash NOT GLOB '*[^a-f0-9]*' AND typeof(coverage_end)='text' AND valid_until>created_at)
    OR (status!='published' AND source_id IS NULL AND review_hash IS NULL AND coverage_end IS NULL))
);
CREATE INDEX investor_action_request_pending ON investor_action_requests(created_at,id);
CREATE INDEX investor_action_publication_current ON investor_action_publications(workspace_id,authority_id,status,sequence);
CREATE TRIGGER investor_action_authority_insert BEFORE INSERT ON investor_action_authorities BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_action_authorities WHERE id=NEW.id OR (workspace_id=NEW.workspace_id AND content_hash=NEW.content_hash))
    OR NOT EXISTS(SELECT 1 FROM investor_workspaces w JOIN investor_data_reviews b ON b.workspace_id=w.id
      JOIN investor_data_reviews l ON l.workspace_id=w.id JOIN investor_data_sources bs ON bs.id=b.source_id
      JOIN investor_data_sources ls ON ls.id=l.source_id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE w.id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND b.id=NEW.base_review_id AND l.id=NEW.listing_review_id
      AND bs.kind='actions' AND ls.kind='listing' AND b.decision='approved' AND l.decision='approved'
      AND json_extract(NEW.document_json,'$.base_review_hash') IS b.content_hash
      AND json_extract(NEW.document_json,'$.listing_review_hash') IS l.content_hash
      AND json_extract(b.document_json,'$.facts.listing_id') IS NEW.listing_id
      AND json_extract(l.document_json,'$.facts.listing_id') IS NEW.listing_id
      AND b.created_at<=NEW.created_at AND l.created_at<=NEW.created_at
      AND a.actor_id=NEW.actor_id AND a.action='investor_register_action_maintenance' AND a.object_type='investor_action_authority'
      AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'action maintenance authority audit differs') END;
END;
CREATE TRIGGER investor_action_control_insert BEFORE INSERT ON investor_action_controls BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_action_controls WHERE id=NEW.id)
    OR NEW.version IS NOT COALESCE((SELECT max(version)+1 FROM investor_action_controls WHERE authority_id=NEW.authority_id),1)
    OR (NEW.version=1 AND NEW.enabled!=0)
    OR NEW.created_at<COALESCE((SELECT max(created_at) FROM investor_action_controls WHERE authority_id=NEW.authority_id),NEW.created_at)
    OR (NEW.enabled=1 AND EXISTS(SELECT 1 FROM investor_action_authorities p JOIN investor_action_authorities other
      ON other.workspace_id=p.workspace_id AND other.listing_id=p.listing_id AND other.id!=p.id
      JOIN investor_action_controls c ON c.authority_id=other.id
      WHERE p.id=NEW.authority_id AND c.enabled=1 AND c.version=(SELECT max(version) FROM investor_action_controls WHERE authority_id=other.id)
      AND json_extract(other.document_json,'$.valid_from')<=NEW.created_at AND json_extract(other.document_json,'$.valid_until')>NEW.created_at))
    OR NOT EXISTS(SELECT 1 FROM investor_action_authorities p JOIN audit_events a ON a.id=NEW.audit_id
      WHERE p.id=NEW.authority_id AND p.workspace_id=NEW.workspace_id AND p.actor_id=NEW.actor_id
      AND p.created_at<=NEW.created_at AND json_extract(NEW.document_json,'$.authority_hash') IS p.content_hash
      AND a.actor_id=NEW.actor_id AND a.action='investor_control_action_maintenance' AND a.object_type='investor_action_control'
      AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'action maintenance control audit differs') END;
END;
CREATE TRIGGER investor_action_request_insert BEFORE INSERT ON investor_action_requests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_action_requests WHERE id=NEW.id OR (authority_id=NEW.authority_id AND source_day=NEW.source_day))
    OR NOT EXISTS(SELECT 1 FROM investor_action_authorities p JOIN investor_action_controls c ON c.authority_id=p.id
      JOIN audit_events a ON a.id=NEW.audit_id WHERE p.id=NEW.authority_id AND p.workspace_id=NEW.workspace_id
      AND p.actor_id=NEW.actor_id AND c.id=NEW.control_id AND c.workspace_id=NEW.workspace_id AND c.enabled=1
      AND c.version=(SELECT max(version) FROM investor_action_controls WHERE authority_id=p.id)
      AND p.created_at<=NEW.created_at AND c.created_at<=NEW.created_at
      AND json_extract(NEW.document_json,'$.authority_hash') IS p.content_hash AND json_extract(NEW.document_json,'$.control_hash') IS c.content_hash
      AND a.actor_id=NEW.actor_id AND a.action='investor_request_action_maintenance' AND a.object_type='investor_action_request'
      AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'action maintenance request audit differs') END;
END;
CREATE TRIGGER investor_action_publication_insert BEFORE INSERT ON investor_action_publications BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_action_publications WHERE id=NEW.id OR request_id=NEW.request_id OR source_id=NEW.source_id
      OR (authority_id=NEW.authority_id AND source_day=NEW.source_day))
    OR NEW.sequence IS NOT COALESCE((SELECT max(sequence)+1 FROM investor_action_publications WHERE authority_id=NEW.authority_id),1)
    OR NEW.previous_id IS NOT (SELECT id FROM investor_action_publications WHERE authority_id=NEW.authority_id ORDER BY sequence DESC LIMIT 1)
    OR json_extract(NEW.document_json,'$.previous_hash') IS NOT
      (SELECT content_hash FROM investor_action_publications WHERE id=NEW.previous_id AND workspace_id=NEW.workspace_id)
    OR NEW.source_day<=COALESCE((SELECT source_day FROM investor_action_publications WHERE id=NEW.previous_id),'0000-00-00')
    OR NOT EXISTS(SELECT 1 FROM investor_action_requests r JOIN audit_events a ON a.id=NEW.audit_id
      WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id AND r.authority_id=NEW.authority_id
      AND r.actor_id=NEW.actor_id AND r.source_day=NEW.source_day AND r.created_at<=NEW.created_at
      AND json_extract(NEW.document_json,'$.request_hash') IS r.content_hash
      AND a.actor_id=NEW.actor_id AND a.action='investor_publish_action_maintenance' AND a.object_type='investor_action_publication'
      AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    OR (NEW.status='published' AND (EXISTS(SELECT 1 FROM investor_action_publications WHERE authority_id=NEW.authority_id AND status='blocked')
      OR EXISTS(SELECT 1 FROM investor_data_reviews WHERE source_id=NEW.source_id)
      OR NOT EXISTS(SELECT 1 FROM investor_action_requests r JOIN investor_action_controls c ON c.id=r.control_id
        JOIN investor_action_authorities p ON p.id=r.authority_id WHERE r.id=NEW.request_id AND c.enabled=1
        AND c.version=(SELECT max(version) FROM investor_action_controls WHERE authority_id=p.id)
        AND r.valid_until>NEW.created_at AND json_extract(p.document_json,'$.valid_from')<=NEW.created_at
        AND json_extract(p.document_json,'$.valid_until')>NEW.created_at
        AND json_extract(NEW.document_json,'$.authority_hash') IS p.content_hash
        AND json_extract(NEW.document_json,'$.control_id') IS c.id AND json_extract(NEW.document_json,'$.control_hash') IS c.content_hash
        AND NEW.coverage_end>COALESCE((SELECT coverage_end FROM investor_action_publications
          WHERE authority_id=p.id AND status='published' ORDER BY sequence DESC LIMIT 1),
          (SELECT json_extract(document_json,'$.facts.range_end') FROM investor_data_reviews WHERE id=p.base_review_id)))
      OR NOT EXISTS(SELECT 1 FROM investor_data_sources s WHERE s.id=NEW.source_id AND s.workspace_id=NEW.workspace_id
        AND s.actor_id=NEW.actor_id AND s.kind='actions' AND s.created_at=NEW.created_at)))
    THEN RAISE(ABORT,'action maintenance publication audit differs') END;
END;
CREATE TRIGGER investor_action_derived_source_manual_review BEFORE INSERT ON investor_data_reviews
WHEN EXISTS(SELECT 1 FROM investor_action_publications WHERE source_id=NEW.source_id)
BEGIN SELECT RAISE(ABORT,'managed action source requires its standing authority controls'); END;
CREATE TRIGGER investor_action_authority_update BEFORE UPDATE ON investor_action_authorities BEGIN SELECT RAISE(ABORT,'action authority immutable'); END;
CREATE TRIGGER investor_action_authority_delete BEFORE DELETE ON investor_action_authorities BEGIN SELECT RAISE(ABORT,'action authority immutable'); END;
CREATE TRIGGER investor_action_control_update BEFORE UPDATE ON investor_action_controls BEGIN SELECT RAISE(ABORT,'action control immutable'); END;
CREATE TRIGGER investor_action_control_delete BEFORE DELETE ON investor_action_controls BEGIN SELECT RAISE(ABORT,'action control immutable'); END;
CREATE TRIGGER investor_action_request_update BEFORE UPDATE ON investor_action_requests BEGIN SELECT RAISE(ABORT,'action request immutable'); END;
CREATE TRIGGER investor_action_request_delete BEFORE DELETE ON investor_action_requests BEGIN SELECT RAISE(ABORT,'action request immutable'); END;
CREATE TRIGGER investor_action_publication_update BEFORE UPDATE ON investor_action_publications BEGIN SELECT RAISE(ABORT,'action publication immutable'); END;
CREATE TRIGGER investor_action_publication_delete BEFORE DELETE ON investor_action_publications BEGIN SELECT RAISE(ABORT,'action publication immutable'); END;
CREATE VIEW investor_review_headers AS
  SELECT r.id,r.workspace_id,r.source_id,r.version,r.decision,r.document_json,r.content_hash,r.actor_id,r.created_at,r.valid_until,r.audit_id,
    'manual_or_legacy_rule' review_origin,json_extract(r.document_json,'$.facts.listing_id') listing_id
  FROM investor_data_reviews r
  UNION ALL
  SELECT p.id,p.workspace_id,p.source_id,1,'approved',NULL,p.review_hash,p.actor_id,p.created_at,p.valid_until,p.audit_id,
    'owner_standing_no_new_actions_rule',a.listing_id
  FROM investor_action_publications p JOIN investor_action_authorities a ON a.id=p.authority_id AND a.workspace_id=p.workspace_id
  WHERE p.status='published';
CREATE VIEW investor_action_unavailable_headers AS
  WITH dependencies AS (
    SELECT p.id,p.workspace_id,j.key source_kind,json_extract(j.value,'$.capture_id') capture_id
      FROM investor_action_publications p JOIN investor_action_authorities a ON a.id=p.authority_id
      JOIN json_each(a.document_json,'$.anchor_captures') j WHERE p.status='published'
    UNION ALL
    SELECT p.id,p.workspace_id,j.key,json_extract(j.value,'$.capture_id')
      FROM investor_action_publications p JOIN json_each(p.document_json,'$.capture_refs') j WHERE p.status='published'
  ), unavailable_dependencies AS (
    SELECT d.id,d.workspace_id FROM dependencies d
      JOIN investor_issuer_captures c ON c.id=d.capture_id AND c.workspace_id=d.workspace_id
      JOIN investor_issuer_requests r ON r.id=c.request_id AND r.workspace_id=c.workspace_id
      WHERE d.source_kind='issuer' AND (EXISTS(SELECT 1 FROM investor_issuer_purges x WHERE x.capture_id=c.id)
        OR NOT EXISTS(SELECT 1 FROM investor_issuer_controls x WHERE x.id=r.control_id AND x.enabled=1
          AND x.version=(SELECT max(version) FROM investor_issuer_controls WHERE authority_id=r.authority_id)))
    UNION ALL
    SELECT d.id,d.workspace_id FROM dependencies d
      JOIN investor_eodhd_captures c ON c.id=d.capture_id AND c.workspace_id=d.workspace_id
      JOIN investor_eodhd_requests r ON r.id=c.request_id AND r.workspace_id=c.workspace_id
      WHERE d.source_kind IN ('dividends','splits') AND (EXISTS(SELECT 1 FROM investor_eodhd_purges x WHERE x.capture_id=c.id)
        OR NOT EXISTS(SELECT 1 FROM investor_eodhd_controls x WHERE x.id=r.control_id AND x.enabled=1
          AND x.version=(SELECT max(version) FROM investor_eodhd_controls WHERE authority_id=r.authority_id)))
  )
  SELECT p.id,p.workspace_id FROM investor_action_publications p JOIN investor_action_authorities a ON a.id=p.authority_id
    JOIN investor_data_reviews b ON b.id=a.base_review_id JOIN investor_data_reviews l ON l.id=a.listing_review_id
    WHERE p.status='published' AND (
      EXISTS(SELECT 1 FROM investor_action_publications x WHERE x.authority_id=p.authority_id AND x.status='blocked')
      OR NOT EXISTS(SELECT 1 FROM investor_action_controls x WHERE x.id=json_extract(p.document_json,'$.control_id') AND x.enabled=1
        AND x.version=(SELECT max(version) FROM investor_action_controls WHERE authority_id=p.authority_id))
      OR EXISTS(SELECT 1 FROM investor_data_reviews x WHERE (x.source_id=b.source_id AND x.version>b.version)
        OR (x.source_id=l.source_id AND x.version>l.version))
      OR EXISTS(SELECT 1 FROM unavailable_dependencies d WHERE d.id=p.id AND d.workspace_id=p.workspace_id));
