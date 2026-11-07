-- Add a distinct receipt-qualified protocol without changing historical rows or hashes.
PRAGMA legacy_alter_table=ON;
CREATE TABLE investor_monitor_evidence_rebuild (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL,
  source_qualification TEXT NOT NULL CHECK(source_qualification='owner_reviewed_reconstructed'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=1048576),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>created_at),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(model_id,workspace_id) REFERENCES investor_models(id,workspace_id),
  UNIQUE(id,workspace_id,model_id), UNIQUE(model_id,content_hash),
  CHECK(json_extract(document_json,'$.schema_version') IN ('investor-monitor-data-input-v1','investor-monitor-data-input-v2','investor-monitor-data-input-v3','investor-monitor-data-input-v4','investor-monitor-data-input-v5')),
  CHECK(json_extract(document_json,'$.workspace_id') IS workspace_id AND json_extract(document_json,'$.model_id') IS model_id),
  CHECK(json_extract(document_json,'$.source_qualification') IS source_qualification AND json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_extract(document_json,'$.valid_until') IS valid_until AND json_extract(document_json,'$.live_advice_eligible') IS 0),
  CHECK(json_type(document_json,'$.segments') IS 'array' AND json_array_length(document_json,'$.segments') BETWEEN 1 AND 3),
  CHECK(json_type(document_json,'$.quotes') IS NULL AND json_type(document_json,'$.fx') IS NULL)
);
INSERT INTO investor_monitor_evidence_rebuild(rowid,id,workspace_id,model_id,source_qualification,document_json,content_hash,actor_id,created_at,valid_until,audit_id)
  SELECT rowid,id,workspace_id,model_id,source_qualification,document_json,content_hash,actor_id,created_at,valid_until,audit_id FROM investor_monitor_evidence_inputs;
DROP TABLE investor_monitor_evidence_inputs;
ALTER TABLE investor_monitor_evidence_rebuild RENAME TO investor_monitor_evidence_inputs;
PRAGMA legacy_alter_table=OFF;

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
  SELECT CASE WHEN json_extract(NEW.document_json,'$.schema_version') IN ('investor-monitor-data-input-v4','investor-monitor-data-input-v5') AND EXISTS(
    SELECT 1 FROM json_each(NEW.document_json,'$.segments')
    WHERE json_extract(value,'$.snapshot.schema_version') IS NOT 'investor-monitor-source-snapshot-v2'
      OR json_extract(value,'$.snapshot.use_scope') IS NOT 'monitor_only'
      OR json_type(value,'$.snapshot.action_availability_refs') IS NOT 'array'
      OR json_extract(value,'$.snapshot.external_ai_authorized') IS NOT 0
      OR json_extract(value,'$.snapshot.live_advice_eligible') IS NOT 0)
    THEN RAISE(ABORT,'monitor evidence action protocol differs') END;
  SELECT CASE WHEN (json_extract(NEW.document_json,'$.schema_version')='investor-monitor-data-input-v3'
      OR (json_extract(NEW.document_json,'$.schema_version') IN ('investor-monitor-data-input-v4','investor-monitor-data-input-v5') AND json_type(NEW.document_json,'$.settings.cost_assumptions')='object')) AND NOT EXISTS(
    SELECT 1 FROM investor_monitor_cost_assumptions a WHERE a.id=json_extract(NEW.document_json,'$.settings.cost_assumptions.id')
      AND a.workspace_id=NEW.workspace_id AND a.model_id=NEW.model_id AND a.content_hash=json_extract(NEW.document_json,'$.settings.cost_assumptions.content_hash')
      AND a.effective_from<=NEW.created_at AND a.version=(SELECT max(version) FROM investor_monitor_cost_assumptions WHERE model_id=NEW.model_id AND effective_from<=NEW.created_at)
      AND json(json_extract(NEW.document_json,'$.settings.policy.costs')) IS CASE WHEN a.valid_until>NEW.created_at THEN json(json_extract(a.document_json,'$.costs')) ELSE NULL END)
    THEN RAISE(ABORT,'monitor evidence cost assumptions differ') END;
  SELECT CASE WHEN json_extract(NEW.document_json,'$.schema_version')!='investor-monitor-data-input-v3'
      AND NOT (json_extract(NEW.document_json,'$.schema_version') IN ('investor-monitor-data-input-v4','investor-monitor-data-input-v5') AND json_type(NEW.document_json,'$.settings.cost_assumptions') IS 'object')
      AND EXISTS(SELECT 1 FROM investor_monitor_cost_assumptions WHERE model_id=NEW.model_id AND effective_from<=NEW.created_at)
    THEN RAISE(ABORT,'monitor evidence cost assumptions differ') END;
  SELECT CASE WHEN json_extract(NEW.document_json,'$.schema_version') IN ('investor-monitor-data-input-v4','investor-monitor-data-input-v5')
      AND json_type(NEW.document_json,'$.settings.cost_assumptions') IS NOT NULL AND json_type(NEW.document_json,'$.settings.cost_assumptions') IS NOT 'object'
    THEN RAISE(ABORT,'monitor evidence cost assumptions differ') END;
