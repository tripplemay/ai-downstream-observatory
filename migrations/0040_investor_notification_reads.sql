CREATE INDEX investor_evidence_notifications_by_workspace
  ON investor_evidence_monitor_runs(workspace_id,created_at DESC,id DESC);

CREATE UNIQUE INDEX investor_notification_read_once
  ON audit_events(actor_id,object_type,object_id)
  WHERE action='investor_notification_read';

CREATE TRIGGER investor_notification_read_guard BEFORE INSERT ON audit_events
WHEN NEW.action='investor_notification_read' BEGIN
  SELECT CASE WHEN NEW.object_type IS NOT 'investor_notification'
    OR NEW.portfolio_id IS NOT NULL OR NEW.ledger_revision IS NOT NULL
    OR (SELECT count(*) FROM json_each(NEW.payload_json))!=2
    OR json_type(NEW.payload_json,'$.workspace_id') IS NOT 'text'
    OR json_type(NEW.payload_json,'$.publication_hash') IS NOT 'text'
    OR length(json_extract(NEW.payload_json,'$.publication_hash'))!=64
    OR json_extract(NEW.payload_json,'$.publication_hash') GLOB '*[^a-f0-9]*'
    OR NOT EXISTS(SELECT 1 FROM outbox o
      JOIN investor_evidence_monitor_runs r ON o.dedup_key='investor-monitor:' || r.id
      JOIN investor_workspaces w ON w.id=r.workspace_id
      JOIN job_runs j ON j.id=r.job_id
      WHERE o.id=NEW.object_id AND w.owner_id=NEW.actor_id
        AND w.id=json_extract(NEW.payload_json,'$.workspace_id')
        AND o.topic='investor.observation.changed'
        AND o.created_at=substr(r.created_at,1,length(r.created_at)-1) || '000Z'
        AND NEW.created_at>=r.created_at
        AND json_extract(o.payload_json,'$.workspace_id') IS r.workspace_id
        AND json_extract(o.payload_json,'$.model_id') IS r.model_id
        AND json_extract(o.payload_json,'$.observation_id') IS r.observation_id
        AND json_extract(o.payload_json,'$.outcome') IS CASE WHEN r.status='blocked' THEN 'insufficient_evidence' ELSE r.status END
        AND json_extract(o.payload_json,'$.live_advice_eligible') IS 0
        AND j.status='succeeded' AND j.job_type='investor_evidence_monitor'
        AND j.scope=r.workspace_id AND j.command_request_id IS NULL)
    THEN RAISE(ABORT,'investor notification read binding is invalid') END;
END;
