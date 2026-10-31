CREATE TABLE investor_eodhd_authorities (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,content_hash),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-eodhd-policy-v1'),
  CHECK(json_extract(document_json,'$.provider') IS 'eodhd_action_drafts'),
  CHECK(json_extract(document_json,'$.max_requests_per_day') IS 4 AND json_extract(document_json,'$.retention_years') IS 10),
  CHECK(json_type(document_json,'$.automatic_retry') IS 'false' AND json_type(document_json,'$.raw_ai_sharing') IS 'false'
    AND json_type(document_json,'$.quote_replacement') IS 'false' AND json_type(document_json,'$.trading_permission') IS 'false')
);
CREATE TABLE investor_eodhd_controls (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, authority_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 1000), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=4096),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(authority_id,workspace_id) REFERENCES investor_eodhd_authorities(id,workspace_id),
  UNIQUE(authority_id,version), UNIQUE(id,workspace_id,authority_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-eodhd-control-v1'),
  CHECK(json_extract(document_json,'$.authority_id') IS authority_id AND json_extract(document_json,'$.version') IS version),
  CHECK(json_type(document_json,'$.enabled') IN ('true','false') AND json_extract(document_json,'$.enabled') IS enabled),
  CHECK(json_extract(document_json,'$.created_at') IS created_at)
);
CREATE TABLE investor_eodhd_requests (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, authority_id TEXT NOT NULL, control_id TEXT NOT NULL,
  symbol TEXT NOT NULL CHECK(symbol IN ('VT.US','BND.US')), kind TEXT NOT NULL CHECK(kind IN ('div','splits')), source_day TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=8192),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>created_at), audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(control_id,workspace_id,authority_id) REFERENCES investor_eodhd_controls(id,workspace_id,authority_id),
  UNIQUE(symbol,kind,source_day), UNIQUE(id,workspace_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-eodhd-request-v1'),
  CHECK(json_extract(document_json,'$.authority_id') IS authority_id AND json_extract(document_json,'$.control_id') IS control_id),
  CHECK(json_extract(document_json,'$.parameters.symbol') IS symbol AND json_extract(document_json,'$.parameters.kind') IS kind),
  CHECK(json_extract(document_json,'$.source_day') IS source_day AND json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_extract(document_json,'$.valid_until') IS valid_until AND json_extract(document_json,'$.collection_scope') IS 'private_unapproved_action_drafts_only')
);
CREATE TABLE investor_eodhd_captures (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id),
  fencing_token INTEGER NOT NULL CHECK(fencing_token>=1), qualification TEXT NOT NULL CHECK(qualification IN ('isolated_fixed_eodhd_https','injected_test_eodhd')),
  status TEXT NOT NULL CHECK(status IN ('captured','transport_failed','superseded')), raw_sha256 TEXT, raw_bytes INTEGER,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, retain_until TEXT, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(request_id,workspace_id) REFERENCES investor_eodhd_requests(id,workspace_id), UNIQUE(id,workspace_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-eodhd-capture-v1'),
  CHECK(json_extract(document_json,'$.capture_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id),
  CHECK(json_extract(document_json,'$.request_id') IS request_id AND json_extract(document_json,'$.job_id') IS job_id),
  CHECK(json_extract(document_json,'$.fencing_token') IS fencing_token AND json_extract(document_json,'$.qualification') IS qualification),
  CHECK(json_extract(document_json,'$.status') IS status AND json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_extract(document_json,'$.raw_sha256') IS raw_sha256 AND json_extract(document_json,'$.raw_bytes') IS raw_bytes),
  CHECK(json_extract(document_json,'$.retain_until') IS retain_until),
  CHECK(json_type(document_json,'$.owner_reviewed') IS 'false' AND json_type(document_json,'$.research_admitted') IS 'false'
    AND json_type(document_json,'$.corporate_actions_complete') IS 'false' AND json_type(document_json,'$.live_advice_eligible') IS 'false'),
  CHECK((status='captured' AND typeof(raw_sha256)='text' AND length(raw_sha256)=64 AND raw_sha256 NOT GLOB '*[^a-f0-9]*'
    AND typeof(raw_bytes)='integer' AND raw_bytes BETWEEN 1 AND 262144 AND typeof(retain_until)='text' AND retain_until>created_at
    AND json_extract(document_json,'$.reason_code') IS 'EODHD_ACTION_DRAFT_CAPTURED')
    OR (status!='captured' AND raw_sha256 IS NULL AND raw_bytes IS NULL AND retain_until IS NULL))
);
CREATE TABLE investor_eodhd_payloads (
  workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id), raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256)=64 AND raw_sha256 NOT GLOB '*[^a-f0-9]*'),
  raw_bytes INTEGER NOT NULL CHECK(raw_bytes BETWEEN 1 AND 262144), payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload)=raw_bytes),
  created_at TEXT NOT NULL, PRIMARY KEY(workspace_id,raw_sha256)
);
CREATE TABLE investor_eodhd_purges (
  capture_id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, reason TEXT NOT NULL CHECK(reason='retention_expired'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(capture_id,workspace_id) REFERENCES investor_eodhd_captures(id,workspace_id)
);
CREATE INDEX investor_eodhd_capture_retention ON investor_eodhd_captures(retain_until,id);
CREATE INDEX investor_eodhd_payload_refs ON investor_eodhd_captures(workspace_id,raw_sha256,id);
CREATE INDEX investor_eodhd_request_order ON investor_eodhd_requests(workspace_id,created_at,id);
CREATE INDEX investor_eodhd_request_day ON investor_eodhd_requests(source_day,id);
CREATE TRIGGER investor_eodhd_authority_insert BEFORE INSERT ON investor_eodhd_authorities BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_eodhd_authorities WHERE id=NEW.id OR (workspace_id=NEW.workspace_id AND content_hash=NEW.content_hash))
    OR NOT EXISTS(SELECT 1 FROM investor_workspaces w JOIN audit_events a ON a.id=NEW.audit_id
      WHERE w.id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND a.actor_id=NEW.actor_id
      AND a.action='investor_register_eodhd_authority' AND a.object_type='investor_eodhd_authority' AND a.object_id=NEW.id
      AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'eodhd authority audit differs') END;
