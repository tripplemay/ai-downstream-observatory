CREATE TABLE investor_monitor_evidence_inputs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  source_qualification TEXT NOT NULL CHECK(source_qualification='owner_reviewed_reconstructed'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=1048576),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  valid_until TEXT NOT NULL CHECK(valid_until>created_at),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(model_id,workspace_id) REFERENCES investor_models(id,workspace_id),
  UNIQUE(id,workspace_id,model_id), UNIQUE(model_id,content_hash),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-monitor-data-input-v1'),
  CHECK(json_extract(document_json,'$.workspace_id') IS workspace_id),
  CHECK(json_extract(document_json,'$.model_id') IS model_id),
  CHECK(json_extract(document_json,'$.source_qualification') IS source_qualification),
  CHECK(json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_extract(document_json,'$.valid_until') IS valid_until),
  CHECK(json_extract(document_json,'$.live_advice_eligible') IS 0),
  CHECK(json_type(document_json,'$.segments') IS 'array' AND json_array_length(document_json,'$.segments') BETWEEN 1 AND 3),
  CHECK(json_type(document_json,'$.quotes') IS NULL AND json_type(document_json,'$.fx') IS NULL)
);
CREATE INDEX investor_monitor_evidence_latest ON investor_monitor_evidence_inputs(model_id,created_at DESC);
CREATE TRIGGER investor_monitor_evidence_insert BEFORE INSERT ON investor_monitor_evidence_inputs BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_monitor_evidence_inputs WHERE id=NEW.id OR (model_id=NEW.model_id AND content_hash=NEW.content_hash) OR audit_id=NEW.audit_id)
    OR NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR json_extract(NEW.document_json,'$.target_definition_hash') IS NOT
       (SELECT json_extract(document_json,'$.target_definition_hash') FROM investor_models WHERE id=NEW.model_id AND workspace_id=NEW.workspace_id)
    OR NOT EXISTS(SELECT 1 FROM investor_models m JOIN investor_reference_evidence e ON e.plan_id=m.plan_id AND e.workspace_id=m.workspace_id
       WHERE m.id=NEW.model_id AND m.workspace_id=NEW.workspace_id AND json_extract(m.document_json,'$.data_mode')='reconstructed')
    OR NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.id=NEW.audit_id AND a.actor_id=NEW.actor_id
       AND a.action='investor_admit_monitor_source' AND a.object_type='investor_monitor_evidence_input' AND a.object_id=NEW.id
       AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'monitor evidence binding differs') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.document_json,'$.segments')
    WHERE json_extract(value,'$.snapshot.mode') IS NOT 'reconstructed'
      OR json_extract(value,'$.snapshot.workspace_id') IS NOT NEW.workspace_id
      OR json_extract(value,'$.snapshot.created_at') IS NOT NEW.created_at)
    THEN RAISE(ABORT,'monitor evidence segment differs') END;
END;
CREATE TRIGGER investor_monitor_evidence_no_update BEFORE UPDATE ON investor_monitor_evidence_inputs BEGIN SELECT RAISE(ABORT,'monitor evidence is immutable'); END;
CREATE TRIGGER investor_monitor_evidence_no_delete BEFORE DELETE ON investor_monitor_evidence_inputs BEGIN SELECT RAISE(ABORT,'monitor evidence is immutable'); END;
