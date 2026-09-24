CREATE TABLE csv_background_requests (
  id TEXT PRIMARY KEY NOT NULL,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  account_id TEXT NOT NULL,
  actor_id TEXT NOT NULL CHECK(length(trim(actor_id)) BETWEEN 1 AND 160),
  session_hash TEXT NOT NULL CHECK(length(session_hash)=64 AND session_hash NOT GLOB '*[^a-f0-9]*'),
  operation TEXT NOT NULL CHECK(operation IN ('preview','confirm')),
  idempotency_key TEXT NOT NULL CHECK(length(trim(idempotency_key)) BETWEEN 1 AND 200),
  expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740991),
  input_json TEXT NOT NULL CHECK(json_valid(input_json) AND length(CAST(input_json AS BLOB)) BETWEEN 1 AND 1572864),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64 AND input_hash NOT GLOB '*[^a-f0-9]*'),
  csv_bytes BLOB,
  confirmation_attempt_id TEXT REFERENCES csv_confirmation_attempts(id),
  batch_id TEXT REFERENCES csv_import_manifests(batch_id),
  command_request_id TEXT NOT NULL UNIQUE REFERENCES command_requests(id),
  approval_audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(account_id,portfolio_id) REFERENCES accounts(id,portfolio_id),
  UNIQUE(actor_id,session_hash,portfolio_id,operation,idempotency_key),
  CHECK((operation='preview' AND typeof(csv_bytes)='blob' AND length(csv_bytes) BETWEEN 1 AND 4194304
      AND confirmation_attempt_id IS NULL AND batch_id IS NULL)
    OR (operation='confirm' AND csv_bytes IS NULL AND confirmation_attempt_id IS NOT NULL AND batch_id IS NOT NULL)),
  CHECK(julianday(created_at) IS NOT NULL AND julianday(expires_at)>julianday(created_at)
    AND (julianday(expires_at)-julianday(created_at))*86400 BETWEEN 899.99 AND 900.01)
);
CREATE INDEX csv_background_requests_owner ON csv_background_requests(actor_id,portfolio_id,created_at DESC,id DESC);
CREATE INDEX csv_background_requests_batch ON csv_background_requests(batch_id);

CREATE TABLE csv_background_cancellations (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES csv_background_requests(id),
  actor_id TEXT NOT NULL CHECK(length(trim(actor_id)) BETWEEN 1 AND 160),
  session_hash TEXT NOT NULL CHECK(length(session_hash)=64 AND session_hash NOT GLOB '*[^a-f0-9]*'),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL)
);

CREATE TABLE csv_background_results (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES csv_background_requests(id),
  job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id),
  job_attempt_id TEXT NOT NULL UNIQUE REFERENCES job_attempts(id),
  batch_id TEXT NOT NULL REFERENCES csv_import_manifests(batch_id),
  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(CAST(result_json AS BLOB)) BETWEEN 1 AND 65536),
  result_hash TEXT NOT NULL CHECK(length(result_hash)=64 AND result_hash NOT GLOB '*[^a-f0-9]*'),
  completed_at TEXT NOT NULL CHECK(julianday(completed_at) IS NOT NULL)
);
CREATE INDEX csv_background_results_batch ON csv_background_results(batch_id);