END;
CREATE TRIGGER investor_eodhd_control_insert BEFORE INSERT ON investor_eodhd_controls BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_eodhd_controls WHERE id=NEW.id OR (authority_id=NEW.authority_id AND version=NEW.version))
    OR NEW.version IS NOT COALESCE((SELECT max(version)+1 FROM investor_eodhd_controls WHERE authority_id=NEW.authority_id),1)
    OR (NEW.version=1 AND NEW.enabled!=0)
    OR NEW.created_at<COALESCE((SELECT max(created_at) FROM investor_eodhd_controls WHERE authority_id=NEW.authority_id),NEW.created_at)
    OR NOT EXISTS(SELECT 1 FROM investor_eodhd_authorities s JOIN investor_workspaces w ON w.id=s.workspace_id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE s.id=NEW.authority_id AND s.workspace_id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND s.actor_id=NEW.actor_id AND s.created_at<=NEW.created_at
      AND json_extract(NEW.document_json,'$.authority_hash') IS s.content_hash
      AND a.actor_id=NEW.actor_id AND a.action='investor_control_eodhd_authority' AND a.object_type='investor_eodhd_control' AND a.object_id=NEW.id
      AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'eodhd control audit differs') END;
END;
CREATE TRIGGER investor_eodhd_request_insert BEFORE INSERT ON investor_eodhd_requests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_eodhd_requests WHERE id=NEW.id OR (symbol=NEW.symbol AND kind=NEW.kind AND source_day=NEW.source_day))
    OR NOT EXISTS(SELECT 1 FROM investor_eodhd_authorities s JOIN investor_eodhd_controls c ON c.authority_id=s.id AND c.workspace_id=s.workspace_id
      JOIN investor_workspaces w ON w.id=s.workspace_id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE s.id=NEW.authority_id AND s.workspace_id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND s.actor_id=NEW.actor_id
      AND s.created_at<=NEW.created_at AND c.id=NEW.control_id AND c.enabled=1 AND c.created_at<=NEW.created_at
      AND c.version=(SELECT max(version) FROM investor_eodhd_controls WHERE authority_id=s.id)
      AND json_extract(s.document_json,'$.valid_from')<=NEW.created_at AND json_extract(s.document_json,'$.valid_until')>NEW.created_at
      AND json_extract(NEW.document_json,'$.authority_hash') IS s.content_hash AND json_extract(NEW.document_json,'$.control_hash') IS c.content_hash
      AND a.actor_id=NEW.actor_id AND a.action='investor_schedule_eodhd_capture' AND a.object_type='investor_eodhd_request' AND a.object_id=NEW.id
      AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'eodhd request audit differs') END;
