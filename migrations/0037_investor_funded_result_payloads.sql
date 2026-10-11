CREATE TABLE investor_funded_result_headers (
  run_id TEXT NOT NULL REFERENCES investor_funded_study_runs(id),
  parameters_hash TEXT NOT NULL CHECK(length(parameters_hash)=64 AND parameters_hash NOT GLOB '*[^a-f0-9]*'),
  workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64 AND input_hash NOT GLOB '*[^a-f0-9]*'),
  result_hash TEXT NOT NULL CHECK(length(result_hash)=64 AND result_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>created_at),
  PRIMARY KEY(run_id,parameters_hash)
);
CREATE TABLE investor_funded_result_payloads (
  run_id TEXT NOT NULL, parameters_hash TEXT NOT NULL,
  payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload) BETWEEN 1 AND 1048576),
  PRIMARY KEY(run_id,parameters_hash),
  FOREIGN KEY(run_id,parameters_hash) REFERENCES investor_funded_result_headers(run_id,parameters_hash)
);
CREATE TABLE investor_funded_result_purges (
  run_id TEXT NOT NULL, parameters_hash TEXT NOT NULL, workspace_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('retention_expired','source_unavailable')),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  PRIMARY KEY(run_id,parameters_hash),
  FOREIGN KEY(run_id,parameters_hash) REFERENCES investor_funded_result_headers(run_id,parameters_hash)
);
CREATE TRIGGER investor_funded_result_header_insert BEFORE INSERT ON investor_funded_result_headers BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_funded_result_headers WHERE run_id=NEW.run_id AND parameters_hash=NEW.parameters_hash)
    OR NOT EXISTS(SELECT 1 FROM investor_funded_study_runs u JOIN investor_funded_study_requests r ON r.id=u.request_id
      JOIN investor_evidence_inputs i ON i.id=r.evidence_input_id AND i.workspace_id=r.workspace_id
      JOIN job_runs j ON j.id=u.job_id JOIN json_each(u.document_json,'$.candidates') c
      WHERE u.id=NEW.run_id AND u.workspace_id=NEW.workspace_id AND r.workspace_id=u.workspace_id
        AND j.job_type='investor_funded_study' AND j.status='running' AND j.scope=r.workspace_id AND j.period=r.id
        AND j.input_version=r.input_version AND j.command_request_id IS NULL AND NEW.created_at=u.created_at
        AND NEW.valid_until=i.valid_until AND json_extract(c.value,'$.parameters_hash') IS NEW.parameters_hash
        AND json_extract(c.value,'$.input_hash') IS NEW.input_hash AND json_extract(c.value,'$.result_hash') IS NEW.result_hash)
    THEN RAISE(ABORT,'funded result binding differs') END;
END;
CREATE TRIGGER investor_funded_result_header_update BEFORE UPDATE ON investor_funded_result_headers BEGIN SELECT RAISE(ABORT,'funded result header is immutable'); END;
CREATE TRIGGER investor_funded_result_header_delete BEFORE DELETE ON investor_funded_result_headers BEGIN SELECT RAISE(ABORT,'funded result header is immutable'); END;
CREATE TRIGGER investor_funded_result_payload_insert BEFORE INSERT ON investor_funded_result_payloads BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_funded_result_payloads WHERE run_id=NEW.run_id AND parameters_hash=NEW.parameters_hash)
    OR EXISTS(SELECT 1 FROM investor_funded_result_purges WHERE run_id=NEW.run_id AND parameters_hash=NEW.parameters_hash)
    OR NOT EXISTS(SELECT 1 FROM investor_funded_study_runs u JOIN job_runs j ON j.id=u.job_id
      WHERE u.id=NEW.run_id AND j.job_type='investor_funded_study' AND j.status='running' AND j.command_request_id IS NULL)
    THEN RAISE(ABORT,'funded result payload cannot be replaced') END;
END;
CREATE TRIGGER investor_funded_result_payload_update BEFORE UPDATE ON investor_funded_result_payloads BEGIN SELECT RAISE(ABORT,'funded result payload is immutable'); END;
CREATE TRIGGER investor_funded_result_payload_delete BEFORE DELETE ON investor_funded_result_payloads BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM investor_funded_result_purges WHERE run_id=OLD.run_id AND parameters_hash=OLD.parameters_hash)
    THEN RAISE(ABORT,'funded result payload requires purge') END;
END;
CREATE TRIGGER investor_funded_result_purge_insert BEFORE INSERT ON investor_funded_result_purges BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_funded_result_purges WHERE run_id=NEW.run_id AND parameters_hash=NEW.parameters_hash)
    OR NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NOT EXISTS(SELECT 1 FROM investor_funded_result_headers WHERE run_id=NEW.run_id AND parameters_hash=NEW.parameters_hash AND workspace_id=NEW.workspace_id)
    OR NOT EXISTS(SELECT 1 FROM audit_events WHERE id=NEW.audit_id AND actor_id=NEW.actor_id AND action='investor_purge_funded_result'
      AND object_type='investor_funded_result' AND object_id=NEW.run_id AND created_at=NEW.created_at
      AND portfolio_id IS NULL AND ledger_revision IS NULL AND json_extract(payload_json,'$.parameters_hash') IS NEW.parameters_hash
      AND json_extract(payload_json,'$.reason') IS NEW.reason)
    THEN RAISE(ABORT,'funded result purge binding differs') END;
END;
CREATE TRIGGER investor_funded_result_purge_update BEFORE UPDATE ON investor_funded_result_purges BEGIN SELECT RAISE(ABORT,'funded result purge is immutable'); END;
CREATE TRIGGER investor_funded_result_purge_delete BEFORE DELETE ON investor_funded_result_purges BEGIN SELECT RAISE(ABORT,'funded result purge is immutable'); END;
