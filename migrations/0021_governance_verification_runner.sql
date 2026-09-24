CREATE TABLE verification_requests (
  id TEXT PRIMARY KEY NOT NULL REFERENCES command_requests(id),
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  check_id TEXT NOT NULL CHECK(check_id='E-02.cash-contribution-neutrality.v1'),
  context_json TEXT NOT NULL CHECK(typeof(context_json)='text' AND json_valid(context_json) AND json_type(context_json)='object'
    AND length(CAST(context_json AS BLOB)) BETWEEN 1 AND 1048576),
  context_hash TEXT NOT NULL CHECK(typeof(context_hash)='text' AND length(context_hash)=64 AND context_hash NOT GLOB '*[^a-f0-9]*'),
  requested_by TEXT NOT NULL CHECK(typeof(requested_by)='text' AND length(requested_by) BETWEEN 1 AND 160
    AND substr(requested_by,1,1) GLOB '[A-Za-z0-9]' AND requested_by NOT GLOB '*[^A-Za-z0-9_.:-]*'
    AND lower(requested_by)!='system' AND lower(substr(requested_by,1,7))!='system:'),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  requested_at TEXT NOT NULL
);
CREATE INDEX verification_request_portfolio ON verification_requests(portfolio_id,requested_at,id);

CREATE TABLE verification_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL REFERENCES verification_requests(id),
  job_id TEXT NOT NULL REFERENCES job_runs(id),
  attempt INTEGER NOT NULL CHECK(typeof(attempt)='integer' AND attempt BETWEEN 1 AND 9007199254740991),
  fencing_token INTEGER NOT NULL CHECK(typeof(fencing_token)='integer' AND fencing_token BETWEEN 1 AND 9007199254740991),
  kind TEXT NOT NULL CHECK(kind='execution'),
  body BLOB NOT NULL CHECK(typeof(body)='blob' AND length(body) BETWEEN 1 AND 1048576),
  body_sha256 TEXT NOT NULL CHECK(typeof(body_sha256)='text' AND length(body_sha256)=64 AND body_sha256 NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  UNIQUE(request_id,job_id,attempt,kind)
);

CREATE TABLE verification_executions (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL REFERENCES verification_requests(id),
  job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES job_attempts(id),
  attempt INTEGER NOT NULL CHECK(typeof(attempt)='integer' AND attempt BETWEEN 1 AND 9007199254740991),
  fencing_token INTEGER NOT NULL CHECK(typeof(fencing_token)='integer' AND fencing_token BETWEEN 1 AND 9007199254740991),
  context_hash TEXT NOT NULL CHECK(typeof(context_hash)='text' AND length(context_hash)=64 AND context_hash NOT GLOB '*[^a-f0-9]*'),
  artifact_id TEXT NOT NULL UNIQUE REFERENCES verification_artifacts(id),
  artifact_sha256 TEXT NOT NULL CHECK(typeof(artifact_sha256)='text' AND length(artifact_sha256)=64 AND artifact_sha256 NOT GLOB '*[^a-f0-9]*'),
  result_json TEXT NOT NULL CHECK(typeof(result_json)='text' AND json_valid(result_json) AND json_type(result_json)='object'
    AND length(CAST(result_json AS BLOB)) BETWEEN 1 AND 131072),
  result_hash TEXT NOT NULL CHECK(typeof(result_hash)='text' AND length(result_hash)=64 AND result_hash NOT GLOB '*[^a-f0-9]*'),
  status TEXT NOT NULL CHECK(status IN ('pass','fail','blocked')),
  execution_authority TEXT NOT NULL CHECK(execution_authority='controlled_runner'),
  data_provenance TEXT NOT NULL CHECK(data_provenance='synthetic'),
  acceptance_scope TEXT NOT NULL CHECK(acceptance_scope='engineering_subcheck'),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL CHECK(finished_at>=started_at),
  recorded_at TEXT NOT NULL CHECK(recorded_at>=finished_at)
);

