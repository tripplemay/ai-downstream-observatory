CREATE TABLE investor_legacy_transition_previews (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id), model_id TEXT NOT NULL,
  control_id TEXT NOT NULL, legacy_input_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
  workspace_revision INTEGER NOT NULL CHECK(typeof(workspace_revision)='integer' AND workspace_revision>0),
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json) AND json_type(candidate_json)='object' AND length(CAST(candidate_json AS BLOB))<=1048576),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=32768),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>created_at),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(model_id,workspace_id) REFERENCES investor_models(id,workspace_id),
  FOREIGN KEY(control_id,workspace_id,model_id) REFERENCES investor_model_controls(id,workspace_id,model_id),
  FOREIGN KEY(legacy_input_id,workspace_id,model_id) REFERENCES investor_monitor_evidence_inputs(id,workspace_id,model_id),
  FOREIGN KEY(checkpoint_id,workspace_id,model_id) REFERENCES investor_evidence_model_checkpoints(id,workspace_id,model_id),
  UNIQUE(id,workspace_id,model_id), UNIQUE(workspace_id,idempotency_key),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-legacy-transition-witness-v1'),
  CHECK(json_extract(document_json,'$.preview_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id
    AND json_extract(document_json,'$.model_id') IS model_id AND json_extract(document_json,'$.control_id') IS control_id
    AND json_extract(document_json,'$.proof.legacy_input_id') IS legacy_input_id AND json_extract(document_json,'$.proof.checkpoint.id') IS checkpoint_id
    AND json_extract(document_json,'$.workspace_revision') IS workspace_revision AND json_extract(document_json,'$.request_hash') IS request_hash
    AND json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until),
  CHECK(json_extract(document_json,'$.checked_at')<=created_at AND valid_until<=json_extract(document_json,'$.proof.source_valid_until')),
  CHECK(json_extract(document_json,'$.approval_performed') IS 0 AND json_extract(document_json,'$.research_admitted') IS 0
    AND json_extract(document_json,'$.trading_permission') IS 0 AND json_extract(document_json,'$.provider_calls') IS 0),
  CHECK(json_extract(candidate_json,'$.schema_version') IS 'investor-monitor-data-input-v4'
    AND json_extract(candidate_json,'$.workspace_id') IS workspace_id AND json_extract(candidate_json,'$.model_id') IS model_id
    AND json_extract(candidate_json,'$.created_at') IS json_extract(document_json,'$.checked_at')
    AND json_type(candidate_json,'$.quotes') IS NULL AND json_type(candidate_json,'$.fx') IS NULL)
);
CREATE TABLE investor_legacy_transition_confirmations (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id), model_id TEXT NOT NULL UNIQUE,
  preview_id TEXT NOT NULL UNIQUE, control_id TEXT NOT NULL, legacy_input_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
  workspace_revision INTEGER NOT NULL CHECK(typeof(workspace_revision)='integer' AND workspace_revision>0),
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=32768),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>created_at),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(preview_id,workspace_id,model_id) REFERENCES investor_legacy_transition_previews(id,workspace_id,model_id),
  FOREIGN KEY(control_id,workspace_id,model_id) REFERENCES investor_model_controls(id,workspace_id,model_id),
  FOREIGN KEY(legacy_input_id,workspace_id,model_id) REFERENCES investor_monitor_evidence_inputs(id,workspace_id,model_id),
  FOREIGN KEY(checkpoint_id,workspace_id,model_id) REFERENCES investor_evidence_model_checkpoints(id,workspace_id,model_id),
  UNIQUE(id,workspace_id,model_id), UNIQUE(workspace_id,idempotency_key),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-legacy-transition-confirmation-v1'),
  CHECK(json_extract(document_json,'$.confirmation_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id
    AND json_extract(document_json,'$.model_id') IS model_id AND json_extract(document_json,'$.preview_id') IS preview_id
    AND json_extract(document_json,'$.control_id') IS control_id AND json_extract(document_json,'$.legacy_input_id') IS legacy_input_id
    AND json_extract(document_json,'$.checkpoint.id') IS checkpoint_id AND json_extract(document_json,'$.workspace_revision') IS workspace_revision
    AND json_extract(document_json,'$.request_hash') IS request_hash AND json_extract(document_json,'$.request.idempotency_key') IS idempotency_key
    AND json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until),
  CHECK(json_extract(document_json,'$.protocol') IS 'preserve_original_processed_action_knowledge_v1'
    AND json_extract(document_json,'$.monitor_data_readmission_required') IS 1 AND json_extract(document_json,'$.research_admitted') IS 0
    AND json_extract(document_json,'$.monitoring_activated') IS 0 AND json_extract(document_json,'$.trading_permission') IS 0
    AND json_extract(document_json,'$.raw_ai_sharing') IS 0 AND json_extract(document_json,'$.provider_calls') IS 0)
);
CREATE TRIGGER investor_legacy_transition_preview_insert BEFORE INSERT ON investor_legacy_transition_previews BEGIN
  SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NEW.workspace_revision IS NOT (SELECT revision+1 FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR EXISTS(SELECT 1 FROM investor_legacy_transition_confirmations WHERE model_id=NEW.model_id)
    OR NEW.control_id IS NOT (SELECT id FROM investor_model_controls WHERE model_id=NEW.model_id ORDER BY version DESC LIMIT 1)
    OR NEW.legacy_input_id IS NOT (SELECT id FROM investor_monitor_evidence_inputs WHERE model_id=NEW.model_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
    OR NEW.checkpoint_id IS NOT (SELECT id FROM investor_evidence_model_checkpoints WHERE model_id=NEW.model_id ORDER BY sequence DESC LIMIT 1)
    OR NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.id=NEW.audit_id AND a.actor_id=NEW.actor_id
      AND a.action='investor_preview_legacy_transition' AND a.object_type='investor_legacy_transition_preview' AND a.object_id=NEW.id
      AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'legacy transition preview binding differs') END;
END;
CREATE TRIGGER investor_legacy_transition_confirmation_insert BEFORE INSERT ON investor_legacy_transition_confirmations BEGIN
  SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NEW.workspace_revision IS NOT (SELECT revision+1 FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NEW.control_id IS NOT (SELECT id FROM investor_model_controls WHERE model_id=NEW.model_id ORDER BY version DESC LIMIT 1)
    OR NEW.legacy_input_id IS NOT (SELECT id FROM investor_monitor_evidence_inputs WHERE model_id=NEW.model_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
    OR NEW.checkpoint_id IS NOT (SELECT id FROM investor_evidence_model_checkpoints WHERE model_id=NEW.model_id ORDER BY sequence DESC LIMIT 1)
    OR NOT EXISTS(SELECT 1 FROM investor_legacy_transition_previews p JOIN audit_events a ON a.id=NEW.audit_id
      WHERE p.id=NEW.preview_id AND p.workspace_id=NEW.workspace_id AND p.model_id=NEW.model_id AND p.actor_id=NEW.actor_id
      AND p.control_id=NEW.control_id AND p.legacy_input_id=NEW.legacy_input_id AND p.checkpoint_id=NEW.checkpoint_id
      AND p.created_at<=NEW.created_at AND NEW.created_at<p.valid_until AND p.workspace_revision=NEW.workspace_revision-1
      AND json_extract(NEW.document_json,'$.request.expected_revision') IS p.workspace_revision
      AND json_extract(NEW.document_json,'$.request.preview_id') IS p.id
      AND json_extract(NEW.document_json,'$.request.expected_preview_hash') IS p.content_hash
      AND json_extract(NEW.document_json,'$.preview_hash') IS p.content_hash
      AND json_extract(NEW.document_json,'$.legacy_input_hash') IS json_extract(p.document_json,'$.proof.legacy_input_hash')
      AND json_extract(NEW.document_json,'$.model_hash') IS json_extract(p.document_json,'$.proof.model_hash')
      AND json_extract(NEW.document_json,'$.control_hash') IS json_extract(p.document_json,'$.proof.control_hash')
      AND json_extract(NEW.document_json,'$.carry_hash') IS json_extract(p.document_json,'$.proof.carry_hash')
      AND json_extract(NEW.document_json,'$.carry_count') IS json_extract(p.document_json,'$.proof.carry_count')
      AND json(json_extract(NEW.document_json,'$.checkpoint')) IS json(json_extract(p.document_json,'$.proof.checkpoint'))
      AND a.actor_id=NEW.actor_id AND a.action='investor_confirm_legacy_transition' AND a.object_type='investor_legacy_transition_confirmation'
      AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'legacy transition confirmation binding differs') END;
END;
CREATE TRIGGER investor_legacy_transition_preview_update BEFORE UPDATE ON investor_legacy_transition_previews BEGIN SELECT RAISE(ABORT,'legacy transition preview immutable'); END;
CREATE TRIGGER investor_legacy_transition_preview_delete BEFORE DELETE ON investor_legacy_transition_previews BEGIN SELECT RAISE(ABORT,'legacy transition preview immutable'); END;
CREATE TRIGGER investor_legacy_transition_confirmation_update BEFORE UPDATE ON investor_legacy_transition_confirmations BEGIN SELECT RAISE(ABORT,'legacy transition confirmation immutable'); END;
CREATE TRIGGER investor_legacy_transition_confirmation_delete BEFORE DELETE ON investor_legacy_transition_confirmations BEGIN SELECT RAISE(ABORT,'legacy transition confirmation immutable'); END;
