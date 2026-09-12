CREATE TABLE evaluation_schedules (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id)) BETWEEN 1 AND 200),
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  environment TEXT NOT NULL CHECK(environment='actual'),
  strategy_key TEXT NOT NULL CHECK(length(trim(strategy_key)) BETWEEN 1 AND 200),
  scope_key TEXT NOT NULL CHECK(scope_key='portfolio'),
  created_by TEXT NOT NULL CHECK(length(trim(created_by)) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL AND substr(created_at,-1)='Z'),
  UNIQUE(portfolio_id,environment,strategy_key,scope_key)
);

CREATE TABLE evaluation_schedule_versions (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id)) BETWEEN 1 AND 200),
  schedule_id TEXT NOT NULL REFERENCES evaluation_schedules(id),
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  policy_version_id TEXT NOT NULL REFERENCES policy_versions(id),
  strategy_version_id TEXT NOT NULL REFERENCES strategy_versions(id),
  definition_json TEXT NOT NULL CHECK(typeof(definition_json)='text' AND json_valid(definition_json) AND json_type(definition_json)='object'),
  content_hash TEXT NOT NULL CHECK(typeof(content_hash)='text' AND length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  created_by TEXT NOT NULL CHECK(length(trim(created_by)) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL AND substr(created_at,-1)='Z'),
  UNIQUE(schedule_id,version),
  UNIQUE(id,schedule_id)
);

CREATE TABLE evaluation_schedule_heads (
  schedule_id TEXT PRIMARY KEY NOT NULL REFERENCES evaluation_schedules(id),
  current_version_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL CHECK(status IN ('enabled','paused')),
  last_audit_id TEXT NOT NULL REFERENCES audit_events(id),
  updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL AND substr(updated_at,-1)='Z'),
  FOREIGN KEY(current_version_id,schedule_id) REFERENCES evaluation_schedule_versions(id,schedule_id)
);
CREATE INDEX evaluation_schedule_due ON evaluation_schedule_heads(status,schedule_id);

-- Nullable additions preserve pre-v15 rows without inventing an authorization.
ALTER TABLE evaluation_cycles ADD COLUMN schedule_version_id TEXT REFERENCES evaluation_schedule_versions(id);
ALTER TABLE evaluation_cycles ADD COLUMN environment TEXT;
ALTER TABLE evaluation_cycles ADD COLUMN strategy_key TEXT;
ALTER TABLE evaluation_cycles ADD COLUMN scope_key TEXT;
ALTER TABLE evaluation_cycles ADD COLUMN scheduled_at TEXT;
ALTER TABLE evaluation_cycles ADD COLUMN cutoff_at TEXT;
ALTER TABLE evaluation_cycles ADD COLUMN knowledge_at TEXT;
ALTER TABLE evaluation_cycles ADD COLUMN deadline_at TEXT;
ALTER TABLE evaluation_cycles ADD COLUMN created_at TEXT;
ALTER TABLE evaluation_cycles ADD COLUMN state_revision INTEGER;
ALTER TABLE evaluation_cycles ADD COLUMN terminal_attempt_id TEXT REFERENCES evaluation_attempts(id);
CREATE UNIQUE INDEX evaluation_month_slot ON evaluation_cycles(portfolio_id,environment,strategy_key,scope_key,period)
  WHERE schedule_version_id IS NOT NULL;
CREATE INDEX evaluation_cycle_history ON evaluation_cycles(portfolio_id,period DESC,id);

CREATE TABLE evaluation_cycle_requests (
  command_request_id TEXT PRIMARY KEY NOT NULL REFERENCES command_requests(id),
  cycle_id TEXT NOT NULL REFERENCES evaluation_cycles(id),
  generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),
  requested_by TEXT NOT NULL CHECK(length(trim(requested_by)) BETWEEN 1 AND 200),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL AND substr(created_at,-1)='Z'),
  UNIQUE(cycle_id,generation)
);