END;
CREATE TRIGGER investor_monitor_evidence_no_update BEFORE UPDATE ON investor_monitor_evidence_inputs BEGIN SELECT RAISE(ABORT,'monitor evidence is immutable'); END;
CREATE TRIGGER investor_monitor_evidence_no_delete BEFORE DELETE ON investor_monitor_evidence_inputs BEGIN SELECT RAISE(ABORT,'monitor evidence is immutable'); END;

CREATE TABLE investor_legacy_transition_admissions (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id), model_id TEXT NOT NULL,
  transition_id TEXT NOT NULL UNIQUE, workspace_revision INTEGER NOT NULL CHECK(typeof(workspace_revision)='integer' AND workspace_revision>0),
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  input_id TEXT NOT NULL UNIQUE,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>created_at),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(transition_id,workspace_id,model_id) REFERENCES investor_legacy_transition_confirmations(id,workspace_id,model_id),
  FOREIGN KEY(input_id,workspace_id,model_id) REFERENCES investor_monitor_evidence_inputs(id,workspace_id,model_id),
  UNIQUE(id,workspace_id,model_id), UNIQUE(workspace_id,idempotency_key),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-legacy-transition-source-admission-v1'),
  CHECK(json_extract(document_json,'$.admission_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id
    AND json_extract(document_json,'$.model_id') IS model_id AND json_extract(document_json,'$.transition_id') IS transition_id
    AND json_extract(document_json,'$.input_id') IS input_id AND json_extract(document_json,'$.workspace_revision') IS workspace_revision
    AND json_extract(document_json,'$.request_hash') IS request_hash AND json_extract(document_json,'$.request.idempotency_key') IS idempotency_key
    AND json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until),
  CHECK(json_extract(document_json,'$.monitor_source_registered') IS 1 AND json_extract(document_json,'$.monitoring_activated') IS 0
    AND json_extract(document_json,'$.trading_permission') IS 0 AND json_extract(document_json,'$.raw_ai_sharing') IS 0
    AND json_extract(document_json,'$.provider_calls') IS 0)
);
CREATE TRIGGER investor_transition_input_insert BEFORE INSERT ON investor_monitor_evidence_inputs BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_monitor_evidence_inputs i WHERE i.id=(
      SELECT id FROM investor_monitor_evidence_inputs WHERE model_id=NEW.model_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
      AND json_extract(i.document_json,'$.schema_version')='investor-monitor-data-input-v5'
      AND (json_extract(NEW.document_json,'$.schema_version')!='investor-monitor-data-input-v5'
        OR json(json_extract(i.document_json,'$.transition')) IS NOT json(json_extract(NEW.document_json,'$.transition'))))
    THEN RAISE(ABORT,'legacy transition protocol cannot be discarded') END;
  SELECT CASE WHEN json_extract(NEW.document_json,'$.schema_version')='investor-monitor-data-input-v5' AND NOT EXISTS(
    SELECT 1 FROM investor_legacy_transition_confirmations c WHERE c.id=json_extract(NEW.document_json,'$.transition.id')
      AND c.workspace_id=NEW.workspace_id AND c.model_id=NEW.model_id AND c.content_hash=json_extract(NEW.document_json,'$.transition.content_hash')
      AND c.created_at<=NEW.created_at AND NEW.created_at<c.valid_until AND NEW.valid_until<=c.valid_until
      AND NEW.valid_until<=json_extract(NEW.document_json,'$.audited_valid_until')
      AND (EXISTS(SELECT 1 FROM investor_legacy_transition_admissions a WHERE a.transition_id=c.id AND a.created_at<=NEW.created_at)
        OR (c.legacy_input_id IS (SELECT id FROM investor_monitor_evidence_inputs WHERE model_id=NEW.model_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
          AND c.checkpoint_id IS (SELECT id FROM investor_evidence_model_checkpoints WHERE model_id=NEW.model_id ORDER BY sequence DESC LIMIT 1))))
    THEN RAISE(ABORT,'legacy transition source binding differs') END;
END;
CREATE TRIGGER investor_transition_admission_insert BEFORE INSERT ON investor_legacy_transition_admissions BEGIN
  SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NEW.workspace_revision IS NOT (SELECT revision+1 FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR json_extract(NEW.document_json,'$.request.expected_revision') IS NOT NEW.workspace_revision-1
    OR NOT EXISTS(SELECT 1 FROM investor_legacy_transition_confirmations c
      JOIN investor_monitor_evidence_inputs i ON i.id=NEW.input_id AND i.workspace_id=c.workspace_id AND i.model_id=c.model_id
      JOIN audit_events a ON a.id=NEW.audit_id WHERE c.id=NEW.transition_id AND c.workspace_id=NEW.workspace_id AND c.model_id=NEW.model_id
      AND c.actor_id=NEW.actor_id AND c.created_at<=NEW.created_at AND NEW.valid_until<=c.valid_until
      AND json_extract(NEW.document_json,'$.transition_hash') IS c.content_hash
      AND json_extract(NEW.document_json,'$.request.transition_id') IS c.id
      AND json_extract(NEW.document_json,'$.request.transition_hash') IS c.content_hash
      AND json_extract(i.document_json,'$.schema_version') IS 'investor-monitor-data-input-v5'
      AND json_extract(i.document_json,'$.transition.id') IS c.id AND json_extract(i.document_json,'$.transition.content_hash') IS c.content_hash
      AND i.created_at=NEW.created_at AND i.valid_until=NEW.valid_until AND i.actor_id=NEW.actor_id
      AND json_extract(NEW.document_json,'$.input_hash') IS i.content_hash
      AND i.id IS (SELECT id FROM investor_monitor_evidence_inputs WHERE model_id=NEW.model_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
      AND c.checkpoint_id IS (SELECT id FROM investor_evidence_model_checkpoints WHERE model_id=NEW.model_id ORDER BY sequence DESC LIMIT 1)
      AND a.actor_id=NEW.actor_id AND a.action='investor_register_legacy_transition_source'
      AND a.object_type='investor_legacy_transition_admission' AND a.object_id=NEW.id AND a.created_at=NEW.created_at
      AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'legacy transition admission binding differs') END;
END;
CREATE TRIGGER investor_transition_admission_update BEFORE UPDATE ON investor_legacy_transition_admissions BEGIN SELECT RAISE(ABORT,'legacy transition admission immutable'); END;
CREATE TRIGGER investor_transition_admission_delete BEFORE DELETE ON investor_legacy_transition_admissions BEGIN SELECT RAISE(ABORT,'legacy transition admission immutable'); END;