CREATE TRIGGER verification_request_insert BEFORE INSERT ON verification_requests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM verification_requests WHERE id=NEW.id OR audit_id=NEW.audit_id)
    THEN RAISE(ABORT,'verification requests cannot be replaced') END;
  SELECT CASE WHEN typeof(NEW.id)!='text' OR length(NEW.id) NOT BETWEEN 1 AND 160
    OR substr(NEW.id,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.id GLOB '*[^A-Za-z0-9_.:-]*'
    OR length(NEW.requested_at)!=27 OR substr(NEW.requested_at,20,1)!='.' OR substr(NEW.requested_at,27,1)!='Z'
    OR substr(NEW.requested_at,21,6) GLOB '*[^0-9]*' OR substr(NEW.requested_at,1,4)='0000'
    OR substr(NEW.requested_at,12,2) NOT BETWEEN '00' AND '23'
    OR strftime('%Y-%m-%dT%H:%M:%S',substr(NEW.requested_at,1,19)) IS NOT substr(NEW.requested_at,1,19)
    OR date(substr(NEW.requested_at,1,10),'+0 days') IS NOT substr(NEW.requested_at,1,10)
    THEN RAISE(ABORT,'verification request identity or clock invalid') END;
  SELECT CASE WHEN (SELECT count(*) FROM json_each(NEW.context_json))!=6 OR (SELECT count(DISTINCT key) FROM json_each(NEW.context_json))!=6
    OR EXISTS(SELECT 1 FROM json_each(NEW.context_json) WHERE key NOT IN ('schema_version','portfolio_id','check_id','suite_version','source_manifest','source_manifest_hash'))
    OR json_extract(NEW.context_json,'$.schema_version') IS NOT 'verification-context-v2'
    OR json_extract(NEW.context_json,'$.portfolio_id') IS NOT NEW.portfolio_id OR json_extract(NEW.context_json,'$.check_id') IS NOT NEW.check_id
    OR json_extract(NEW.context_json,'$.suite_version') IS NOT 'cash-contribution-neutrality-v1'
    OR json_type(NEW.context_json,'$.source_manifest') IS NOT 'object'
    OR (SELECT count(*) FROM json_each(NEW.context_json,'$.source_manifest'))!=2
    OR (SELECT count(DISTINCT key) FROM json_each(NEW.context_json,'$.source_manifest'))!=2
    OR EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.source_manifest') WHERE key NOT IN ('schema_version','files'))
    OR json_extract(NEW.context_json,'$.source_manifest.schema_version') IS NOT 'verification-source-v2'
    OR json_type(NEW.context_json,'$.source_manifest.files') IS NOT 'object'
    OR (SELECT count(*) FROM json_each(NEW.context_json,'$.source_manifest.files')) NOT BETWEEN 1 AND 10000
    OR (SELECT count(*) FROM json_each(NEW.context_json,'$.source_manifest.files'))!=(SELECT count(DISTINCT key) FROM json_each(NEW.context_json,'$.source_manifest.files'))
    OR EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.source_manifest.files') WHERE type!='text' OR length(value)!=64 OR value GLOB '*[^a-f0-9]*')
    OR json_type(NEW.context_json,'$.source_manifest_hash') IS NOT 'text'
    OR length(json_extract(NEW.context_json,'$.source_manifest_hash'))!=64 OR json_extract(NEW.context_json,'$.source_manifest_hash') GLOB '*[^a-f0-9]*'
    THEN RAISE(ABORT,'verification context binding invalid') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM command_requests c WHERE c.id=NEW.id AND c.portfolio_id=NEW.portfolio_id
    AND c.command_type='governance_verification_v2' AND c.actor_id='system:governance-verifier-v2' AND c.created_at=NEW.requested_at
    AND typeof(c.payload_hash)='text' AND length(c.payload_hash)=64 AND c.payload_hash NOT GLOB '*[^a-f0-9]*'
    AND json_valid(c.payload_json) AND json_type(c.payload_json)='object'
    AND (SELECT count(*) FROM json_each(c.payload_json))=5 AND (SELECT count(DISTINCT key) FROM json_each(c.payload_json))=5
    AND NOT EXISTS(SELECT 1 FROM json_each(c.payload_json) WHERE key NOT IN ('schema_version','verification_request_id','portfolio_id','check_id','context_hash'))
    AND json_extract(c.payload_json,'$.schema_version') IS 'verification-request-v2' AND json_extract(c.payload_json,'$.verification_request_id') IS NEW.id
    AND json_extract(c.payload_json,'$.portfolio_id') IS NEW.portfolio_id AND json_extract(c.payload_json,'$.check_id') IS NEW.check_id
    AND json_extract(c.payload_json,'$.context_hash') IS NEW.context_hash)
    THEN RAISE(ABORT,'verification request requires scoped internal command') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM audit_events a JOIN command_requests c ON c.id=NEW.id WHERE a.id=NEW.audit_id
    AND a.portfolio_id=NEW.portfolio_id AND a.actor_id=NEW.requested_by AND a.action='request_verification'
    AND a.object_type='verification_request' AND a.object_id=NEW.id AND a.created_at=NEW.requested_at AND a.ledger_revision IS NULL
    AND json_valid(a.payload_json) AND json_type(a.payload_json)='object'
    AND (SELECT count(*) FROM json_each(a.payload_json))=3 AND (SELECT count(DISTINCT key) FROM json_each(a.payload_json))=3
    AND NOT EXISTS(SELECT 1 FROM json_each(a.payload_json) WHERE key NOT IN ('actor_kind','input','result'))
    AND json_extract(a.payload_json,'$.actor_kind') IS 'human'
    AND json_type(a.payload_json,'$.input')='object' AND (SELECT count(*) FROM json_each(a.payload_json,'$.input'))=5
    AND (SELECT count(DISTINCT key) FROM json_each(a.payload_json,'$.input'))=5
    AND NOT EXISTS(SELECT 1 FROM json_each(a.payload_json,'$.input') WHERE key NOT IN ('portfolio_id','check_id','expected_context_hash','reason','idempotency_key'))
    AND json_extract(a.payload_json,'$.input.portfolio_id') IS NEW.portfolio_id AND json_extract(a.payload_json,'$.input.check_id') IS NEW.check_id
    AND json_extract(a.payload_json,'$.input.expected_context_hash') IS NEW.context_hash
    AND json_type(a.payload_json,'$.input.reason')='text' AND length(trim(json_extract(a.payload_json,'$.input.reason'))) BETWEEN 1 AND 1000
    AND json_type(a.payload_json,'$.input.idempotency_key')='text' AND length(json_extract(a.payload_json,'$.input.idempotency_key')) BETWEEN 1 AND 160
    AND json_extract(a.payload_json,'$.input.idempotency_key') IS c.idempotency_key
    AND substr(c.idempotency_key,1,1) GLOB '[A-Za-z0-9]' AND c.idempotency_key NOT GLOB '*[^A-Za-z0-9_.:-]*'
    AND json_type(a.payload_json,'$.result')='object' AND (SELECT count(*) FROM json_each(a.payload_json,'$.result'))=4
    AND (SELECT count(DISTINCT key) FROM json_each(a.payload_json,'$.result'))=4
    AND NOT EXISTS(SELECT 1 FROM json_each(a.payload_json,'$.result') WHERE key NOT IN ('request_id','check_id','context_hash','status'))
    AND json_extract(a.payload_json,'$.result.request_id') IS NEW.id AND json_extract(a.payload_json,'$.result.check_id') IS NEW.check_id
    AND json_extract(a.payload_json,'$.result.context_hash') IS NEW.context_hash AND json_extract(a.payload_json,'$.result.status') IS 'queued')
    THEN RAISE(ABORT,'verification request requires matching human audit') END;