ALTER TABLE evaluation_attempts ADD COLUMN job_attempt_id TEXT REFERENCES job_attempts(id);
ALTER TABLE evaluation_attempts ADD COLUMN input_hash TEXT;
ALTER TABLE evaluation_attempts ADD COLUMN result_hash TEXT;
ALTER TABLE evaluation_attempts ADD COLUMN completed_at TEXT;
CREATE UNIQUE INDEX evaluation_attempt_job ON evaluation_attempts(job_attempt_id) WHERE job_attempt_id IS NOT NULL;

CREATE TRIGGER evaluation_schedule_insert BEFORE INSERT ON evaluation_schedules BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM evaluation_schedules WHERE id=NEW.id
    OR (portfolio_id=NEW.portfolio_id AND environment=NEW.environment AND strategy_key=NEW.strategy_key AND scope_key=NEW.scope_key))
    THEN RAISE(ABORT,'evaluation schedule identity is immutable') END;
END;
CREATE TRIGGER evaluation_schedule_no_update BEFORE UPDATE ON evaluation_schedules BEGIN SELECT RAISE(ABORT,'evaluation schedule identity is immutable'); END;
CREATE TRIGGER evaluation_schedule_no_delete BEFORE DELETE ON evaluation_schedules BEGIN SELECT RAISE(ABORT,'evaluation schedule identity is immutable'); END;

CREATE TRIGGER evaluation_schedule_version_insert BEFORE INSERT ON evaluation_schedule_versions BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM evaluation_schedule_versions WHERE id=NEW.id OR (schedule_id=NEW.schedule_id AND version=NEW.version))
    THEN RAISE(ABORT,'evaluation schedule versions are append-only') END;
  SELECT CASE WHEN NEW.version != (SELECT COALESCE(MAX(version),0)+1 FROM evaluation_schedule_versions WHERE schedule_id=NEW.schedule_id)
    THEN RAISE(ABORT,'evaluation schedule version must advance once') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM evaluation_schedules s JOIN policy_versions p ON p.id=NEW.policy_version_id
    JOIN strategy_versions v ON v.id=NEW.strategy_version_id WHERE s.id=NEW.schedule_id
    AND p.portfolio_id=s.portfolio_id AND v.portfolio_id=s.portfolio_id AND v.strategy_key=s.strategy_key)
    THEN RAISE(ABORT,'evaluation schedule version scope mismatch') END;
  SELECT CASE WHEN json_valid(NEW.definition_json) IS NOT 1 OR json_type(NEW.definition_json) IS NOT 'object'
    OR json_extract(NEW.definition_json,'$.schema_version') IS NOT 'evaluation-schedule-v1'
    OR json_extract(NEW.definition_json,'$.environment') IS NOT 'actual'
    OR json_extract(NEW.definition_json,'$.frequency') IS NOT 'monthly'
    OR json_extract(NEW.definition_json,'$.policy_version_id') IS NOT NEW.policy_version_id
    OR json_extract(NEW.definition_json,'$.strategy_version_id') IS NOT NEW.strategy_version_id
    THEN RAISE(ABORT,'evaluation schedule definition mismatch') END;
END;
CREATE TRIGGER evaluation_schedule_version_no_update BEFORE UPDATE ON evaluation_schedule_versions BEGIN SELECT RAISE(ABORT,'evaluation schedule versions are append-only'); END;
CREATE TRIGGER evaluation_schedule_version_no_delete BEFORE DELETE ON evaluation_schedule_versions BEGIN SELECT RAISE(ABORT,'evaluation schedule versions are append-only'); END;

CREATE TRIGGER evaluation_schedule_head_insert BEFORE INSERT ON evaluation_schedule_heads BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM evaluation_schedule_heads WHERE schedule_id=NEW.schedule_id)
    THEN RAISE(ABORT,'evaluation schedule head cannot be replaced') END;
  SELECT CASE WHEN NEW.revision IS NOT 1 OR NEW.status IS NOT 'paused'
    THEN RAISE(ABORT,'evaluation schedule must start paused at revision one') END;
  SELECT CASE WHEN (SELECT version FROM evaluation_schedule_versions WHERE id=NEW.current_version_id) IS NOT 1
    THEN RAISE(ABORT,'evaluation schedule must start at version one') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM evaluation_schedules s JOIN audit_events a ON a.id=NEW.last_audit_id
    WHERE s.id=NEW.schedule_id AND a.portfolio_id=s.portfolio_id AND a.object_id=s.id)
    THEN RAISE(ABORT,'evaluation schedule audit scope mismatch') END;