CREATE TRIGGER csv_background_request_insert BEFORE INSERT ON csv_background_requests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM csv_background_requests WHERE id=NEW.id OR command_request_id=NEW.command_request_id OR approval_audit_id=NEW.approval_audit_id
      OR (actor_id=NEW.actor_id AND session_hash=NEW.session_hash AND portfolio_id=NEW.portfolio_id AND operation=NEW.operation AND idempotency_key=NEW.idempotency_key))
    THEN RAISE(ABORT,'CSV background requests are append-only') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM command_requests c JOIN audit_events a ON a.id=NEW.approval_audit_id
    WHERE c.id=NEW.command_request_id AND c.id=NEW.id AND c.idempotency_key=NEW.id
      AND c.portfolio_id=NEW.portfolio_id AND c.actor_id='system:csv-background'
      AND c.command_type=CASE NEW.operation WHEN 'preview' THEN 'csv_import_preview_v1' ELSE 'csv_import_confirm_v1' END
      AND c.created_at=NEW.created_at AND json_valid(c.payload_json)
      AND json_extract(c.payload_json,'$.schema_version')='csv-background-command-v1'
      AND json_extract(c.payload_json,'$.request_id')=NEW.id AND json_extract(c.payload_json,'$.input_hash')=NEW.input_hash
      AND a.actor_id=NEW.actor_id AND a.portfolio_id=NEW.portfolio_id AND a.ledger_revision=NEW.expected_revision
      AND a.action='request_csv_background' AND a.object_type='csv_background_request' AND a.object_id=NEW.id AND a.created_at=NEW.created_at
      AND json_valid(a.payload_json) AND json_extract(a.payload_json,'$.actor_kind')='human'
      AND json_extract(a.payload_json,'$.input.portfolio_id')=NEW.portfolio_id
      AND json_extract(a.payload_json,'$.input.account_id')=NEW.account_id
      AND json_extract(a.payload_json,'$.input.operation')=NEW.operation
      AND json_extract(a.payload_json,'$.input.idempotency_key')=NEW.idempotency_key
      AND json_extract(a.payload_json,'$.input.expected_revision')=NEW.expected_revision
      AND json_extract(a.payload_json,'$.input.input_hash')=NEW.input_hash
      AND json_extract(a.payload_json,'$.input.session_hash')=NEW.session_hash
      AND json_type(a.payload_json,'$.input.acknowledge_background_execution')='true'
      AND json_extract(a.payload_json,'$.result.request_id')=NEW.id)
    THEN RAISE(ABORT,'CSV background authorization mismatch') END;
  SELECT CASE WHEN NEW.operation='confirm' AND NOT EXISTS(SELECT 1 FROM csv_confirmation_attempts t
    WHERE t.id=NEW.confirmation_attempt_id AND t.actor_id=NEW.actor_id AND t.session_hash=NEW.session_hash
      AND t.portfolio_id=NEW.portfolio_id AND t.account_id=NEW.account_id AND t.batch_id=NEW.batch_id
      AND t.expected_revision=NEW.expected_revision AND t.payload_hash=json_extract(NEW.input_json,'$.payload_hash'))
    THEN RAISE(ABORT,'CSV background confirmation mismatch') END;
END;
CREATE TRIGGER csv_background_request_no_update BEFORE UPDATE ON csv_background_requests BEGIN
  SELECT RAISE(ABORT,'CSV background requests are append-only');
END;
CREATE TRIGGER csv_background_request_no_delete BEFORE DELETE ON csv_background_requests BEGIN
  SELECT RAISE(ABORT,'CSV background requests are append-only');
END;

CREATE TRIGGER csv_background_cancel_insert BEFORE INSERT ON csv_background_cancellations BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM csv_background_cancellations WHERE request_id=NEW.request_id)
    THEN RAISE(ABORT,'CSV background cancellations are append-only') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM csv_background_requests r WHERE r.id=NEW.request_id AND r.actor_id=NEW.actor_id
      AND julianday(NEW.created_at)>=julianday(r.created_at))
    OR EXISTS(SELECT 1 FROM csv_background_results WHERE request_id=NEW.request_id)
    OR EXISTS(SELECT 1 FROM job_runs j JOIN csv_background_requests r ON r.command_request_id=j.command_request_id
      WHERE r.id=NEW.request_id AND j.status IN ('succeeded','failed','partial','skipped','cancelled'))
    THEN RAISE(ABORT,'CSV background cancellation conflict') END;
END;
CREATE TRIGGER csv_background_cancel_no_update BEFORE UPDATE ON csv_background_cancellations BEGIN
  SELECT RAISE(ABORT,'CSV background cancellations are append-only');
END;
CREATE TRIGGER csv_background_cancel_no_delete BEFORE DELETE ON csv_background_cancellations BEGIN
  SELECT RAISE(ABORT,'CSV background cancellations are append-only');
END;