END;
CREATE TRIGGER verification_request_no_update BEFORE UPDATE ON verification_requests BEGIN SELECT RAISE(ABORT,'verification requests are append-only'); END;
CREATE TRIGGER verification_request_no_delete BEFORE DELETE ON verification_requests BEGIN SELECT RAISE(ABORT,'verification requests are append-only'); END;

CREATE TRIGGER verification_command_no_replace BEFORE INSERT ON command_requests
WHEN EXISTS(SELECT 1 FROM command_requests c WHERE (c.command_type='governance_verification_v2'
    OR EXISTS(SELECT 1 FROM verification_requests r WHERE r.id=c.id))
  AND (c.id=NEW.id OR (c.portfolio_id=NEW.portfolio_id AND c.command_type=NEW.command_type AND c.idempotency_key=NEW.idempotency_key)))
  BEGIN SELECT RAISE(ABORT,'verification commands cannot be replaced'); END;
CREATE TRIGGER verification_command_no_update BEFORE UPDATE ON command_requests
WHEN OLD.command_type='governance_verification_v2' OR NEW.command_type='governance_verification_v2'
  OR EXISTS(SELECT 1 FROM verification_requests WHERE id=OLD.id OR id=NEW.id)
  BEGIN SELECT RAISE(ABORT,'verification commands are append-only'); END;