END;
CREATE TRIGGER evaluation_schedule_head_update BEFORE UPDATE ON evaluation_schedule_heads BEGIN
  SELECT CASE WHEN NEW.schedule_id IS NOT OLD.schedule_id OR NEW.revision IS NOT OLD.revision+1 OR NEW.last_audit_id IS OLD.last_audit_id
    THEN RAISE(ABORT,'evaluation schedule head CAS mismatch') END;
  SELECT CASE WHEN NEW.current_version_id IS NOT OLD.current_version_id AND (NEW.status IS NOT 'paused'
    OR (SELECT version FROM evaluation_schedule_versions WHERE id=NEW.current_version_id) IS NOT (SELECT version+1 FROM evaluation_schedule_versions WHERE id=OLD.current_version_id))
    THEN RAISE(ABORT,'evaluation schedule version changes require pause') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM evaluation_schedules s JOIN audit_events a ON a.id=NEW.last_audit_id
    WHERE s.id=NEW.schedule_id AND a.portfolio_id=s.portfolio_id AND a.object_id=s.id)
    THEN RAISE(ABORT,'evaluation schedule audit scope mismatch') END;
END;
CREATE TRIGGER evaluation_schedule_head_no_delete BEFORE DELETE ON evaluation_schedule_heads BEGIN SELECT RAISE(ABORT,'evaluation schedule heads cannot be deleted'); END;

CREATE TRIGGER evaluation_cycle_insert BEFORE INSERT ON evaluation_cycles BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM evaluation_cycles WHERE id=NEW.id
    OR (strategy_version_id=NEW.strategy_version_id AND policy_version_id=NEW.policy_version_id AND scope=NEW.scope AND period=NEW.period)
    OR (portfolio_id=NEW.portfolio_id AND environment=NEW.environment AND strategy_key=NEW.strategy_key AND scope_key=NEW.scope_key AND period=NEW.period))
    THEN RAISE(ABORT,'evaluation monthly slot already exists') END;
  SELECT CASE WHEN NEW.id IS NULL OR length(trim(NEW.id)) NOT BETWEEN 1 AND 200 OR NEW.schedule_version_id IS NULL OR NEW.environment IS NOT 'actual' OR NEW.scope_key IS NOT 'portfolio'
    OR NEW.scope IS NOT 'actual:portfolio' OR NEW.strategy_key IS NULL OR NEW.status IS NOT 'pending' OR NEW.state_revision IS NOT 1
    OR NEW.outcome IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.terminal_attempt_id IS NOT NULL
    OR length(NEW.period) IS NOT 7 OR NEW.period NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
    OR substr(NEW.period,1,4)='0000' OR substr(NEW.period,6,2) NOT BETWEEN '01' AND '12'
    THEN RAISE(ABORT,'invalid evaluation cycle identity') END;
  SELECT CASE WHEN julianday(NEW.scheduled_at) IS NULL OR substr(NEW.scheduled_at,-1) IS NOT 'Z'
    OR julianday(NEW.cutoff_at) IS NULL OR substr(NEW.cutoff_at,-1) IS NOT 'Z'
    OR julianday(NEW.knowledge_at) IS NULL OR substr(NEW.knowledge_at,-1) IS NOT 'Z'
    OR julianday(NEW.deadline_at) IS NULL OR substr(NEW.deadline_at,-1) IS NOT 'Z'
    OR julianday(NEW.created_at) IS NULL OR substr(NEW.created_at,-1) IS NOT 'Z'
    OR julianday(NEW.scheduled_at) != julianday(NEW.cutoff_at) OR julianday(NEW.scheduled_at) != julianday(NEW.knowledge_at)
    OR julianday(NEW.deadline_at) <= julianday(NEW.scheduled_at) OR julianday(NEW.deadline_at)-julianday(NEW.scheduled_at)>7
    OR julianday(NEW.created_at) < julianday(NEW.scheduled_at)
    THEN RAISE(ABORT,'invalid evaluation cycle time') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM evaluation_schedule_versions v JOIN evaluation_schedules s ON s.id=v.schedule_id
    JOIN evaluation_schedule_heads h ON h.schedule_id=s.id WHERE v.id=NEW.schedule_version_id AND h.current_version_id=v.id AND h.status='enabled'
    AND s.portfolio_id=NEW.portfolio_id AND s.environment=NEW.environment AND s.strategy_key=NEW.strategy_key AND s.scope_key=NEW.scope_key
    AND v.strategy_version_id=NEW.strategy_version_id AND v.policy_version_id=NEW.policy_version_id)
    THEN RAISE(ABORT,'evaluation cycle schedule scope mismatch') END;