END;
CREATE TRIGGER investor_eodhd_capture_insert BEFORE INSERT ON investor_eodhd_captures BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_eodhd_captures WHERE id=NEW.id OR request_id=NEW.request_id OR job_id=NEW.job_id)
    OR NOT EXISTS(SELECT 1 FROM investor_eodhd_requests r JOIN investor_eodhd_authorities s ON s.id=r.authority_id AND s.workspace_id=r.workspace_id
      JOIN investor_eodhd_controls c ON c.id=r.control_id AND c.authority_id=s.id AND c.workspace_id=s.workspace_id
      JOIN investor_workspaces w ON w.id=r.workspace_id JOIN audit_events a ON a.id=NEW.audit_id
      JOIN job_runs j ON j.id=NEW.job_id JOIN job_attempts attempt ON attempt.job_id=j.id AND attempt.attempt=j.attempt_count
      WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND r.actor_id=NEW.actor_id
      AND r.created_at<=NEW.created_at AND json_extract(NEW.document_json,'$.request_hash') IS r.content_hash
      AND (NEW.status='superseded' OR (NEW.created_at<r.valid_until AND c.enabled=1
        AND c.version=(SELECT max(version) FROM investor_eodhd_controls WHERE authority_id=s.id)
        AND json_extract(s.document_json,'$.valid_from')<=NEW.created_at AND json_extract(s.document_json,'$.valid_until')>NEW.created_at))
      AND j.job_type='investor_eodhd_capture' AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
      AND j.command_request_id IS NULL AND j.max_attempts=1 AND j.attempt_count=1 AND j.status='running'
      AND j.fencing_token=NEW.fencing_token AND NEW.created_at<j.lease_until AND typeof(j.lease_owner)='text' AND length(trim(j.lease_owner))>0
      AND attempt.status='running' AND attempt.fencing_token=j.fencing_token AND attempt.started_at<=NEW.created_at AND attempt.finished_at IS NULL
      AND a.actor_id=NEW.actor_id AND a.action='investor_finish_eodhd_capture' AND a.object_type='investor_eodhd_capture' AND a.object_id=NEW.id
      AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'eodhd capture job or audit differs') END;
END;
CREATE TRIGGER investor_eodhd_payload_insert BEFORE INSERT ON investor_eodhd_payloads BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_eodhd_payloads WHERE workspace_id=NEW.workspace_id AND raw_sha256=NEW.raw_sha256)
    OR NOT EXISTS(SELECT 1 FROM investor_eodhd_captures c WHERE c.workspace_id=NEW.workspace_id AND c.raw_sha256=NEW.raw_sha256
      AND c.raw_bytes=NEW.raw_bytes AND c.status='captured' AND c.created_at=NEW.created_at AND NOT EXISTS(SELECT 1 FROM investor_eodhd_purges p WHERE p.capture_id=c.id))
    THEN RAISE(ABORT,'eodhd payload requires a capture') END;
END;
CREATE TRIGGER investor_eodhd_payload_delete BEFORE DELETE ON investor_eodhd_payloads BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_eodhd_captures c WHERE c.workspace_id=OLD.workspace_id AND c.raw_sha256=OLD.raw_sha256
    AND NOT EXISTS(SELECT 1 FROM investor_eodhd_purges p WHERE p.capture_id=c.id)) THEN RAISE(ABORT,'eodhd payload still referenced') END;