CREATE TRIGGER verification_command_no_delete BEFORE DELETE ON command_requests
WHEN OLD.command_type='governance_verification_v2' OR EXISTS(SELECT 1 FROM verification_requests WHERE id=OLD.id)
  BEGIN SELECT RAISE(ABORT,'verification commands are append-only'); END;
CREATE TRIGGER verification_audit_no_replace BEFORE INSERT ON audit_events
WHEN EXISTS(SELECT 1 FROM verification_requests WHERE audit_id=NEW.id)
  BEGIN SELECT RAISE(ABORT,'verification audits cannot be replaced'); END;

CREATE TRIGGER verification_artifact_insert BEFORE INSERT ON verification_artifacts BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM verification_artifacts WHERE id=NEW.id OR (request_id=NEW.request_id AND job_id=NEW.job_id AND attempt=NEW.attempt AND kind=NEW.kind))
    THEN RAISE(ABORT,'verification artifacts cannot be replaced') END;
  SELECT CASE WHEN typeof(NEW.id)!='text' OR length(NEW.id) NOT BETWEEN 1 AND 160
    OR substr(NEW.id,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.id GLOB '*[^A-Za-z0-9_.:-]*'
    OR length(NEW.created_at)!=27 OR substr(NEW.created_at,20,1)!='.' OR substr(NEW.created_at,27,1)!='Z'
    OR substr(NEW.created_at,21,6) GLOB '*[^0-9]*' OR substr(NEW.created_at,1,4)='0000'
    OR substr(NEW.created_at,12,2) NOT BETWEEN '00' AND '23'
    OR strftime('%Y-%m-%dT%H:%M:%S',substr(NEW.created_at,1,19)) IS NOT substr(NEW.created_at,1,19)
    OR date(substr(NEW.created_at,1,10),'+0 days') IS NOT substr(NEW.created_at,1,10)
    THEN RAISE(ABORT,'verification artifact identity or clock invalid') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM verification_requests r JOIN job_runs j ON j.command_request_id=r.id JOIN job_attempts a ON a.job_id=j.id
    WHERE r.id=NEW.request_id AND j.id=NEW.job_id AND j.job_type='governance_verification_v2' AND j.scope=r.portfolio_id
    AND j.status='running' AND j.lease_owner IS NOT NULL AND j.lease_until>NEW.created_at AND r.requested_at<=NEW.created_at
    AND j.attempt_count=NEW.attempt AND j.fencing_token=NEW.fencing_token
    AND a.attempt=NEW.attempt AND a.fencing_token=NEW.fencing_token AND a.status='running' AND a.finished_at IS NULL
    AND length(a.started_at)=27 AND length(j.lease_until)=27 AND a.started_at<=NEW.created_at)
    THEN RAISE(ABORT,'verification artifact requires current running attempt') END;
END;
CREATE TRIGGER verification_artifact_no_update BEFORE UPDATE ON verification_artifacts BEGIN SELECT RAISE(ABORT,'verification artifacts are append-only'); END;
CREATE TRIGGER verification_artifact_no_delete BEFORE DELETE ON verification_artifacts BEGIN SELECT RAISE(ABORT,'verification artifacts are append-only'); END;

