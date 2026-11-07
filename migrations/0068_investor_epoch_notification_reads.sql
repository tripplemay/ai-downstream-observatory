-- Only actual continuation notices extend the historical read-audit protocol.
-- Paused registration roots deliberately do not manufacture outbox messages.
DROP TRIGGER investor_notification_read_guard;
CREATE TRIGGER investor_notification_read_guard BEFORE INSERT ON audit_events
WHEN NEW.action='investor_notification_read' BEGIN
  SELECT CASE WHEN NEW.object_type IS NOT 'investor_notification'
    OR NEW.portfolio_id IS NOT NULL OR NEW.ledger_revision IS NOT NULL
    OR (SELECT count(*) FROM json_each(NEW.payload_json))!=2
    OR json_type(NEW.payload_json,'$.workspace_id') IS NOT 'text'
    OR json_type(NEW.payload_json,'$.publication_hash') IS NOT 'text'
    OR length(json_extract(NEW.payload_json,'$.publication_hash'))!=64
    OR json_extract(NEW.payload_json,'$.publication_hash') GLOB '*[^a-f0-9]*'
    OR NOT EXISTS(SELECT 1 FROM investor_evidence_monitor_runs r
      JOIN investor_workspaces w ON w.id=r.workspace_id
      JOIN investor_evidence_monitor_requests q ON q.id=r.request_id AND q.workspace_id=r.workspace_id AND q.model_id=r.model_id
      JOIN job_runs j ON j.id=r.job_id
      LEFT JOIN investor_epoch_continuations c ON c.monitor_run_id=r.id
      JOIN outbox o ON o.dedup_key=CASE WHEN c.id IS NULL THEN 'investor-monitor:' || r.id ELSE 'epoch-continuation:' || c.id END
      WHERE o.id=NEW.object_id AND w.owner_id=NEW.actor_id
        AND w.id=json_extract(NEW.payload_json,'$.workspace_id')
        AND NOT EXISTS(SELECT 1 FROM investor_model_epochs e WHERE e.monitor_run_id=r.id)
        AND o.topic='investor.observation.changed'
        AND o.created_at=substr(r.created_at,1,length(r.created_at)-1) || '000Z'
        AND NEW.created_at>=r.created_at
        AND (SELECT count(*) FROM json_each(o.payload_json))=5
        AND json_extract(o.payload_json,'$.workspace_id') IS r.workspace_id
        AND json_extract(o.payload_json,'$.model_id') IS r.model_id
        AND json_extract(o.payload_json,'$.observation_id') IS r.observation_id
        AND json_extract(o.payload_json,'$.outcome') IS CASE WHEN r.status='blocked' THEN 'insufficient_evidence' ELSE r.status END
        AND json_extract(o.payload_json,'$.live_advice_eligible') IS 0
        AND j.status='succeeded' AND j.job_type='investor_evidence_monitor'
        AND j.scope=r.workspace_id AND j.period=r.request_id AND j.command_request_id IS NULL
        AND j.input_version=q.input_version AND j.input_version IS json_extract(r.document_json,'$.input_version')
        AND ((c.id IS NULL AND json_extract(q.document_json,'$.schema_version') IN ('investor-evidence-monitor-request-v1','investor-evidence-monitor-request-v2'))
          OR (c.id IS NOT NULL AND json_extract(q.document_json,'$.schema_version')='investor-evidence-monitor-request-v4'
            AND c.workspace_id=r.workspace_id AND c.model_id=r.model_id AND c.actor_id=NEW.actor_id
            AND c.request_id=r.request_id AND c.job_id=r.job_id AND c.checkpoint_id=r.checkpoint_id
            AND c.created_at=r.created_at AND c.valid_until=r.valid_until
            AND json_extract(c.document_json,'$.publication_id') IS c.id
            AND json_extract(c.document_json,'$.monitor_run_id') IS r.id
            AND json_extract(c.document_json,'$.observation_id') IS r.observation_id
            AND (SELECT count(*) FROM json_each(j.result_json))=7
            AND json_extract(j.result_json,'$.publication_id') IS c.id
            AND json_extract(j.result_json,'$.epoch_id') IS c.epoch_id
            AND json_extract(j.result_json,'$.monitor_run_id') IS r.id
            AND json_extract(j.result_json,'$.observation_id') IS r.observation_id
            AND json_extract(j.result_json,'$.checkpoint_id') IS c.checkpoint_id
            AND json_extract(j.result_json,'$.status') IS 'epoch_continuation_published'
            AND json_extract(j.result_json,'$.live_advice_eligible') IS 0
            AND EXISTS(SELECT 1 FROM job_attempts a WHERE a.job_id=j.id AND a.attempt=j.attempt_count
              AND a.status='succeeded' AND a.fencing_token=j.fencing_token AND a.error_json IS NULL
              AND a.finished_at=j.updated_at))))
    THEN RAISE(ABORT,'investor notification read binding is invalid') END;
END;