END;
CREATE TRIGGER evaluation_cycle_no_delete BEFORE DELETE ON evaluation_cycles BEGIN SELECT RAISE(ABORT,'evaluation cycles cannot be deleted'); END;
CREATE TRIGGER evaluation_cycle_update BEFORE UPDATE ON evaluation_cycles BEGIN
  SELECT CASE WHEN OLD.schedule_version_id IS NULL OR OLD.status='completed'
    THEN RAISE(ABORT,'historical or completed evaluation cycles are immutable') END;
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.portfolio_id IS NOT OLD.portfolio_id OR NEW.strategy_version_id IS NOT OLD.strategy_version_id
    OR NEW.policy_version_id IS NOT OLD.policy_version_id OR NEW.scope IS NOT OLD.scope OR NEW.period IS NOT OLD.period
    OR NEW.schedule_version_id IS NOT OLD.schedule_version_id OR NEW.environment IS NOT OLD.environment OR NEW.strategy_key IS NOT OLD.strategy_key
    OR NEW.scope_key IS NOT OLD.scope_key OR NEW.scheduled_at IS NOT OLD.scheduled_at OR NEW.cutoff_at IS NOT OLD.cutoff_at
    OR NEW.knowledge_at IS NOT OLD.knowledge_at OR NEW.deadline_at IS NOT OLD.deadline_at OR NEW.created_at IS NOT OLD.created_at
    OR typeof(NEW.state_revision)!='integer' OR NEW.state_revision IS NOT OLD.state_revision+1 OR NEW.state_revision>9007199254740991
    THEN RAISE(ABORT,'evaluation cycle identity or CAS mismatch') END;
  SELECT CASE WHEN NOT ((OLD.status='pending' AND NEW.status IN ('running','blocked','failed'))
    OR (OLD.status='running' AND NEW.status IN ('running','completed','blocked','failed'))
    OR (OLD.status IN ('blocked','failed') AND NEW.status='pending'))
    THEN RAISE(ABORT,'invalid evaluation cycle transition') END;
  SELECT CASE WHEN NEW.status IN ('pending','running') AND (NEW.outcome IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.terminal_attempt_id IS NOT NULL)
    THEN RAISE(ABORT,'nonterminal evaluation must clear result') END;
  SELECT CASE WHEN NEW.status='running' AND NOT EXISTS(SELECT 1 FROM evaluation_cycle_requests r
    JOIN job_runs j ON j.command_request_id=r.command_request_id JOIN job_attempts a ON a.job_id=j.id
    WHERE r.cycle_id=NEW.id AND r.generation=(SELECT MAX(generation) FROM evaluation_cycle_requests WHERE cycle_id=NEW.id)
    AND j.job_type='monthly_evaluation' AND j.scope=NEW.portfolio_id AND j.period=NEW.period AND j.status='running' AND j.lease_owner IS NOT NULL AND j.lease_until IS NOT NULL
    AND a.status='running' AND a.fencing_token=j.fencing_token AND a.attempt=j.attempt_count
    AND NOT EXISTS(SELECT 1 FROM evaluation_attempts e WHERE e.job_attempt_id=a.id))
    THEN RAISE(ABORT,'evaluation running requires current job attempt') END;
  SELECT CASE WHEN NEW.status IN ('completed','blocked','failed') AND (julianday(NEW.completed_at) IS NULL OR substr(NEW.completed_at,-1) IS NOT 'Z'
    OR (NEW.status='completed' AND NEW.outcome NOT IN ('unchanged','proposed'))
    OR (NEW.status='completed' AND NEW.outcome IS NULL) OR (NEW.status='blocked' AND NEW.outcome IS NOT 'blocked')
    OR (NEW.status='failed' AND NEW.outcome IS NOT NULL)
    OR NOT (EXISTS(SELECT 1 FROM evaluation_attempts a JOIN job_attempts ja ON ja.id=a.job_attempt_id
      JOIN job_runs j ON j.id=ja.job_id JOIN evaluation_cycle_requests r ON r.command_request_id=j.command_request_id
      WHERE a.id=NEW.terminal_attempt_id AND a.cycle_id=NEW.id
      AND a.status=CASE NEW.status WHEN 'completed' THEN 'succeeded' ELSE NEW.status END
      AND a.completed_at=NEW.completed_at AND r.cycle_id=NEW.id
      AND r.generation=(SELECT MAX(generation) FROM evaluation_cycle_requests WHERE cycle_id=NEW.id)
      AND a.attempt=(SELECT MAX(attempt) FROM evaluation_attempts WHERE cycle_id=NEW.id))
      OR (NEW.status='failed' AND NEW.terminal_attempt_id IS NULL AND EXISTS(SELECT 1 FROM evaluation_cycle_requests r
        JOIN job_runs j ON j.command_request_id=r.command_request_id JOIN job_attempts a ON a.job_id=j.id
        WHERE r.cycle_id=NEW.id AND r.generation=(SELECT MAX(generation) FROM evaluation_cycle_requests WHERE cycle_id=NEW.id)
        AND j.job_type='monthly_evaluation' AND j.scope=NEW.portfolio_id AND j.period=NEW.period AND j.status='failed'
        AND a.attempt=j.attempt_count AND a.status IN ('failed','lease_expired')
        AND j.updated_at=NEW.completed_at AND a.finished_at=NEW.completed_at))))
    THEN RAISE(ABORT,'evaluation terminal result requires matching attempt') END;