CREATE TRIGGER verification_execution_insert BEFORE INSERT ON verification_executions BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM verification_executions WHERE id=NEW.id OR job_id=NEW.job_id OR attempt_id=NEW.attempt_id OR artifact_id=NEW.artifact_id)
    THEN RAISE(ABORT,'verification executions cannot be replaced') END;
  SELECT CASE WHEN typeof(NEW.id)!='text' OR length(NEW.id) NOT BETWEEN 1 AND 160
    OR substr(NEW.id,1,1) NOT GLOB '[A-Za-z0-9]' OR NEW.id GLOB '*[^A-Za-z0-9_.:-]*'
    OR EXISTS(SELECT 1 FROM json_each(json_array(NEW.started_at,NEW.finished_at,NEW.recorded_at))
      WHERE type!='text' OR length(value)!=27 OR substr(value,20,1)!='.' OR substr(value,27,1)!='Z'
      OR substr(value,21,6) GLOB '*[^0-9]*' OR substr(value,1,4)='0000' OR substr(value,12,2) NOT BETWEEN '00' AND '23'
      OR strftime('%Y-%m-%dT%H:%M:%S',substr(value,1,19)) IS NOT substr(value,1,19)
      OR date(substr(value,1,10),'+0 days') IS NOT substr(value,1,10))
    THEN RAISE(ABORT,'verification execution identity or clock invalid') END;
  SELECT CASE WHEN (SELECT count(*) FROM json_each(NEW.result_json))!=7 OR (SELECT count(DISTINCT key) FROM json_each(NEW.result_json))!=7
    OR EXISTS(SELECT 1 FROM json_each(NEW.result_json) WHERE key NOT IN ('schema_version','check_id','status','issues','assertions','gate_eligible','completed_requirements'))
    OR json_extract(NEW.result_json,'$.schema_version') IS NOT 'verification-check-result-v2'
    OR json_extract(NEW.result_json,'$.check_id') IS NOT 'E-02.cash-contribution-neutrality.v1'
    OR json_extract(NEW.result_json,'$.status') IS NOT NEW.status OR json_type(NEW.result_json,'$.gate_eligible') IS NOT 'false'
    OR json_type(NEW.result_json,'$.completed_requirements') IS NOT 'array' OR json_array_length(NEW.result_json,'$.completed_requirements')!=0
    OR json_type(NEW.result_json,'$.issues') IS NOT 'array' OR json_type(NEW.result_json,'$.assertions') IS NOT 'array'
    OR EXISTS(SELECT 1 FROM json_each(NEW.result_json,'$.issues') WHERE type!='text' OR length(trim(value)) NOT BETWEEN 1 AND 2000)
    OR EXISTS(SELECT 1 FROM json_each(NEW.result_json,'$.assertions') assertion WHERE assertion.type!='object'
      OR (SELECT count(*) FROM json_each(assertion.value))!=2 OR (SELECT count(DISTINCT key) FROM json_each(assertion.value))!=2
      OR EXISTS(SELECT 1 FROM json_each(assertion.value) WHERE key NOT IN ('id','status'))
      OR json_type(assertion.value,'$.id') IS NOT 'text' OR length(json_extract(assertion.value,'$.id')) NOT BETWEEN 1 AND 160
      OR json_type(assertion.value,'$.status') IS NOT 'text'
      OR json_extract(assertion.value,'$.status') NOT IN ('pass','fail'))
    OR (SELECT count(*) FROM json_each(NEW.result_json,'$.assertions'))!=(SELECT count(DISTINCT json_extract(value,'$.id')) FROM json_each(NEW.result_json,'$.assertions'))
    OR (NEW.status='pass' AND (json_array_length(NEW.result_json,'$.issues')!=0 OR json_array_length(NEW.result_json,'$.assertions')=0
      OR EXISTS(SELECT 1 FROM json_each(NEW.result_json,'$.assertions') WHERE json_extract(value,'$.status')!='pass')))
    OR (NEW.status='fail' AND json_array_length(NEW.result_json,'$.issues')=0
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.result_json,'$.assertions') WHERE json_extract(value,'$.status')='fail'))
    OR (NEW.status='blocked' AND json_array_length(NEW.result_json,'$.issues')=0)
    THEN RAISE(ABORT,'verification result cannot claim gate acceptance') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM verification_requests r JOIN job_runs j ON j.command_request_id=r.id JOIN job_attempts a ON a.job_id=j.id
    JOIN verification_artifacts f ON f.request_id=r.id AND f.job_id=j.id
    WHERE r.id=NEW.request_id AND r.context_hash=NEW.context_hash AND j.id=NEW.job_id AND j.job_type='governance_verification_v2'
    AND j.scope=r.portfolio_id AND j.status='running' AND j.lease_owner IS NOT NULL AND j.lease_until>NEW.recorded_at
    AND j.attempt_count=NEW.attempt AND j.fencing_token=NEW.fencing_token
    AND a.id=NEW.attempt_id AND a.attempt=NEW.attempt AND a.fencing_token=NEW.fencing_token AND a.status='running' AND a.finished_at IS NULL
    AND length(a.started_at)=27 AND length(j.lease_until)=27 AND r.requested_at<=a.started_at AND a.started_at<=NEW.started_at
    AND f.id=NEW.artifact_id AND f.attempt=NEW.attempt AND f.fencing_token=NEW.fencing_token AND f.kind='execution'
    AND f.body_sha256=NEW.artifact_sha256 AND f.created_at>=NEW.finished_at AND f.created_at<=NEW.recorded_at)
    THEN RAISE(ABORT,'verification execution requires scoped artifact and running attempt') END;