CREATE TRIGGER csv_background_result_insert BEFORE INSERT ON csv_background_results BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM csv_background_results WHERE request_id=NEW.request_id OR job_id=NEW.job_id OR job_attempt_id=NEW.job_attempt_id)
    THEN RAISE(ABORT,'CSV background results are append-only') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM csv_background_cancellations WHERE request_id=NEW.request_id)
    OR NOT EXISTS(SELECT 1 FROM csv_background_requests r
      JOIN command_requests c ON c.id=r.command_request_id
      JOIN job_runs j ON j.command_request_id=c.id
      JOIN job_attempts a ON a.job_id=j.id
      JOIN import_batches b ON b.id=NEW.batch_id
      JOIN csv_import_manifests m ON m.batch_id=b.id
      WHERE r.id=NEW.request_id AND j.id=NEW.job_id AND a.id=NEW.job_attempt_id
        AND j.job_type=c.command_type AND j.scope=r.portfolio_id
        AND j.input_version=c.id || ':' || c.payload_hash
        AND j.status='running' AND a.status='running' AND a.fencing_token=j.fencing_token AND a.attempt=j.attempt_count
        AND julianday(NEW.completed_at)>=julianday(a.started_at)
        AND julianday(NEW.completed_at)<julianday(j.lease_until) AND julianday(NEW.completed_at)<julianday(r.expires_at)
        AND b.portfolio_id=r.portfolio_id AND b.account_id=r.account_id AND b.parser_version='csv-v1'
        AND (r.operation='preview' OR (b.id=r.batch_id AND b.status='confirmed'))
        AND json_extract(NEW.result_json,'$.schema_version')='csv-background-result-v1'
        AND json_extract(NEW.result_json,'$.request_id')=r.id AND json_extract(NEW.result_json,'$.operation')=r.operation
        AND json_extract(NEW.result_json,'$.input_hash')=r.input_hash AND json_extract(NEW.result_json,'$.batch_id')=b.id
        AND json_extract(NEW.result_json,'$.preview_hash')=b.preview_hash AND json_extract(NEW.result_json,'$.expected_revision')=b.expected_revision
        AND json_extract(NEW.result_json,'$.batch_status')=b.status AND json_extract(NEW.result_json,'$.row_count')=b.row_count
        AND json_extract(NEW.result_json,'$.error_count')=b.error_count
        AND json_extract(NEW.result_json,'$.review_hash')=json_extract(m.manifest_json,'$.review_hash')
        AND json_extract(NEW.result_json,'$.required_review_count')=json_array_length(m.manifest_json,'$.required_review_rows')
        AND json_extract(NEW.result_json,'$.confirmed_revision') IS b.confirmed_revision)
    THEN RAISE(ABORT,'CSV background result binding mismatch') END;
END;
CREATE TRIGGER csv_background_result_no_update BEFORE UPDATE ON csv_background_results BEGIN
  SELECT RAISE(ABORT,'CSV background results are append-only');
END;
CREATE TRIGGER csv_background_result_no_delete BEFORE DELETE ON csv_background_results BEGIN
  SELECT RAISE(ABORT,'CSV background results are append-only');
END;

CREATE TRIGGER csv_background_job_success BEFORE UPDATE ON job_runs
WHEN NEW.job_type IN ('csv_import_preview_v1','csv_import_confirm_v1') AND NEW.status='succeeded' BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM csv_background_results r JOIN csv_background_requests q ON q.id=r.request_id
    JOIN job_attempts a ON a.id=r.job_attempt_id
    WHERE r.job_id=NEW.id AND q.command_request_id=NEW.command_request_id AND q.portfolio_id=NEW.scope
      AND a.job_id=NEW.id AND a.status='succeeded' AND a.fencing_token=NEW.fencing_token AND a.attempt=NEW.attempt_count
      AND a.finished_at=r.completed_at AND NEW.updated_at=r.completed_at AND json_valid(NEW.result_json)
      AND json_extract(NEW.result_json,'$.schema_version')='csv-background-job-result-v1'
      AND json_extract(NEW.result_json,'$.request_id')=r.request_id
      AND json_extract(NEW.result_json,'$.operation')=q.operation
      AND json_extract(NEW.result_json,'$.batch_id')=r.batch_id
      AND json_extract(NEW.result_json,'$.result_hash')=r.result_hash
      AND NEW.lease_owner IS NULL AND NEW.lease_until IS NULL)
    THEN RAISE(ABORT,'CSV background successful job requires result') END;