END;

CREATE TRIGGER evaluation_cycle_request_insert BEFORE INSERT ON evaluation_cycle_requests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM evaluation_cycle_requests WHERE command_request_id=NEW.command_request_id OR (cycle_id=NEW.cycle_id AND generation=NEW.generation))
    THEN RAISE(ABORT,'evaluation cycle requests are append-only') END;
  SELECT CASE WHEN NEW.generation != (SELECT COALESCE(MAX(generation),0)+1 FROM evaluation_cycle_requests WHERE cycle_id=NEW.cycle_id)
    THEN RAISE(ABORT,'evaluation request generation must advance once') END;
  SELECT CASE WHEN NEW.generation>1 AND NOT EXISTS(SELECT 1 FROM evaluation_cycle_requests r
    JOIN job_runs j ON j.command_request_id=r.command_request_id
    WHERE r.cycle_id=NEW.cycle_id AND r.generation=NEW.generation-1 AND j.status IN ('succeeded','failed','skipped','partial','cancelled'))
    THEN RAISE(ABORT,'evaluation prior request is not terminal') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM evaluation_cycles c JOIN command_requests r ON r.id=NEW.command_request_id
    WHERE c.id=NEW.cycle_id AND c.schedule_version_id IS NOT NULL AND c.status='pending'
    AND r.portfolio_id=c.portfolio_id AND r.command_type='monthly_evaluation' AND r.actor_id=NEW.requested_by
    AND json_valid(r.payload_json) AND json_type(r.payload_json)='object' AND json_extract(r.payload_json,'$.cycle_id')=c.id
    AND (SELECT COUNT(*) FROM json_each(r.payload_json))=1)
    THEN RAISE(ABORT,'evaluation request scope mismatch') END;
