CREATE TRIGGER investor_ai_pending_capacity BEFORE INSERT ON investor_ai_requests BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM investor_ai_requests r
      LEFT JOIN investor_ai_dispatches d ON d.request_id=r.id
      LEFT JOIN investor_ai_purges p ON p.request_id=r.id
      WHERE d.request_id IS NULL AND p.request_id IS NULL)>=64
    THEN RAISE(ABORT,'AI pending capacity exceeded') END;
END;
CREATE TRIGGER investor_ai_dispatch_purge_guard BEFORE INSERT ON investor_ai_dispatches BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_ai_purges WHERE request_id=NEW.request_id)
    THEN RAISE(ABORT,'AI purged intent cannot dispatch') END;
END;
CREATE INDEX investor_ai_pending_order ON investor_ai_requests(actor_id,created_at,id);