END;
CREATE TRIGGER csv_background_job_success_insert BEFORE INSERT ON job_runs
WHEN NEW.job_type IN ('csv_import_preview_v1','csv_import_confirm_v1') AND NEW.status='succeeded' BEGIN
  SELECT RAISE(ABORT,'CSV background successful job requires result');
END;

CREATE TRIGGER csv_background_audit_no_replace BEFORE INSERT ON audit_events
WHEN EXISTS(SELECT 1 FROM csv_background_requests WHERE approval_audit_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'CSV background audits cannot be replaced'); END;
CREATE TRIGGER csv_background_command_no_replace BEFORE INSERT ON command_requests
WHEN EXISTS(SELECT 1 FROM command_requests c WHERE (c.id=NEW.id OR (c.portfolio_id=NEW.portfolio_id AND c.command_type=NEW.command_type AND c.idempotency_key=NEW.idempotency_key))
  AND (c.actor_id='system:csv-background' OR c.command_type IN ('csv_import_preview_v1','csv_import_confirm_v1')
    OR EXISTS(SELECT 1 FROM csv_background_requests WHERE command_request_id=c.id)))
BEGIN SELECT RAISE(ABORT,'CSV background commands cannot be replaced'); END;
CREATE TRIGGER csv_background_command_no_update BEFORE UPDATE ON command_requests
WHEN OLD.actor_id='system:csv-background' OR NEW.actor_id='system:csv-background'
  OR OLD.command_type IN ('csv_import_preview_v1','csv_import_confirm_v1') OR NEW.command_type IN ('csv_import_preview_v1','csv_import_confirm_v1')
  OR EXISTS(SELECT 1 FROM csv_background_requests WHERE command_request_id IN (OLD.id,NEW.id))
BEGIN SELECT RAISE(ABORT,'CSV background commands are immutable'); END;
CREATE TRIGGER csv_background_command_no_delete BEFORE DELETE ON command_requests
WHEN OLD.actor_id='system:csv-background' OR OLD.command_type IN ('csv_import_preview_v1','csv_import_confirm_v1')
  OR EXISTS(SELECT 1 FROM csv_background_requests WHERE command_request_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'CSV background commands are immutable'); END;

CREATE TRIGGER csv_background_job_insert BEFORE INSERT ON job_runs
WHEN NEW.job_type IN ('csv_import_preview_v1','csv_import_confirm_v1')
  OR EXISTS(SELECT 1 FROM csv_background_requests WHERE command_request_id=NEW.command_request_id)
  OR EXISTS(SELECT 1 FROM job_runs WHERE id=NEW.id AND job_type IN ('csv_import_preview_v1','csv_import_confirm_v1')) BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM job_runs WHERE id=NEW.id OR command_request_id=NEW.command_request_id
    OR (job_type=NEW.job_type AND scope=NEW.scope AND period=NEW.period AND input_version=NEW.input_version))
    THEN RAISE(ABORT,'CSV background jobs cannot be replaced') END;
  SELECT CASE WHEN NEW.status!='queued' OR NEW.attempt_count!=0 OR NEW.fencing_token!=0 OR NEW.max_attempts!=3
    OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.result_json IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM csv_background_requests r JOIN command_requests c ON c.id=r.command_request_id
      WHERE c.id=NEW.command_request_id AND c.command_type=NEW.job_type AND NEW.scope=r.portfolio_id
        AND NEW.period=substr(r.created_at,1,10) AND NEW.input_version=c.id || ':' || c.payload_hash)
    THEN RAISE(ABORT,'CSV background job requires queued scoped request') END;
