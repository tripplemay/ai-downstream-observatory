CREATE TABLE market_provider_captures (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL UNIQUE REFERENCES market_batches(id) DEFERRABLE INITIALLY DEFERRED,
  command_request_id TEXT NOT NULL UNIQUE REFERENCES command_requests(id),
  job_id TEXT NOT NULL REFERENCES job_runs(id),
  attempt INTEGER NOT NULL CHECK(typeof(attempt) = 'integer' AND attempt BETWEEN 1 AND 9007199254740991),
  raw_body BLOB NOT NULL CHECK(typeof(raw_body) = 'blob' AND length(raw_body) BETWEEN 1 AND 2097152),
  receipt_json TEXT NOT NULL CHECK(typeof(receipt_json) = 'text' AND json_valid(receipt_json)
    AND json_type(receipt_json) = 'object' AND length(CAST(receipt_json AS BLOB)) <= 16384
    AND json_extract(receipt_json, '$.schema_version') IS 'market-provider-capture-v1'
    AND json_extract(receipt_json, '$.provider') IS 'ecb'
    AND json_extract(receipt_json, '$.capture_kind') IS 'http_response_bytes'
    AND json_type(receipt_json, '$.attempt') IS 'integer'
    AND json_type(receipt_json, '$.fencing_token') IS 'integer'
    AND json_extract(receipt_json, '$.raw_bytes') IS length(raw_body)),
  receipt_hash TEXT NOT NULL CHECK(typeof(receipt_hash) = 'text' AND length(receipt_hash) = 64 AND receipt_hash NOT GLOB '*[^0-9a-f]*'),
  normalized_json TEXT NOT NULL CHECK(typeof(normalized_json) = 'text' AND json_valid(normalized_json)
    AND json_type(normalized_json) = 'object' AND length(CAST(normalized_json AS BLOB)) <= 4194304),
  document_json TEXT NOT NULL CHECK(typeof(document_json) = 'text' AND json_valid(document_json)
    AND json_type(document_json) = 'object' AND length(CAST(document_json AS BLOB)) <= 4194304
    AND json_extract(document_json, '$.schema_version') IS 'market-provider-batch-v1'),
  created_at TEXT NOT NULL CHECK(typeof(created_at) = 'text' AND length(created_at) = 27
    AND substr(created_at, 20, 1) = '.' AND substr(created_at, 27, 1) = 'Z'
    AND substr(created_at, 21, 6) NOT GLOB '*[^0-9]*'
    AND strftime('%Y-%m-%dT%H:%M:%S', created_at) IS substr(created_at, 1, 19))
);

CREATE TRIGGER provider_capture_worker_attempt BEFORE INSERT ON market_provider_captures
  WHEN NOT EXISTS (
    SELECT 1 FROM job_runs j JOIN command_requests c ON c.id = j.command_request_id
      JOIN job_attempts a ON a.job_id = j.id AND a.attempt = j.attempt_count
    WHERE j.id = NEW.job_id AND j.status = 'running' AND j.job_type = 'market_collect'
      AND typeof(j.lease_owner) = 'text' AND length(trim(j.lease_owner)) > 0
      AND c.id = NEW.command_request_id AND c.command_type = 'market_collect'
      AND j.scope = c.portfolio_id AND a.status = 'running' AND a.attempt = NEW.attempt
      AND j.fencing_token = json_extract(NEW.receipt_json, '$.fencing_token')
      AND a.fencing_token = j.fencing_token AND j.lease_until > NEW.created_at
      AND json_extract(NEW.receipt_json, '$.id') = NEW.id
      AND json_extract(NEW.receipt_json, '$.batch_id') = NEW.batch_id
      AND json_extract(NEW.receipt_json, '$.job_id') = NEW.job_id
      AND json_extract(NEW.receipt_json, '$.attempt') = NEW.attempt
      AND json_extract(NEW.receipt_json, '$.command_request_id') = c.id
      AND json_extract(NEW.receipt_json, '$.request_hash') = c.payload_hash
      AND json_extract(NEW.receipt_json, '$.request_started_at') >= a.started_at
      AND json_extract(NEW.receipt_json, '$.received_at') >= json_extract(NEW.receipt_json, '$.request_started_at')
      AND json_extract(NEW.receipt_json, '$.received_at') <= NEW.created_at
  ) BEGIN SELECT RAISE(ABORT, 'provider capture requires matching live worker attempt'); END;

CREATE TRIGGER provider_capture_no_replace BEFORE INSERT ON market_provider_captures
  WHEN EXISTS (SELECT 1 FROM market_provider_captures WHERE id = NEW.id
    OR batch_id = NEW.batch_id OR command_request_id = NEW.command_request_id)
  BEGIN SELECT RAISE(ABORT, 'provider captures cannot be replaced'); END;

CREATE TRIGGER provider_capture_no_update BEFORE UPDATE ON market_provider_captures
  BEGIN SELECT RAISE(ABORT, 'provider captures are append-only'); END;
CREATE TRIGGER provider_capture_no_delete BEFORE DELETE ON market_provider_captures
  BEGIN SELECT RAISE(ABORT, 'provider captures are append-only'); END;

CREATE TRIGGER provider_batch_requires_capture BEFORE INSERT ON market_batches
  WHEN (NEW.source_id LIKE 'provider:%' OR NEW.scope LIKE 'provider:%'
    OR json_extract(NEW.validation_json, '$.plan.source_mode') = 'provider_observed')
    AND NOT EXISTS (SELECT 1 FROM market_provider_captures p WHERE p.batch_id = NEW.id
      AND p.id = json_extract(NEW.validation_json, '$.plan.provider_capture_id')
      AND NEW.id = json_extract(p.document_json, '$.batch.id')
      AND NEW.source_id = json_extract(p.document_json, '$.batch.source_id')
      AND NEW.scope = json_extract(p.document_json, '$.batch.scope')
      AND NEW.batch_type = json_extract(p.document_json, '$.batch.batch_type')
      AND NEW.expected_pages = json_extract(p.document_json, '$.batch.expected_pages')
      AND NEW.started_at = json_extract(p.receipt_json, '$.request_started_at')
      AND json_extract(p.document_json, '$.batch.source_mode') = 'provider_observed'
      AND json_extract(p.document_json, '$.batch') = json_extract(NEW.validation_json, '$.plan'))
  BEGIN SELECT RAISE(ABORT, 'provider batch requires captured document'); END;
