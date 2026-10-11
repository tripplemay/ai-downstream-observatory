CREATE TRIGGER investor_evidence_funding_request_insert BEFORE INSERT ON investor_evidence_monitor_requests BEGIN
  SELECT CASE WHEN (
    json_extract(NEW.document_json,'$.schema_version')='investor-evidence-monitor-request-v2'
    OR json_extract(NEW.document_json,'$.engine_version')='investor-evidence-model-watcher-v4'
    OR json_type(NEW.document_json,'$.funding_binding') IS NOT NULL
    OR json_type(NEW.document_json,'$.funding_context_hash') IS NOT NULL
  ) AND (
    json_extract(NEW.document_json,'$.schema_version') IS NOT 'investor-evidence-monitor-request-v2'
    OR json_extract(NEW.document_json,'$.engine_version') IS NOT 'investor-evidence-model-watcher-v4'
    OR (SELECT count(*) FROM json_each(NEW.document_json))<>9
    OR json_type(NEW.document_json,'$.funding_binding') IS NOT 'object'
    OR (SELECT count(*) FROM json_each(NEW.document_json,'$.funding_binding'))<>7
    OR json_type(NEW.document_json,'$.funding_context_hash') IS NOT 'text'
    OR length(json_extract(NEW.document_json,'$.funding_context_hash'))<>64
    OR json_extract(NEW.document_json,'$.funding_context_hash') GLOB '*[^a-f0-9]*'
    OR NOT EXISTS(SELECT 1 FROM investor_funding_plans f JOIN investor_models m ON m.id=NEW.model_id AND m.workspace_id=f.workspace_id
      JOIN investor_workspaces w ON w.id=f.workspace_id
      WHERE f.workspace_id=NEW.workspace_id AND f.version=(SELECT max(version) FROM investor_funding_plans WHERE workspace_id=f.workspace_id)
      AND f.id IS json_extract(NEW.document_json,'$.funding_binding.funding_plan_id')
      AND f.content_hash IS json_extract(NEW.document_json,'$.funding_binding.funding_plan_hash')
      AND f.profile_id=m.profile_id AND f.profile_hash IS json_extract(NEW.document_json,'$.profile_hash')
      AND f.profile_hash IS json_extract(NEW.document_json,'$.funding_binding.profile_hash')
      AND m.content_hash IS json_extract(NEW.document_json,'$.model_hash')
      AND m.content_hash IS json_extract(NEW.document_json,'$.funding_binding.model_hash')
      AND m.id IS json_extract(NEW.document_json,'$.funding_binding.model_id')
      AND m.created_at IS json_extract(NEW.document_json,'$.funding_binding.model_created_at')
      AND f.created_at IS json_extract(NEW.document_json,'$.funding_binding.plan_declared_at')
      AND f.created_at<=NEW.created_at AND m.created_at<=NEW.created_at AND f.actor_id=w.owner_id)
  ) THEN RAISE(ABORT,'planned funding request binding differs') END;
  SELECT CASE WHEN json_extract(NEW.document_json,'$.schema_version')='investor-evidence-monitor-request-v1'
    AND EXISTS(SELECT 1 FROM investor_funding_plans WHERE workspace_id=NEW.workspace_id)
    THEN RAISE(ABORT,'saved funding plan requires versioned monitoring') END;
END;

CREATE TRIGGER investor_evidence_funding_checkpoint_payload_insert BEFORE INSERT ON investor_evidence_checkpoint_payloads
WHEN CASE WHEN json_valid(CAST(NEW.payload AS TEXT)) THEN json_extract(CAST(NEW.payload AS TEXT),'$.schema_version') END='investor-evidence-model-checkpoint-v3'
  OR EXISTS(SELECT 1 FROM investor_evidence_model_checkpoints c
    JOIN investor_evidence_monitor_requests r ON r.model_id=c.model_id AND r.workspace_id=c.workspace_id AND r.input_id=c.input_id
    JOIN job_runs j ON j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.input_version
    WHERE c.id=NEW.checkpoint_id AND j.job_type='investor_evidence_monitor' AND j.command_request_id IS NULL AND j.status='running'
    AND json_extract(r.document_json,'$.engine_version')='investor-evidence-model-watcher-v4'
    AND c.previous_hash IS json_extract(r.document_json,'$.checkpoint_hash') AND c.created_at>=r.created_at)
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM investor_evidence_model_checkpoints c
    JOIN investor_evidence_monitor_requests r ON r.model_id=c.model_id AND r.workspace_id=c.workspace_id AND r.input_id=c.input_id
    JOIN job_runs j ON j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.input_version
    WHERE c.id=NEW.checkpoint_id AND json_valid(CAST(NEW.payload AS TEXT))
    AND json_extract(CAST(NEW.payload AS TEXT),'$.schema_version')='investor-evidence-model-checkpoint-v3'
    AND j.job_type='investor_evidence_monitor' AND j.command_request_id IS NULL AND j.status='running'
    AND json_extract(r.document_json,'$.engine_version')='investor-evidence-model-watcher-v4'
    AND c.previous_hash IS json_extract(r.document_json,'$.checkpoint_hash') AND c.created_at>=r.created_at
    AND c.model_id IS json_extract(CAST(NEW.payload AS TEXT),'$.model_id')
    AND c.projection_hash IS json_extract(CAST(NEW.payload AS TEXT),'$.projection_hash')
    AND c.created_at IS json_extract(CAST(NEW.payload AS TEXT),'$.created_at')
    AND c.previous_hash IS json_extract(CAST(NEW.payload AS TEXT),'$.previous_hash')
    AND c.sequence IS json_extract(CAST(NEW.payload AS TEXT),'$.sequence')
    AND json_extract(r.document_json,'$.funding_binding') IS json_extract(CAST(NEW.payload AS TEXT),'$.funding_binding'))
    THEN RAISE(ABORT,'planned funding checkpoint binding differs') END;
END;

CREATE TRIGGER investor_evidence_funding_run_insert BEFORE INSERT ON investor_evidence_monitor_runs
WHEN (SELECT json_extract(document_json,'$.engine_version') FROM investor_evidence_monitor_requests WHERE id=NEW.request_id)='investor-evidence-model-watcher-v4'
  AND NEW.checkpoint_id IS NOT NULL
  AND NEW.checkpoint_id IS NOT (SELECT checkpoint_id FROM investor_evidence_monitor_requests WHERE id=NEW.request_id)
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM investor_evidence_checkpoint_payloads p JOIN investor_evidence_monitor_requests r ON r.id=NEW.request_id
    WHERE p.checkpoint_id=NEW.checkpoint_id AND json_valid(CAST(p.payload AS TEXT))
    AND json_extract(CAST(p.payload AS TEXT),'$.schema_version')='investor-evidence-model-checkpoint-v3'
    AND json_extract(r.document_json,'$.funding_binding') IS json_extract(CAST(p.payload AS TEXT),'$.funding_binding'))
    THEN RAISE(ABORT,'planned funding run checkpoint differs') END;
END;
