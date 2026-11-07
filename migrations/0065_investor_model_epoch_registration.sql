-- A separate owner decision and atomic first state; no automatic epoch recovery.
CREATE TABLE investor_model_epoch_previews (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, epoch_id TEXT NOT NULL UNIQUE,
  workspace_revision INTEGER NOT NULL CHECK(typeof(workspace_revision)='integer' AND workspace_revision>0),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(CAST(document_json AS BLOB))<=1048576),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>created_at),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(model_id,workspace_id) REFERENCES investor_models(id,workspace_id),
  UNIQUE(id,workspace_id,model_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-model-epoch-preview-v1'),
  CHECK(json_extract(document_json,'$.preview_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id
    AND json_extract(document_json,'$.model_id') IS model_id AND json_extract(document_json,'$.actor_id') IS actor_id
    AND json_extract(document_json,'$.epoch_definition.epoch_id') IS epoch_id
    AND json_extract(document_json,'$.workspace_revision') IS workspace_revision
    AND json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until),
  CHECK(json_extract(document_json,'$.epoch_registered') IS 0 AND json_extract(document_json,'$.trading_permission') IS 0)
);
CREATE TABLE investor_model_epoch_requests (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, preview_id TEXT NOT NULL UNIQUE,
  workspace_revision INTEGER NOT NULL CHECK(typeof(workspace_revision)='integer' AND workspace_revision>0),
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  input_version TEXT NOT NULL CHECK(length(input_version)=64 AND input_version NOT GLOB '*[^a-f0-9]*'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>created_at),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(preview_id,workspace_id,model_id) REFERENCES investor_model_epoch_previews(id,workspace_id,model_id),
  UNIQUE(id,workspace_id,model_id), UNIQUE(workspace_id,idempotency_key),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-model-epoch-request-v1'),
  CHECK(json_extract(document_json,'$.request_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id
    AND json_extract(document_json,'$.model_id') IS model_id AND json_extract(document_json,'$.actor_id') IS actor_id
    AND json_extract(document_json,'$.workspace_revision') IS workspace_revision AND json_extract(document_json,'$.preview.id') IS preview_id
    AND json_extract(document_json,'$.body.idempotency_key') IS idempotency_key
    AND json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until),
  CHECK(json_extract(document_json,'$.trading_permission') IS 0)
);
CREATE TABLE investor_model_epochs (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
  input_id TEXT NOT NULL UNIQUE, checkpoint_id TEXT NOT NULL UNIQUE, monitor_run_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id),
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json) AND length(CAST(definition_json AS BLOB))<=131072),
  definition_hash TEXT NOT NULL CHECK(length(definition_hash)=64 AND definition_hash NOT GLOB '*[^a-f0-9]*'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>created_at),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(request_id,workspace_id,model_id) REFERENCES investor_model_epoch_requests(id,workspace_id,model_id),
  FOREIGN KEY(input_id,workspace_id,model_id) REFERENCES investor_monitor_evidence_inputs(id,workspace_id,model_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(checkpoint_id,workspace_id,model_id) REFERENCES investor_evidence_model_checkpoints(id,workspace_id,model_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(monitor_run_id) REFERENCES investor_evidence_monitor_runs(id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(id,workspace_id,model_id),
  CHECK(json_extract(definition_json,'$.schema_version') IS 'investor-model-epoch-definition-v1'
    AND json_extract(definition_json,'$.epoch_id') IS id AND json_extract(definition_json,'$.workspace_id') IS workspace_id
    AND json_extract(definition_json,'$.model_id') IS model_id AND json_extract(definition_json,'$.actor_id') IS actor_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-model-epoch-registration-v1'
    AND json_extract(document_json,'$.epoch.id') IS id AND json_extract(document_json,'$.epoch.content_hash') IS definition_hash
    AND json_extract(document_json,'$.workspace_id') IS workspace_id AND json_extract(document_json,'$.model_id') IS model_id
    AND json_extract(document_json,'$.actor_id') IS actor_id AND json_extract(document_json,'$.request.id') IS request_id
    AND json_extract(document_json,'$.input.id') IS input_id AND json_extract(document_json,'$.checkpoint.id') IS checkpoint_id
    AND json_extract(document_json,'$.monitor_run_id') IS monitor_run_id AND json_extract(document_json,'$.job_id') IS job_id
    AND json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until),
  CHECK(json_extract(document_json,'$.source_registered') IS 1 AND json_extract(document_json,'$.first_state_published') IS 1
    AND json_extract(document_json,'$.monitoring_resumed') IS 0 AND json_extract(document_json,'$.historical_observations_rewritten') IS 0
    AND json_extract(document_json,'$.trading_permission') IS 0 AND json_extract(document_json,'$.provider_calls') IS 0
    AND json_extract(document_json,'$.distribution') IS 'private_owner_only_not_ai'),
  CHECK(julianday(created_at)<julianday(json_extract(document_json,'$.publication_deadline'))
    AND julianday(json_extract(document_json,'$.publication_deadline'))<=julianday(valid_until))
);
CREATE TRIGGER investor_epoch_preview_insert BEFORE INSERT ON investor_model_epoch_previews BEGIN
  SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NEW.workspace_revision IS NOT (SELECT revision+1 FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR json_extract(NEW.document_json,'$.previous_input_id') IS NOT
      (SELECT id FROM investor_monitor_evidence_inputs WHERE model_id=NEW.model_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
    OR json_extract(NEW.document_json,'$.epoch_definition.original_head_id') IS NOT
      (SELECT id FROM investor_evidence_model_checkpoints WHERE model_id=NEW.model_id ORDER BY sequence DESC LIMIT 1)
    OR NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.id=NEW.audit_id AND a.actor_id=NEW.actor_id
      AND a.action='investor_preview_model_epoch' AND a.object_type='investor_model_epoch_preview' AND a.object_id=NEW.id
      AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'epoch preview binding differs') END;
END;
CREATE TRIGGER investor_epoch_request_insert BEFORE INSERT ON investor_model_epoch_requests BEGIN
  SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NEW.workspace_revision IS NOT (SELECT revision+1 FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR json_extract(NEW.document_json,'$.body.expected_revision') IS NOT NEW.workspace_revision-1
    OR NOT EXISTS(SELECT 1 FROM investor_model_epoch_previews p JOIN audit_events a ON a.id=NEW.audit_id
      WHERE p.id=NEW.preview_id AND p.workspace_id=NEW.workspace_id AND p.model_id=NEW.model_id AND p.actor_id=NEW.actor_id
      AND p.workspace_revision=NEW.workspace_revision-1 AND p.created_at<=NEW.created_at AND NEW.created_at<NEW.valid_until AND NEW.valid_until=p.valid_until
      AND json_extract(NEW.document_json,'$.preview.content_hash') IS p.content_hash
      AND json_extract(NEW.document_json,'$.body.preview_id') IS p.id AND json_extract(NEW.document_json,'$.body.expected_preview_hash') IS p.content_hash
      AND json_extract(NEW.document_json,'$.monitor_request.epoch_request_id') IS NEW.id
      AND json_extract(NEW.document_json,'$.monitor_request.engine_version') IS 'investor-evidence-model-watcher-epoch-v1'
      AND json_extract(NEW.document_json,'$.monitor_request.epoch.id') IS p.epoch_id
      AND json_extract(NEW.document_json,'$.monitor_request.epoch.content_hash') IS json_extract(p.document_json,'$.input.epoch.content_hash')
      AND json_extract(NEW.document_json,'$.monitor_request.input_hash') IS json_extract(p.document_json,'$.source_proof.input_hash')
      AND json_extract(NEW.document_json,'$.body.acknowledgements.separate_current_epoch') IS 1
      AND json_extract(NEW.document_json,'$.body.acknowledgements.displayed_source_and_correction_bindings') IS 1
      AND json_extract(NEW.document_json,'$.body.acknowledgements.reported_coverage_not_objective_absence') IS 1
      AND json_extract(NEW.document_json,'$.body.acknowledgements.economic_carry_not_point_in_time') IS 1
      AND json_extract(NEW.document_json,'$.body.acknowledgements.preserve_original_model_and_history') IS 1
      AND json_extract(NEW.document_json,'$.body.acknowledgements.no_strategy_cash_or_trading_change') IS 1
      AND a.actor_id=NEW.actor_id AND a.action='investor_request_model_epoch' AND a.object_type='investor_model_epoch_request'
      AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'epoch request binding differs') END;
END;
CREATE TRIGGER investor_epoch_insert BEFORE INSERT ON investor_model_epochs BEGIN
  SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR json_extract(NEW.document_json,'$.workspace_revision') IS NOT (SELECT revision+1 FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NOT EXISTS(SELECT 1 FROM investor_model_epoch_requests r JOIN investor_model_epoch_previews p ON p.id=r.preview_id
      JOIN job_runs j ON j.id=NEW.job_id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id AND r.model_id=NEW.model_id AND r.actor_id=NEW.actor_id
      AND r.workspace_revision=(SELECT revision FROM investor_workspaces WHERE id=NEW.workspace_id)
      AND r.created_at<=NEW.created_at AND NEW.created_at<r.valid_until AND p.epoch_id=NEW.id
      AND julianday(json_extract(NEW.document_json,'$.publication_deadline'))<=julianday(r.valid_until)
      AND julianday(json_extract(NEW.document_json,'$.publication_deadline'))<=julianday(json_extract(NEW.document_json,'$.source_proof.valid_until'))
      AND json(json_extract(p.document_json,'$.epoch_definition')) IS json(NEW.definition_json)
      AND json_extract(NEW.document_json,'$.request.content_hash') IS r.content_hash
      AND json_extract(NEW.document_json,'$.input.content_hash') IS json_extract(p.document_json,'$.source_proof.input_hash')
      AND json_extract(p.document_json,'$.previous_input_id') IS
        (SELECT id FROM investor_monitor_evidence_inputs WHERE model_id=NEW.model_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
      AND json_extract(NEW.definition_json,'$.original_head_id') IS
        (SELECT id FROM investor_evidence_model_checkpoints WHERE model_id=NEW.model_id ORDER BY sequence DESC LIMIT 1)
      AND json_extract(NEW.definition_json,'$.model_control.id') IS
        (SELECT id FROM investor_model_controls WHERE model_id=NEW.model_id ORDER BY version DESC LIMIT 1)
      AND (SELECT enabled FROM investor_model_controls WHERE model_id=NEW.model_id ORDER BY version DESC LIMIT 1)=1
      AND NEW.valid_until<=json_extract(NEW.definition_json,'$.valid_until')
      AND j.job_type='investor_evidence_monitor' AND j.command_request_id IS NULL AND j.scope=NEW.workspace_id
      AND j.period=r.id AND j.input_version=r.input_version AND j.status='running'
      AND a.actor_id=NEW.actor_id AND a.action='investor_register_model_epoch' AND a.object_type='investor_model_epoch'
      AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'epoch registration binding differs') END;
END;
CREATE TRIGGER investor_epoch_preview_update BEFORE UPDATE ON investor_model_epoch_previews BEGIN SELECT RAISE(ABORT,'epoch preview immutable'); END;
CREATE TRIGGER investor_epoch_preview_delete BEFORE DELETE ON investor_model_epoch_previews BEGIN SELECT RAISE(ABORT,'epoch preview immutable'); END;
CREATE TRIGGER investor_epoch_request_update BEFORE UPDATE ON investor_model_epoch_requests BEGIN SELECT RAISE(ABORT,'epoch request immutable'); END;
CREATE TRIGGER investor_epoch_request_delete BEFORE DELETE ON investor_model_epoch_requests BEGIN SELECT RAISE(ABORT,'epoch request immutable'); END;
CREATE TRIGGER investor_epoch_update BEFORE UPDATE ON investor_model_epochs BEGIN SELECT RAISE(ABORT,'epoch registration immutable'); END;
CREATE TRIGGER investor_epoch_delete BEFORE DELETE ON investor_model_epochs BEGIN SELECT RAISE(ABORT,'epoch registration immutable'); END;

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
  CHECK(json_extract(document_json,'$.schema_version') IN ('investor-monitor-data-input-v1','investor-monitor-data-input-v2','investor-monitor-data-input-v3','investor-monitor-data-input-v4','investor-monitor-data-input-v5','investor-monitor-data-input-v6')),
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
       AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash
       AND ((json_extract(NEW.document_json,'$.schema_version')!='investor-monitor-data-input-v6' AND a.created_at=NEW.created_at)
         OR (json_extract(NEW.document_json,'$.schema_version')='investor-monitor-data-input-v6'
           AND a.created_at=(SELECT created_at FROM investor_model_epochs WHERE input_id=NEW.id))))
    THEN RAISE(ABORT,'monitor evidence binding differs') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.document_json,'$.segments')
    WHERE json_extract(value,'$.snapshot.mode') IS NOT 'reconstructed'
      OR json_extract(value,'$.snapshot.workspace_id') IS NOT NEW.workspace_id OR json_extract(value,'$.snapshot.created_at') IS NOT NEW.created_at)
    THEN RAISE(ABORT,'monitor evidence segment differs') END;
  SELECT CASE WHEN json_extract(NEW.document_json,'$.schema_version') IN ('investor-monitor-data-input-v4','investor-monitor-data-input-v5','investor-monitor-data-input-v6') AND EXISTS(
    SELECT 1 FROM json_each(NEW.document_json,'$.segments') WHERE json_extract(value,'$.snapshot.schema_version') IS NOT 'investor-monitor-source-snapshot-v2'
      OR json_extract(value,'$.snapshot.use_scope') IS NOT 'monitor_only' OR json_type(value,'$.snapshot.action_availability_refs') IS NOT 'array'
      OR json_extract(value,'$.snapshot.external_ai_authorized') IS NOT 0 OR json_extract(value,'$.snapshot.live_advice_eligible') IS NOT 0)
    THEN RAISE(ABORT,'monitor evidence action protocol differs') END;
  SELECT CASE WHEN (json_extract(NEW.document_json,'$.schema_version')='investor-monitor-data-input-v3'
      OR (json_extract(NEW.document_json,'$.schema_version') IN ('investor-monitor-data-input-v4','investor-monitor-data-input-v5','investor-monitor-data-input-v6') AND json_type(NEW.document_json,'$.settings.cost_assumptions')='object')) AND NOT EXISTS(
    SELECT 1 FROM investor_monitor_cost_assumptions a WHERE a.id=json_extract(NEW.document_json,'$.settings.cost_assumptions.id')
      AND a.workspace_id=NEW.workspace_id AND a.model_id=NEW.model_id AND a.content_hash=json_extract(NEW.document_json,'$.settings.cost_assumptions.content_hash')
      AND a.effective_from<=NEW.created_at AND a.version=(SELECT max(version) FROM investor_monitor_cost_assumptions WHERE model_id=NEW.model_id AND effective_from<=NEW.created_at)
      AND json(json_extract(NEW.document_json,'$.settings.policy.costs')) IS CASE WHEN a.valid_until>NEW.created_at THEN json(json_extract(a.document_json,'$.costs')) ELSE NULL END)
    THEN RAISE(ABORT,'monitor evidence cost assumptions differ') END;
  SELECT CASE WHEN json_extract(NEW.document_json,'$.schema_version')!='investor-monitor-data-input-v3'
      AND NOT (json_extract(NEW.document_json,'$.schema_version') IN ('investor-monitor-data-input-v4','investor-monitor-data-input-v5','investor-monitor-data-input-v6') AND json_type(NEW.document_json,'$.settings.cost_assumptions') IS 'object')
      AND EXISTS(SELECT 1 FROM investor_monitor_cost_assumptions WHERE model_id=NEW.model_id AND effective_from<=NEW.created_at)
    THEN RAISE(ABORT,'monitor evidence cost assumptions differ') END;
  SELECT CASE WHEN json_extract(NEW.document_json,'$.schema_version') IN ('investor-monitor-data-input-v4','investor-monitor-data-input-v5','investor-monitor-data-input-v6')
      AND json_type(NEW.document_json,'$.settings.cost_assumptions') IS NOT NULL AND json_type(NEW.document_json,'$.settings.cost_assumptions') IS NOT 'object'
    THEN RAISE(ABORT,'monitor evidence cost assumptions differ') END;
END;
CREATE TRIGGER investor_monitor_evidence_no_update BEFORE UPDATE ON investor_monitor_evidence_inputs BEGIN SELECT RAISE(ABORT,'monitor evidence is immutable'); END;
CREATE TRIGGER investor_monitor_evidence_no_delete BEFORE DELETE ON investor_monitor_evidence_inputs BEGIN SELECT RAISE(ABORT,'monitor evidence is immutable'); END;
CREATE TRIGGER investor_transition_input_insert BEFORE INSERT ON investor_monitor_evidence_inputs BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_monitor_evidence_inputs i WHERE i.id=(
      SELECT id FROM investor_monitor_evidence_inputs WHERE model_id=NEW.model_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
      AND json_extract(i.document_json,'$.schema_version')='investor-monitor-data-input-v5'
      AND json_extract(NEW.document_json,'$.schema_version')!='investor-monitor-data-input-v6'
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
CREATE TRIGGER investor_epoch_input_insert BEFORE INSERT ON investor_monitor_evidence_inputs BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_monitor_evidence_inputs i WHERE i.id=(
    SELECT id FROM investor_monitor_evidence_inputs WHERE model_id=NEW.model_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
    AND json_extract(i.document_json,'$.schema_version')='investor-monitor-data-input-v6')
    THEN RAISE(ABORT,'registered epoch requires its own continuation protocol') END;
  SELECT CASE WHEN json_extract(NEW.document_json,'$.schema_version')='investor-monitor-data-input-v6' AND NOT EXISTS(
    SELECT 1 FROM investor_model_epochs e JOIN investor_model_epoch_requests r ON r.id=e.request_id
      JOIN investor_model_epoch_previews p ON p.id=r.preview_id JOIN job_runs j ON j.id=e.job_id
    WHERE e.id=json_extract(NEW.document_json,'$.epoch.id') AND e.workspace_id=NEW.workspace_id AND e.model_id=NEW.model_id
      AND e.definition_hash=json_extract(NEW.document_json,'$.epoch.content_hash') AND e.input_id=NEW.id AND e.actor_id=NEW.actor_id
      AND json_extract(e.document_json,'$.input.content_hash') IS NEW.content_hash
      AND json(json_extract(p.document_json,'$.input')) IS json(NEW.document_json)
      AND NEW.valid_until<=json_extract(e.definition_json,'$.valid_until') AND NEW.created_at<=e.created_at AND j.status='running'
      AND json_extract(p.document_json,'$.previous_input_id') IS
        (SELECT id FROM investor_monitor_evidence_inputs WHERE model_id=NEW.model_id ORDER BY created_at DESC,rowid DESC LIMIT 1))
    THEN RAISE(ABORT,'epoch input binding differs') END;
END;
CREATE TRIGGER investor_epoch_checkpoint_insert BEFORE INSERT ON investor_evidence_model_checkpoints BEGIN
  SELECT CASE WHEN (SELECT json_extract(document_json,'$.schema_version') FROM investor_monitor_evidence_inputs WHERE id=NEW.input_id)='investor-monitor-data-input-v6'
    AND NOT EXISTS(SELECT 1 FROM investor_model_epochs e WHERE e.input_id=NEW.input_id AND e.checkpoint_id=NEW.id
      AND e.workspace_id=NEW.workspace_id AND e.model_id=NEW.model_id AND e.valid_until=NEW.valid_until
      AND json_extract(e.document_json,'$.checkpoint.content_hash') IS NEW.content_hash
      AND json_extract(e.document_json,'$.calculated_at') IS NEW.created_at
      AND json_extract(e.definition_json,'$.binding.original_head_hash') IS NEW.previous_hash)
    THEN RAISE(ABORT,'epoch checkpoint binding differs') END;
END;