END;
CREATE TRIGGER investor_eodhd_purge_insert BEFORE INSERT ON investor_eodhd_purges BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_eodhd_purges WHERE capture_id=NEW.capture_id)
    OR NOT EXISTS(SELECT 1 FROM investor_eodhd_captures c JOIN investor_workspaces w ON w.id=c.workspace_id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE c.id=NEW.capture_id AND c.workspace_id=NEW.workspace_id AND c.status='captured' AND c.retain_until<=NEW.created_at
      AND c.actor_id=NEW.actor_id AND w.owner_id=NEW.actor_id AND a.actor_id=NEW.actor_id AND a.action='investor_purge_eodhd_capture'
      AND a.object_type='investor_eodhd_capture' AND a.object_id=c.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.reason') IS NEW.reason)
    THEN RAISE(ABORT,'eodhd purge audit differs') END;
END;
CREATE TRIGGER investor_eodhd_authority_update BEFORE UPDATE ON investor_eodhd_authorities BEGIN SELECT RAISE(ABORT,'eodhd authority immutable'); END;
CREATE TRIGGER investor_eodhd_authority_delete BEFORE DELETE ON investor_eodhd_authorities BEGIN SELECT RAISE(ABORT,'eodhd authority immutable'); END;
CREATE TRIGGER investor_eodhd_control_update BEFORE UPDATE ON investor_eodhd_controls BEGIN SELECT RAISE(ABORT,'eodhd control immutable'); END;
CREATE TRIGGER investor_eodhd_control_delete BEFORE DELETE ON investor_eodhd_controls BEGIN SELECT RAISE(ABORT,'eodhd control immutable'); END;
CREATE TRIGGER investor_eodhd_request_update BEFORE UPDATE ON investor_eodhd_requests BEGIN SELECT RAISE(ABORT,'eodhd request immutable'); END;
CREATE TRIGGER investor_eodhd_request_delete BEFORE DELETE ON investor_eodhd_requests BEGIN SELECT RAISE(ABORT,'eodhd request immutable'); END;
CREATE TRIGGER investor_eodhd_capture_update BEFORE UPDATE ON investor_eodhd_captures BEGIN SELECT RAISE(ABORT,'eodhd capture immutable'); END;
CREATE TRIGGER investor_eodhd_capture_delete BEFORE DELETE ON investor_eodhd_captures BEGIN SELECT RAISE(ABORT,'eodhd capture immutable'); END;
CREATE TRIGGER investor_eodhd_payload_update BEFORE UPDATE ON investor_eodhd_payloads BEGIN SELECT RAISE(ABORT,'eodhd payload immutable'); END;
CREATE TRIGGER investor_eodhd_purge_update BEFORE UPDATE ON investor_eodhd_purges BEGIN SELECT RAISE(ABORT,'eodhd purge immutable'); END;
CREATE TRIGGER investor_eodhd_purge_delete BEFORE DELETE ON investor_eodhd_purges BEGIN SELECT RAISE(ABORT,'eodhd purge immutable'); END;

CREATE TRIGGER investor_eodhd_job_insert BEFORE INSERT ON job_runs
WHEN NEW.job_type='investor_eodhd_capture' OR EXISTS(SELECT 1 FROM investor_eodhd_requests WHERE id=NEW.period)
  OR EXISTS(SELECT 1 FROM job_runs WHERE id=NEW.id AND job_type='investor_eodhd_capture') BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM job_runs WHERE id=NEW.id OR
    (job_type=NEW.job_type AND scope=NEW.scope AND period=NEW.period AND input_version=NEW.input_version))
    THEN RAISE(ABORT,'eodhd jobs cannot be replaced') END;
  SELECT CASE WHEN NEW.job_type IS NOT 'investor_eodhd_capture' OR NEW.command_request_id IS NOT NULL
    OR NEW.max_attempts IS NOT 1 OR NEW.attempt_count IS NOT 0 OR NEW.fencing_token IS NOT 0 OR NEW.status IS NOT 'queued'
    OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.heartbeat_at IS NOT NULL OR NEW.result_json IS NOT NULL
    OR NEW.updated_at IS NOT NEW.created_at
    OR NOT EXISTS(SELECT 1 FROM investor_eodhd_requests r WHERE r.id=NEW.period AND r.workspace_id=NEW.scope
      AND r.content_hash=NEW.input_version AND julianday(r.created_at)<=julianday(NEW.created_at) AND julianday(NEW.created_at)<julianday(r.valid_until))
    THEN RAISE(ABORT,'eodhd job requires a new single-attempt scoped request') END;