END;
CREATE TRIGGER verification_execution_no_update BEFORE UPDATE ON verification_executions BEGIN SELECT RAISE(ABORT,'verification executions are append-only'); END;
CREATE TRIGGER verification_execution_no_delete BEFORE DELETE ON verification_executions BEGIN SELECT RAISE(ABORT,'verification executions are append-only'); END;

CREATE TRIGGER verification_job_insert BEFORE INSERT ON job_runs
WHEN NEW.job_type='governance_verification_v2' OR EXISTS(SELECT 1 FROM verification_requests WHERE id=NEW.command_request_id)
  OR EXISTS(SELECT 1 FROM job_runs WHERE id=NEW.id AND job_type='governance_verification_v2') BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM job_runs WHERE id=NEW.id
    OR (job_type=NEW.job_type AND scope=NEW.scope AND period=NEW.period AND input_version=NEW.input_version))
    THEN RAISE(ABORT,'verification jobs cannot be replaced') END;
  SELECT CASE WHEN NEW.job_type IS NOT 'governance_verification_v2' OR NEW.status IS NOT 'queued' OR NEW.attempt_count IS NOT 0
    OR NEW.fencing_token IS NOT 0 OR NEW.max_attempts IS NOT 3 OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.result_json IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM verification_requests r JOIN command_requests c ON c.id=r.id
      WHERE r.id=NEW.command_request_id AND NEW.scope=r.portfolio_id AND NEW.period=substr(r.requested_at,1,10)
      AND NEW.input_version=r.id||':'||c.payload_hash AND c.command_type='governance_verification_v2' AND c.actor_id='system:governance-verifier-v2'
      AND NEW.created_at>=r.requested_at AND length(NEW.created_at)=27 AND NEW.updated_at=NEW.created_at AND length(NEW.not_before)=27)
    THEN RAISE(ABORT,'verification job requires queued scoped request') END;
END;

