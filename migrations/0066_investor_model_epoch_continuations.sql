-- Explicit research-only activation and atomic continuations of a real epoch.
CREATE TABLE investor_epoch_controls (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, epoch_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 1000),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), idempotency_key TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>created_at),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(epoch_id,workspace_id,model_id) REFERENCES investor_model_epochs(id,workspace_id,model_id),
  UNIQUE(id,workspace_id,model_id), UNIQUE(epoch_id,version), UNIQUE(workspace_id,idempotency_key),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-epoch-control-v1'
    AND json_extract(document_json,'$.control_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id
    AND json_extract(document_json,'$.model_id') IS model_id AND json_extract(document_json,'$.epoch.id') IS epoch_id
    AND json_extract(document_json,'$.actor_id') IS actor_id AND json_extract(document_json,'$.version') IS version
    AND json_extract(document_json,'$.body.enabled') IS enabled AND json_extract(document_json,'$.body.idempotency_key') IS idempotency_key
    AND json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until
    AND json_extract(document_json,'$.trading_permission') IS 0)
);
CREATE TABLE investor_epoch_continuation_requests (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, epoch_id TEXT NOT NULL,
  control_id TEXT NOT NULL, previous_input_id TEXT NOT NULL, previous_checkpoint_id TEXT NOT NULL,
  request_key TEXT NOT NULL CHECK(length(request_key)=64), input_version TEXT NOT NULL CHECK(length(input_version)=64),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(CAST(document_json AS BLOB))<=1179648),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>created_at),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(epoch_id,workspace_id,model_id) REFERENCES investor_model_epochs(id,workspace_id,model_id),
  FOREIGN KEY(control_id,workspace_id,model_id) REFERENCES investor_epoch_controls(id,workspace_id,model_id),
  FOREIGN KEY(previous_input_id,workspace_id,model_id) REFERENCES investor_monitor_evidence_inputs(id,workspace_id,model_id),
  FOREIGN KEY(previous_checkpoint_id,workspace_id,model_id) REFERENCES investor_evidence_model_checkpoints(id,workspace_id,model_id),
  UNIQUE(id,workspace_id,model_id), UNIQUE(epoch_id,request_key),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-epoch-continuation-request-v1'
    AND json_extract(document_json,'$.request_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id
    AND json_extract(document_json,'$.model_id') IS model_id AND json_extract(document_json,'$.actor_id') IS actor_id
    AND json_extract(document_json,'$.epoch.id') IS epoch_id AND json_extract(document_json,'$.activation.id') IS control_id
    AND json_extract(document_json,'$.previous_input.id') IS previous_input_id AND json_extract(document_json,'$.previous_checkpoint.id') IS previous_checkpoint_id
    AND json_extract(document_json,'$.request_key') IS request_key AND json_extract(document_json,'$.created_at') IS created_at
    AND json_extract(document_json,'$.valid_until') IS valid_until AND json_extract(document_json,'$.trading_permission') IS 0)
);
CREATE TABLE investor_epoch_continuations (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, epoch_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 1000),
  request_id TEXT NOT NULL UNIQUE, input_id TEXT NOT NULL UNIQUE, checkpoint_id TEXT NOT NULL,
  monitor_run_id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>created_at),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(epoch_id,workspace_id,model_id) REFERENCES investor_model_epochs(id,workspace_id,model_id),
  FOREIGN KEY(request_id,workspace_id,model_id) REFERENCES investor_epoch_continuation_requests(id,workspace_id,model_id),
  FOREIGN KEY(input_id,workspace_id,model_id) REFERENCES investor_monitor_evidence_inputs(id,workspace_id,model_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(checkpoint_id,workspace_id,model_id) REFERENCES investor_evidence_model_checkpoints(id,workspace_id,model_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(monitor_run_id) REFERENCES investor_evidence_monitor_runs(id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(epoch_id,sequence), UNIQUE(id,workspace_id,model_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-epoch-continuation-publication-v1'
    AND json_extract(document_json,'$.publication_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id
    AND json_extract(document_json,'$.model_id') IS model_id AND json_extract(document_json,'$.actor_id') IS actor_id
    AND json_extract(document_json,'$.epoch.id') IS epoch_id AND json_extract(document_json,'$.sequence') IS sequence
    AND json_extract(document_json,'$.request.id') IS request_id AND json_extract(document_json,'$.input.id') IS input_id
    AND json_extract(document_json,'$.checkpoint.id') IS checkpoint_id AND json_extract(document_json,'$.monitor_run_id') IS monitor_run_id
    AND json_extract(document_json,'$.job_id') IS job_id AND json_extract(document_json,'$.created_at') IS created_at
    AND json_extract(document_json,'$.valid_until') IS valid_until AND json_extract(document_json,'$.monitoring_resumed') IS 1
    AND json_extract(document_json,'$.trading_permission') IS 0 AND json_extract(document_json,'$.provider_calls') IS 0),
  CHECK(julianday(created_at)<julianday(json_extract(document_json,'$.publication_deadline'))
    AND julianday(json_extract(document_json,'$.publication_deadline'))<=julianday(valid_until))
);
CREATE TRIGGER investor_epoch_control_insert BEFORE INSERT ON investor_epoch_controls BEGIN
  SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NEW.version IS NOT (SELECT COALESCE(MAX(version),0)+1 FROM investor_epoch_controls WHERE epoch_id=NEW.epoch_id)
    OR json_extract(NEW.document_json,'$.workspace_revision') IS NOT (SELECT revision+1 FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR json_extract(NEW.document_json,'$.body.expected_revision') IS NOT (SELECT revision FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NOT EXISTS(SELECT 1 FROM investor_model_epochs e JOIN audit_events a ON a.id=NEW.audit_id
      WHERE e.id=NEW.epoch_id AND e.workspace_id=NEW.workspace_id AND e.model_id=NEW.model_id AND e.actor_id=NEW.actor_id
        AND json_extract(NEW.document_json,'$.epoch.content_hash') IS e.definition_hash
        AND json_extract(NEW.document_json,'$.registration_hash') IS e.content_hash AND NEW.valid_until<=e.valid_until
        AND json_extract(NEW.document_json,'$.body.expected_registration_hash') IS e.content_hash
        AND json_extract(NEW.document_json,'$.body.expected_checkpoint.id') IS
          (SELECT id FROM investor_evidence_model_checkpoints WHERE model_id=NEW.model_id ORDER BY sequence DESC LIMIT 1)
        AND json_extract(NEW.document_json,'$.body.expected_checkpoint.content_hash') IS
          (SELECT content_hash FROM investor_evidence_model_checkpoints WHERE model_id=NEW.model_id ORDER BY sequence DESC LIMIT 1)
        AND a.actor_id=NEW.actor_id AND a.action='investor_control_epoch_continuation' AND a.object_type='investor_epoch_control'
        AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'epoch control binding differs') END;
END;
CREATE TRIGGER investor_epoch_continuation_request_insert BEFORE INSERT ON investor_epoch_continuation_requests BEGIN
  SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR json_extract(NEW.document_json,'$.workspace_revision') IS NOT (SELECT revision FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NEW.previous_input_id IS NOT (SELECT id FROM investor_monitor_evidence_inputs WHERE model_id=NEW.model_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
    OR NEW.previous_checkpoint_id IS NOT (SELECT id FROM investor_evidence_model_checkpoints WHERE model_id=NEW.model_id ORDER BY sequence DESC LIMIT 1)
    OR NOT EXISTS(SELECT 1 FROM investor_epoch_controls c JOIN investor_model_epochs e ON e.id=c.epoch_id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE c.id=NEW.control_id AND c.epoch_id=NEW.epoch_id AND c.workspace_id=NEW.workspace_id AND c.model_id=NEW.model_id
        AND c.enabled=1 AND c.version=(SELECT MAX(version) FROM investor_epoch_controls WHERE epoch_id=c.epoch_id)
        AND c.created_at<=NEW.created_at AND NEW.valid_until<=c.valid_until AND json_extract(NEW.document_json,'$.activation.content_hash') IS c.content_hash
        AND json_extract(NEW.document_json,'$.epoch.content_hash') IS e.definition_hash AND json_extract(NEW.document_json,'$.registration_hash') IS e.content_hash
        AND json_extract(NEW.document_json,'$.monitor_request.engine_version') IS 'investor-evidence-model-watcher-epoch-continuation-v1'
        AND json_extract(NEW.document_json,'$.monitor_request.continuation_request_id') IS NEW.id
        AND a.actor_id=NEW.actor_id AND a.action='investor_request_epoch_continuation' AND a.object_type='investor_epoch_continuation_request'
        AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'epoch continuation request binding differs') END;
END;
CREATE TRIGGER investor_epoch_continuation_insert BEFORE INSERT ON investor_epoch_continuations BEGIN
  SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NEW.sequence IS NOT (SELECT COALESCE(MAX(sequence),0)+1 FROM investor_epoch_continuations WHERE epoch_id=NEW.epoch_id)
    OR NOT EXISTS(SELECT 1 FROM investor_epoch_continuation_requests r JOIN investor_epoch_controls c ON c.id=r.control_id
      JOIN job_runs j ON j.id=NEW.job_id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id AND r.model_id=NEW.model_id AND r.epoch_id=NEW.epoch_id
        AND r.previous_input_id IS (SELECT id FROM investor_monitor_evidence_inputs WHERE model_id=NEW.model_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
        AND r.previous_checkpoint_id IS (SELECT id FROM investor_evidence_model_checkpoints WHERE model_id=NEW.model_id ORDER BY sequence DESC LIMIT 1)
        AND r.created_at<=NEW.created_at AND NEW.created_at<r.valid_until AND NEW.valid_until<=json_extract(r.document_json,'$.source_ceiling')
        AND json_extract(r.document_json,'$.workspace_revision') IS (SELECT revision FROM investor_workspaces WHERE id=NEW.workspace_id)
        AND json_extract(NEW.document_json,'$.workspace_revision') IS (SELECT revision+1 FROM investor_workspaces WHERE id=NEW.workspace_id)
        AND json_extract(NEW.document_json,'$.request.content_hash') IS r.content_hash AND json_extract(NEW.document_json,'$.input.content_hash') IS json_extract(r.document_json,'$.source_proof.input_hash')
        AND c.enabled=1 AND c.version=(SELECT MAX(version) FROM investor_epoch_controls WHERE epoch_id=NEW.epoch_id)
        AND json_extract(NEW.document_json,'$.activation.id') IS c.id AND json_extract(NEW.document_json,'$.activation.content_hash') IS c.content_hash
        AND j.job_type='investor_evidence_monitor' AND j.command_request_id IS NULL AND j.scope=NEW.workspace_id
        AND j.period=r.id AND j.input_version=r.input_version AND j.status='running'
        AND a.actor_id=NEW.actor_id AND a.action='investor_publish_epoch_continuation' AND a.object_type='investor_epoch_continuation'
        AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'epoch continuation publication binding differs') END;
END;
CREATE TRIGGER investor_epoch_control_update BEFORE UPDATE ON investor_epoch_controls BEGIN SELECT RAISE(ABORT,'epoch control immutable'); END;
CREATE TRIGGER investor_epoch_control_delete BEFORE DELETE ON investor_epoch_controls BEGIN SELECT RAISE(ABORT,'epoch control immutable'); END;
CREATE TRIGGER investor_epoch_continuation_request_update BEFORE UPDATE ON investor_epoch_continuation_requests BEGIN SELECT RAISE(ABORT,'epoch continuation request immutable'); END;
CREATE TRIGGER investor_epoch_continuation_request_delete BEFORE DELETE ON investor_epoch_continuation_requests BEGIN SELECT RAISE(ABORT,'epoch continuation request immutable'); END;
CREATE TRIGGER investor_epoch_continuation_update BEFORE UPDATE ON investor_epoch_continuations BEGIN SELECT RAISE(ABORT,'epoch continuation immutable'); END;
CREATE TRIGGER investor_epoch_continuation_delete BEFORE DELETE ON investor_epoch_continuations BEGIN SELECT RAISE(ABORT,'epoch continuation immutable'); END;

-- Preserve ordinary admission checks; only the authenticated v6 publication
-- audit clock has a second, distinct journal authority.
DROP TRIGGER investor_monitor_evidence_insert;
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
           AND a.created_at=COALESCE((SELECT created_at FROM investor_model_epochs WHERE input_id=NEW.id),
             (SELECT created_at FROM investor_epoch_continuations WHERE input_id=NEW.id)))))
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
DROP TRIGGER investor_epoch_input_insert;
CREATE TRIGGER investor_epoch_input_insert BEFORE INSERT ON investor_monitor_evidence_inputs BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_monitor_evidence_inputs i WHERE i.id=(
    SELECT id FROM investor_monitor_evidence_inputs WHERE model_id=NEW.model_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
    AND json_extract(i.document_json,'$.schema_version')='investor-monitor-data-input-v6')
    AND NOT EXISTS(SELECT 1 FROM investor_epoch_continuations p JOIN investor_epoch_continuation_requests r ON r.id=p.request_id
      JOIN job_runs j ON j.id=p.job_id WHERE p.input_id=NEW.id AND p.workspace_id=NEW.workspace_id AND p.model_id=NEW.model_id
      AND r.previous_input_id IS (SELECT id FROM investor_monitor_evidence_inputs WHERE model_id=NEW.model_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
      AND j.status='running' AND json_extract(NEW.document_json,'$.schema_version')='investor-monitor-data-input-v6')
    THEN RAISE(ABORT,'registered epoch requires its own continuation protocol') END;
  SELECT CASE WHEN json_extract(NEW.document_json,'$.schema_version')='investor-monitor-data-input-v6' AND NOT EXISTS(
    SELECT 1 FROM investor_model_epochs e JOIN investor_model_epoch_requests r ON r.id=e.request_id
      JOIN investor_model_epoch_previews v ON v.id=r.preview_id JOIN job_runs j ON j.id=e.job_id
    WHERE e.id=json_extract(NEW.document_json,'$.epoch.id') AND e.workspace_id=NEW.workspace_id AND e.model_id=NEW.model_id
      AND e.definition_hash=json_extract(NEW.document_json,'$.epoch.content_hash') AND e.input_id=NEW.id AND e.actor_id=NEW.actor_id
      AND json_extract(e.document_json,'$.input.content_hash') IS NEW.content_hash AND json(json_extract(v.document_json,'$.input')) IS json(NEW.document_json)
      AND NEW.valid_until<=json_extract(e.definition_json,'$.valid_until') AND NEW.created_at<=e.created_at AND j.status='running'
      AND json_extract(v.document_json,'$.previous_input_id') IS
        (SELECT id FROM investor_monitor_evidence_inputs WHERE model_id=NEW.model_id ORDER BY created_at DESC,rowid DESC LIMIT 1))
    AND NOT EXISTS(SELECT 1 FROM investor_epoch_continuations p JOIN investor_epoch_continuation_requests r ON r.id=p.request_id
      JOIN investor_model_epochs e ON e.id=p.epoch_id JOIN job_runs j ON j.id=p.job_id
      WHERE p.input_id=NEW.id AND p.workspace_id=NEW.workspace_id AND p.model_id=NEW.model_id AND p.actor_id=NEW.actor_id
        AND e.id=json_extract(NEW.document_json,'$.epoch.id') AND e.definition_hash=json_extract(NEW.document_json,'$.epoch.content_hash')
        AND json_extract(p.document_json,'$.input.content_hash') IS NEW.content_hash
        AND json(json_extract(r.document_json,'$.input')) IS json(NEW.document_json) AND NEW.valid_until<=json_extract(e.definition_json,'$.valid_until')
        AND NEW.created_at<=p.created_at AND j.status='running')
    THEN RAISE(ABORT,'epoch input binding differs') END;
END;
DROP TRIGGER investor_epoch_checkpoint_insert;
CREATE TRIGGER investor_epoch_checkpoint_insert BEFORE INSERT ON investor_evidence_model_checkpoints BEGIN
  SELECT CASE WHEN (SELECT json_extract(document_json,'$.schema_version') FROM investor_monitor_evidence_inputs WHERE id=NEW.input_id)='investor-monitor-data-input-v6'
    AND NOT EXISTS(SELECT 1 FROM investor_model_epochs e WHERE e.input_id=NEW.input_id AND e.checkpoint_id=NEW.id
      AND e.workspace_id=NEW.workspace_id AND e.model_id=NEW.model_id AND e.valid_until=NEW.valid_until
      AND json_extract(e.document_json,'$.checkpoint.content_hash') IS NEW.content_hash
      AND json_extract(e.document_json,'$.calculated_at') IS NEW.created_at
      AND json_extract(e.definition_json,'$.binding.original_head_hash') IS NEW.previous_hash)
    AND NOT EXISTS(SELECT 1 FROM investor_epoch_continuations p JOIN investor_epoch_continuation_requests r ON r.id=p.request_id
      WHERE p.input_id=NEW.input_id AND p.checkpoint_id=NEW.id AND p.workspace_id=NEW.workspace_id AND p.model_id=NEW.model_id
        AND p.valid_until=NEW.valid_until AND json_extract(p.document_json,'$.checkpoint_reused') IS 0
        AND json_extract(p.document_json,'$.checkpoint.content_hash') IS NEW.content_hash
        AND json_extract(p.document_json,'$.calculated_at') IS NEW.created_at
        AND json_extract(r.document_json,'$.previous_checkpoint.content_hash') IS NEW.previous_hash)
    THEN RAISE(ABORT,'epoch checkpoint binding differs') END;
END;