END;
CREATE TRIGGER csv_background_job_identity BEFORE UPDATE ON job_runs
WHEN OLD.job_type IN ('csv_import_preview_v1','csv_import_confirm_v1') OR NEW.job_type IN ('csv_import_preview_v1','csv_import_confirm_v1')
  OR EXISTS(SELECT 1 FROM csv_background_requests WHERE command_request_id IN (OLD.command_request_id,NEW.command_request_id)) BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.command_request_id IS NOT OLD.command_request_id OR NEW.job_type IS NOT OLD.job_type
    OR NEW.scope IS NOT OLD.scope OR NEW.period IS NOT OLD.period OR NEW.input_version IS NOT OLD.input_version
    OR NEW.max_attempts IS NOT OLD.max_attempts OR NEW.created_at IS NOT OLD.created_at
    OR OLD.status IN ('succeeded','failed','skipped','partial','cancelled')
    THEN RAISE(ABORT,'CSV background job identity or terminal result is immutable') END;
END;
CREATE TRIGGER csv_background_job_no_delete BEFORE DELETE ON job_runs
WHEN OLD.job_type IN ('csv_import_preview_v1','csv_import_confirm_v1')
  OR EXISTS(SELECT 1 FROM csv_background_requests WHERE command_request_id=OLD.command_request_id)
BEGIN SELECT RAISE(ABORT,'CSV background jobs cannot be deleted'); END;

CREATE TRIGGER csv_background_attempt_insert BEFORE INSERT ON job_attempts
WHEN EXISTS(SELECT 1 FROM job_runs WHERE id=NEW.job_id AND job_type IN ('csv_import_preview_v1','csv_import_confirm_v1'))
  OR EXISTS(SELECT 1 FROM job_attempts a JOIN job_runs j ON j.id=a.job_id WHERE a.id=NEW.id AND j.job_type IN ('csv_import_preview_v1','csv_import_confirm_v1')) BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM job_attempts WHERE id=NEW.id OR (job_id=NEW.job_id AND attempt=NEW.attempt))
    THEN RAISE(ABORT,'CSV background attempts cannot be replaced') END;
  SELECT CASE WHEN NEW.status!='running' OR NEW.finished_at IS NOT NULL OR NEW.error_json IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM job_runs WHERE id=NEW.job_id AND status='running' AND lease_owner IS NOT NULL
      AND attempt_count=NEW.attempt AND fencing_token=NEW.fencing_token AND updated_at=NEW.started_at
      AND julianday(lease_until)>julianday(NEW.started_at))
    THEN RAISE(ABORT,'CSV background attempt requires running lease') END;
END;
CREATE TRIGGER csv_background_attempt_update BEFORE UPDATE ON job_attempts
WHEN EXISTS(SELECT 1 FROM job_runs WHERE id IN (OLD.job_id,NEW.job_id) AND job_type IN ('csv_import_preview_v1','csv_import_confirm_v1')) BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.job_id IS NOT OLD.job_id OR NEW.attempt IS NOT OLD.attempt
    OR NEW.fencing_token IS NOT OLD.fencing_token OR NEW.started_at IS NOT OLD.started_at OR OLD.status!='running'
    OR NEW.status NOT IN ('succeeded','failed','skipped','partial','lease_expired','cancelled')
    OR julianday(NEW.finished_at) IS NULL OR julianday(NEW.finished_at)<julianday(OLD.started_at)
    THEN RAISE(ABORT,'CSV background attempt identity or terminal state is immutable') END;
  SELECT CASE WHEN NEW.status='succeeded' AND NOT EXISTS(SELECT 1 FROM csv_background_results WHERE job_attempt_id=OLD.id AND completed_at=NEW.finished_at)
    THEN RAISE(ABORT,'CSV background successful attempt requires result') END;
END;
CREATE TRIGGER csv_background_attempt_no_delete BEFORE DELETE ON job_attempts
WHEN EXISTS(SELECT 1 FROM job_runs WHERE id=OLD.job_id AND job_type IN ('csv_import_preview_v1','csv_import_confirm_v1'))
BEGIN SELECT RAISE(ABORT,'CSV background attempts cannot be deleted'); END;