END;
CREATE TRIGGER investor_eodhd_job_update BEFORE UPDATE ON job_runs
WHEN OLD.job_type='investor_eodhd_capture' OR NEW.job_type='investor_eodhd_capture'
  OR EXISTS(SELECT 1 FROM investor_eodhd_requests WHERE id IN (OLD.period,NEW.period))
  OR EXISTS(SELECT 1 FROM job_runs WHERE id=NEW.id AND job_type='investor_eodhd_capture') BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.command_request_id IS NOT OLD.command_request_id OR NEW.job_type IS NOT OLD.job_type
    OR NEW.scope IS NOT OLD.scope OR NEW.period IS NOT OLD.period OR NEW.input_version IS NOT OLD.input_version
    OR NEW.max_attempts IS NOT OLD.max_attempts OR NEW.created_at IS NOT OLD.created_at
    OR OLD.status NOT IN ('queued','running') OR NEW.updated_at<OLD.updated_at
    THEN RAISE(ABORT,'eodhd job identity or terminal result is immutable') END;
  SELECT CASE WHEN NOT (
    (OLD.status='queued' AND OLD.attempt_count=0 AND OLD.fencing_token=0 AND
      ((NEW.status='running' AND NEW.attempt_count=1 AND NEW.fencing_token=1 AND NEW.lease_owner IS NOT NULL
        AND length(trim(NEW.lease_owner))>0 AND NEW.lease_until>NEW.updated_at AND NEW.heartbeat_at=NEW.updated_at AND NEW.result_json IS NULL)
       OR (NEW.status='cancelled' AND NEW.attempt_count=0 AND NEW.fencing_token=0 AND NEW.lease_owner IS NULL AND NEW.lease_until IS NULL)))
    OR (OLD.status='running' AND OLD.attempt_count=1 AND NEW.attempt_count=1 AND
      ((NEW.status='running' AND NEW.fencing_token=OLD.fencing_token AND NEW.lease_owner=OLD.lease_owner
        AND NEW.lease_until>NEW.updated_at AND NEW.result_json IS OLD.result_json)
       OR (NEW.status IN ('succeeded','failed','skipped','cancelled') AND NEW.lease_owner IS NULL AND NEW.lease_until IS NULL
        AND EXISTS(SELECT 1 FROM job_attempts a WHERE a.job_id=OLD.id AND a.attempt=1 AND a.finished_at=NEW.updated_at
          AND a.fencing_token=OLD.fencing_token AND (
            (a.status=NEW.status AND NEW.fencing_token=OLD.fencing_token AND NEW.updated_at<OLD.lease_until)
            OR (a.status='lease_expired' AND NEW.status='failed' AND NEW.fencing_token=OLD.fencing_token+1
              AND OLD.lease_until<=NEW.updated_at AND json_extract(NEW.result_json,'$.code') IS 'LEASE_EXPIRED')))))) )
    THEN RAISE(ABORT,'eodhd jobs cannot reset or retry') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_eodhd_captures WHERE job_id=OLD.id) AND NOT EXISTS(
    SELECT 1 FROM investor_eodhd_captures c WHERE c.job_id=OLD.id AND c.fencing_token=NEW.fencing_token
      AND NEW.status=CASE c.status WHEN 'captured' THEN 'succeeded' WHEN 'transport_failed' THEN 'failed' ELSE 'skipped' END
      AND julianday(c.created_at)<=julianday(NEW.updated_at) AND json_valid(NEW.result_json) AND json_type(NEW.result_json)='object'
      AND (SELECT count(*) FROM json_each(NEW.result_json))=3
      AND json_extract(NEW.result_json,'$.capture_id') IS c.id
      AND json_extract(NEW.result_json,'$.code') IS json_extract(c.document_json,'$.reason_code')
      AND json_type(NEW.result_json,'$.research_admitted') IS 'false')
    THEN RAISE(ABORT,'eodhd terminal job requires its exact capture receipt') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM investor_eodhd_captures WHERE job_id=OLD.id)
    AND (NEW.status IN ('succeeded','skipped') OR json_type(NEW.result_json,'$.capture_id') IS NOT NULL)
    THEN RAISE(ABORT,'eodhd uncaptured job cannot claim completion') END;