END;
CREATE TRIGGER evaluation_cycle_request_no_update BEFORE UPDATE ON evaluation_cycle_requests BEGIN SELECT RAISE(ABORT,'evaluation cycle requests are append-only'); END;
CREATE TRIGGER evaluation_cycle_request_no_delete BEFORE DELETE ON evaluation_cycle_requests BEGIN SELECT RAISE(ABORT,'evaluation cycle requests are append-only'); END;

CREATE TRIGGER evaluation_attempt_insert BEFORE INSERT ON evaluation_attempts BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM evaluation_attempts WHERE id=NEW.id OR (cycle_id=NEW.cycle_id AND attempt=NEW.attempt) OR job_attempt_id=NEW.job_attempt_id)
    THEN RAISE(ABORT,'evaluation attempts are append-only') END;
  SELECT CASE WHEN NEW.id IS NULL OR length(trim(NEW.id)) NOT BETWEEN 1 AND 200 OR NEW.job_attempt_id IS NULL OR typeof(NEW.attempt)!='integer' OR NEW.attempt NOT BETWEEN 1 AND 9007199254740991
    OR NEW.attempt != (SELECT COALESCE(MAX(attempt),0)+1 FROM evaluation_attempts WHERE cycle_id=NEW.cycle_id)
    OR typeof(NEW.input_manifest)!='text' OR json_valid(NEW.input_manifest) IS NOT 1 OR json_type(NEW.input_manifest) IS NOT 'object'
    OR typeof(NEW.result_json)!='text' OR json_valid(NEW.result_json) IS NOT 1 OR json_type(NEW.result_json) IS NOT 'object'
    OR NEW.input_hash IS NULL OR typeof(NEW.input_hash)!='text' OR length(NEW.input_hash)!=64 OR NEW.input_hash GLOB '*[^a-f0-9]*'
    OR NEW.result_hash IS NULL OR typeof(NEW.result_hash)!='text' OR length(NEW.result_hash)!=64 OR NEW.result_hash GLOB '*[^a-f0-9]*'
    OR julianday(NEW.created_at) IS NULL OR substr(NEW.created_at,-1) IS NOT 'Z'
    OR julianday(NEW.completed_at) IS NULL OR substr(NEW.completed_at,-1) IS NOT 'Z' OR julianday(NEW.completed_at)<julianday(NEW.created_at)
    THEN RAISE(ABORT,'invalid evaluation attempt evidence') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM evaluation_cycles c JOIN evaluation_cycle_requests r ON r.cycle_id=c.id
    JOIN job_runs j ON j.command_request_id=r.command_request_id JOIN job_attempts a ON a.job_id=j.id
    WHERE c.id=NEW.cycle_id AND c.schedule_version_id IS NOT NULL AND c.status IN ('pending','running')
    AND r.generation=(SELECT MAX(generation) FROM evaluation_cycle_requests WHERE cycle_id=c.id)
    AND j.job_type='monthly_evaluation' AND j.scope=c.portfolio_id AND j.period=c.period AND j.status='running'
    AND j.lease_owner IS NOT NULL AND j.lease_until IS NOT NULL AND a.id=NEW.job_attempt_id AND a.status='running'
    AND a.fencing_token=j.fencing_token AND a.attempt=j.attempt_count)
    THEN RAISE(ABORT,'evaluation attempt job scope mismatch') END;
END;
CREATE TRIGGER evaluation_attempt_no_update BEFORE UPDATE ON evaluation_attempts BEGIN SELECT RAISE(ABORT,'evaluation attempts are append-only'); END;
CREATE TRIGGER evaluation_attempt_no_delete BEFORE DELETE ON evaluation_attempts BEGIN SELECT RAISE(ABORT,'evaluation attempts are append-only'); END;