CREATE TRIGGER verification_job_update BEFORE UPDATE ON job_runs
WHEN OLD.job_type='governance_verification_v2' OR NEW.job_type='governance_verification_v2'
  OR EXISTS(SELECT 1 FROM verification_requests WHERE id=OLD.command_request_id OR id=NEW.command_request_id)
  OR EXISTS(SELECT 1 FROM job_runs WHERE id=NEW.id AND job_type='governance_verification_v2') BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.command_request_id IS NOT OLD.command_request_id OR NEW.job_type IS NOT OLD.job_type
    OR NEW.scope IS NOT OLD.scope OR NEW.period IS NOT OLD.period OR NEW.input_version IS NOT OLD.input_version
    OR NEW.max_attempts IS NOT OLD.max_attempts OR NEW.created_at IS NOT OLD.created_at
    OR OLD.status IN ('succeeded','failed','skipped','partial','cancelled')
    THEN RAISE(ABORT,'verification job identity or terminal result is immutable') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM verification_executions WHERE job_id=OLD.id)
    AND NEW.status NOT IN ('succeeded','failed','skipped')
    THEN RAISE(ABORT,'verification execution requires terminal job finalization') END;
  SELECT CASE WHEN NEW.status IN ('succeeded','failed','skipped','partial','cancelled') AND EXISTS(SELECT 1 FROM verification_executions WHERE job_id=OLD.id)
    AND NOT EXISTS(SELECT 1 FROM verification_executions e JOIN job_attempts a ON a.id=e.attempt_id
      WHERE e.job_id=OLD.id AND e.request_id=OLD.command_request_id AND e.attempt=OLD.attempt_count AND e.fencing_token=OLD.fencing_token
      AND NEW.attempt_count=OLD.attempt_count AND NEW.fencing_token=OLD.fencing_token AND OLD.status='running'
      AND NEW.status=CASE e.status WHEN 'pass' THEN 'succeeded' WHEN 'fail' THEN 'failed' ELSE 'skipped' END
      AND a.job_id=OLD.id AND a.attempt=e.attempt AND a.fencing_token=e.fencing_token AND a.status=NEW.status
      AND a.finished_at=NEW.updated_at AND length(a.finished_at)=27 AND e.recorded_at<=a.finished_at AND a.finished_at<OLD.lease_until
      AND NEW.lease_owner IS NULL AND NEW.lease_until IS NULL
      AND json_valid(NEW.result_json) AND json_type(NEW.result_json)='object'
      AND (SELECT count(*) FROM json_each(NEW.result_json))=6 AND (SELECT count(DISTINCT key) FROM json_each(NEW.result_json))=6
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.result_json) WHERE key NOT IN ('schema_version','request_id','execution_id','context_hash','result_hash','status'))
      AND json_extract(NEW.result_json,'$.schema_version') IS 'verification-job-result-v2'
      AND json_extract(NEW.result_json,'$.request_id') IS e.request_id AND json_extract(NEW.result_json,'$.execution_id') IS e.id
      AND json_extract(NEW.result_json,'$.context_hash') IS e.context_hash AND json_extract(NEW.result_json,'$.result_hash') IS e.result_hash
      AND json_extract(NEW.result_json,'$.status') IS e.status)
    THEN RAISE(ABORT,'verification terminal result requires complete matching execution') END;
  SELECT CASE WHEN NEW.status IN ('succeeded','failed','skipped','partial','cancelled') AND NOT EXISTS(SELECT 1 FROM verification_executions WHERE job_id=OLD.id)
    AND (NEW.status IN ('succeeded','skipped') OR (json_valid(NEW.result_json) AND (json_extract(NEW.result_json,'$.schema_version')='verification-job-result-v2'
      OR json_extract(NEW.result_json,'$.status') IN ('pass','succeeded') OR json_type(NEW.result_json,'$.execution_id') IS NOT NULL)))
    THEN RAISE(ABORT,'unexecuted verification cannot claim a completed result') END;
  SELECT CASE WHEN NEW.status IN ('failed','partial') AND NOT EXISTS(SELECT 1 FROM verification_executions WHERE job_id=OLD.id)
    AND NOT EXISTS(SELECT 1 FROM job_attempts a WHERE a.job_id=OLD.id AND a.attempt=OLD.attempt_count AND a.fencing_token=OLD.fencing_token
      AND a.status IN ('failed','partial','lease_expired') AND a.finished_at=NEW.updated_at)
    THEN RAISE(ABORT,'verification infrastructure failure requires terminal attempt') END;
END;
CREATE TRIGGER verification_job_no_delete BEFORE DELETE ON job_runs WHEN OLD.job_type='governance_verification_v2'
  BEGIN SELECT RAISE(ABORT,'verification jobs cannot be deleted'); END;