END;
CREATE TRIGGER investor_eodhd_job_delete BEFORE DELETE ON job_runs WHEN OLD.job_type='investor_eodhd_capture'
  BEGIN SELECT RAISE(ABORT,'eodhd jobs cannot be deleted'); END;
CREATE TRIGGER investor_eodhd_attempt_insert BEFORE INSERT ON job_attempts
WHEN EXISTS(SELECT 1 FROM job_runs WHERE id=NEW.job_id AND job_type='investor_eodhd_capture')
  OR EXISTS(SELECT 1 FROM job_attempts a JOIN job_runs j ON j.id=a.job_id WHERE a.id=NEW.id AND j.job_type='investor_eodhd_capture') BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM job_attempts WHERE id=NEW.id OR (job_id=NEW.job_id AND attempt=NEW.attempt))
    OR NEW.attempt IS NOT 1 OR NEW.status IS NOT 'running' OR NEW.finished_at IS NOT NULL OR NEW.error_json IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM job_runs j WHERE j.id=NEW.job_id AND j.job_type='investor_eodhd_capture' AND j.status='running'
      AND j.attempt_count=1 AND j.max_attempts=1 AND j.fencing_token=NEW.fencing_token AND j.updated_at=NEW.started_at AND j.lease_until>NEW.started_at)
    THEN RAISE(ABORT,'eodhd attempt requires the first current running job') END;
END;
CREATE TRIGGER investor_eodhd_attempt_update BEFORE UPDATE ON job_attempts
WHEN EXISTS(SELECT 1 FROM job_runs WHERE id IN (OLD.job_id,NEW.job_id) AND job_type='investor_eodhd_capture')
  OR EXISTS(SELECT 1 FROM job_attempts a JOIN job_runs j ON j.id=a.job_id WHERE a.id=NEW.id AND j.job_type='investor_eodhd_capture') BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.job_id IS NOT OLD.job_id OR NEW.attempt IS NOT OLD.attempt
    OR NEW.fencing_token IS NOT OLD.fencing_token OR NEW.started_at IS NOT OLD.started_at OR OLD.status IS NOT 'running'
    OR NEW.status NOT IN ('succeeded','failed','skipped','cancelled','lease_expired') OR NEW.finished_at IS NULL OR NEW.finished_at<OLD.started_at
    OR NOT EXISTS(SELECT 1 FROM job_runs j WHERE j.id=OLD.job_id AND j.status='running' AND j.attempt_count=1
      AND j.fencing_token=OLD.fencing_token AND ((NEW.status='lease_expired' AND NEW.finished_at>=j.lease_until)
        OR (NEW.status!='lease_expired' AND NEW.finished_at<j.lease_until)))
    THEN RAISE(ABORT,'eodhd attempt identity or terminal result is immutable') END;
  SELECT CASE WHEN (NEW.status IN ('succeeded','skipped') OR EXISTS(SELECT 1 FROM investor_eodhd_captures WHERE job_id=OLD.job_id))
    AND NOT EXISTS(SELECT 1 FROM investor_eodhd_captures c WHERE c.job_id=OLD.job_id AND c.fencing_token=OLD.fencing_token
      AND NEW.status=CASE c.status WHEN 'captured' THEN 'succeeded' WHEN 'transport_failed' THEN 'failed' ELSE 'skipped' END
      AND julianday(c.created_at)<=julianday(NEW.finished_at) AND NEW.error_json IS NULL)
    THEN RAISE(ABORT,'eodhd terminal attempt requires matching capture') END;
END;
CREATE TRIGGER investor_eodhd_attempt_delete BEFORE DELETE ON job_attempts
WHEN EXISTS(SELECT 1 FROM job_runs WHERE id=OLD.job_id AND job_type='investor_eodhd_capture')
  BEGIN SELECT RAISE(ABORT,'eodhd attempts cannot be deleted'); END;