CREATE TRIGGER verification_attempt_insert BEFORE INSERT ON job_attempts
WHEN EXISTS(SELECT 1 FROM job_runs WHERE id=NEW.job_id AND job_type='governance_verification_v2')
  OR EXISTS(SELECT 1 FROM job_attempts a JOIN job_runs j ON j.id=a.job_id WHERE a.id=NEW.id AND j.job_type='governance_verification_v2') BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM job_attempts WHERE id=NEW.id OR (job_id=NEW.job_id AND attempt=NEW.attempt))
    THEN RAISE(ABORT,'verification attempts cannot be replaced') END;
  SELECT CASE WHEN NEW.status IS NOT 'running' OR NEW.finished_at IS NOT NULL OR NEW.error_json IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM job_runs j WHERE j.id=NEW.job_id AND j.status='running' AND j.lease_owner IS NOT NULL
      AND j.attempt_count=NEW.attempt AND j.fencing_token=NEW.fencing_token AND NEW.started_at=j.updated_at
      AND length(NEW.started_at)=27 AND j.lease_until>NEW.started_at)
    THEN RAISE(ABORT,'verification attempt requires current running job') END;
END;
CREATE TRIGGER verification_attempt_update BEFORE UPDATE ON job_attempts
WHEN EXISTS(SELECT 1 FROM job_runs WHERE id IN (OLD.job_id,NEW.job_id) AND job_type='governance_verification_v2')
  OR EXISTS(SELECT 1 FROM job_attempts a JOIN job_runs j ON j.id=a.job_id WHERE a.id=NEW.id AND j.job_type='governance_verification_v2') BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.job_id IS NOT OLD.job_id OR NEW.attempt IS NOT OLD.attempt
    OR NEW.fencing_token IS NOT OLD.fencing_token OR NEW.started_at IS NOT OLD.started_at OR OLD.status!='running'
    OR NEW.status NOT IN ('succeeded','failed','skipped','partial','lease_expired','cancelled')
    OR NEW.finished_at IS NULL OR length(NEW.finished_at)!=27 OR NEW.finished_at<OLD.started_at
    THEN RAISE(ABORT,'verification attempt identity or terminal result is immutable') END;
  SELECT CASE WHEN NEW.status IN ('succeeded','skipped') AND NOT EXISTS(SELECT 1 FROM verification_executions e
    WHERE e.attempt_id=OLD.id AND e.job_id=OLD.job_id AND e.attempt=OLD.attempt AND e.fencing_token=OLD.fencing_token
      AND NEW.status=CASE e.status WHEN 'pass' THEN 'succeeded' WHEN 'fail' THEN 'failed' ELSE 'skipped' END AND e.recorded_at<=NEW.finished_at)
    THEN RAISE(ABORT,'verification success attempt requires execution') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM verification_executions WHERE attempt_id=OLD.id)
    AND NOT EXISTS(SELECT 1 FROM verification_executions e JOIN job_runs j ON j.id=e.job_id
      WHERE e.attempt_id=OLD.id AND e.job_id=OLD.job_id AND e.attempt=OLD.attempt AND e.fencing_token=OLD.fencing_token
      AND j.status='running' AND j.attempt_count=OLD.attempt AND j.fencing_token=OLD.fencing_token
      AND NEW.status=CASE e.status WHEN 'pass' THEN 'succeeded' WHEN 'fail' THEN 'failed' ELSE 'skipped' END
      AND e.recorded_at<=NEW.finished_at AND NEW.finished_at<j.lease_until AND NEW.error_json IS NULL)
    THEN RAISE(ABORT,'verification terminal attempt requires matching execution') END;
END;
CREATE TRIGGER verification_attempt_no_delete BEFORE DELETE ON job_attempts
WHEN EXISTS(SELECT 1 FROM job_runs WHERE id=OLD.job_id AND job_type='governance_verification_v2')
  BEGIN SELECT RAISE(ABORT,'verification attempts cannot be deleted'); END;
