CREATE TABLE market_reference_sources (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id)) BETWEEN 1 AND 160),
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  reference TEXT NOT NULL CHECK(typeof(reference)='text' AND length(trim(reference)) BETWEEN 1 AND 2000),
  content_text TEXT NOT NULL CHECK(typeof(content_text)='text' AND json_valid(content_text)
    AND json_type(content_text)='object' AND length(CAST(content_text AS BLOB)) BETWEEN 1 AND 1048576),
  content_hash TEXT NOT NULL CHECK(typeof(content_hash)='text' AND length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  known_at TEXT NOT NULL CHECK(typeof(known_at)='text' AND length(known_at)=27
    AND substr(known_at,20,1)='.' AND substr(known_at,27,1)='Z' AND substr(known_at,21,6) NOT GLOB '*[^0-9]*'
    AND substr(known_at,1,4)!='0000' AND strftime('%Y-%m-%dT%H:%M:%S',known_at) IS substr(known_at,1,19)),
  created_by TEXT NOT NULL CHECK(length(trim(created_by)) BETWEEN 1 AND 160),
  UNIQUE(id,portfolio_id)
);
CREATE INDEX market_reference_source_history ON market_reference_sources(portfolio_id,known_at DESC,id DESC);

CREATE TABLE market_reference_versions (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id)) BETWEEN 1 AND 160),
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  kind TEXT NOT NULL CHECK(kind IN ('mapping','calendar')),
  scope_key TEXT NOT NULL CHECK(length(trim(scope_key)) BETWEEN 1 AND 160),
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  source_id TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK(typeof(source_hash)='text' AND length(source_hash)=64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
  known_at TEXT NOT NULL CHECK(typeof(known_at)='text' AND length(known_at)=27
    AND substr(known_at,20,1)='.' AND substr(known_at,27,1)='Z' AND substr(known_at,21,6) NOT GLOB '*[^0-9]*'
    AND substr(known_at,1,4)!='0000' AND strftime('%Y-%m-%dT%H:%M:%S',known_at) IS substr(known_at,1,19)),
  document_json TEXT NOT NULL CHECK(typeof(document_json)='text' AND json_valid(document_json)
    AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB)) BETWEEN 1 AND 1048576
    AND json_extract(document_json,'$.schema_version') IS 'market-reference-version-v1'
    AND json_extract(document_json,'$.id') IS id AND json_extract(document_json,'$.portfolio_id') IS portfolio_id
    AND json_extract(document_json,'$.kind') IS kind AND json_extract(document_json,'$.scope_key') IS scope_key
    AND json_type(document_json,'$.version') IS 'integer' AND json_extract(document_json,'$.version') IS version
    AND json_extract(document_json,'$.source_id') IS source_id AND json_extract(document_json,'$.source_hash') IS source_hash
    AND json_extract(document_json,'$.known_at') IS known_at AND json_extract(document_json,'$.created_by') IS created_by
    AND json_extract(document_json,'$.review_basis') IS 'human_reviewed_not_provider_verified'
    AND json_type(document_json,'$.review_reason') IS 'text' AND length(trim(json_extract(document_json,'$.review_reason'))) BETWEEN 1 AND 2000
    AND json_type(document_json,'$.facts') IS 'object'),
  content_hash TEXT NOT NULL CHECK(typeof(content_hash)='text' AND length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  created_by TEXT NOT NULL CHECK(length(trim(created_by)) BETWEEN 1 AND 160),
  UNIQUE(portfolio_id,kind,scope_key,version),
  UNIQUE(id,portfolio_id,kind,scope_key,version),
  FOREIGN KEY(source_id,portfolio_id) REFERENCES market_reference_sources(id,portfolio_id)
);
CREATE INDEX market_reference_version_history ON market_reference_versions(portfolio_id,kind,known_at DESC,id DESC);

CREATE TABLE market_reference_heads (
  portfolio_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  version_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(portfolio_id,kind,scope_key),
  FOREIGN KEY(version_id,portfolio_id,kind,scope_key,version)
    REFERENCES market_reference_versions(id,portfolio_id,kind,scope_key,version)
);

CREATE TRIGGER market_reference_source_no_replace BEFORE INSERT ON market_reference_sources
  WHEN EXISTS(SELECT 1 FROM market_reference_sources WHERE id=NEW.id)
  BEGIN SELECT RAISE(ABORT,'market reference sources cannot be replaced'); END;
CREATE TRIGGER market_reference_source_no_update BEFORE UPDATE ON market_reference_sources
  BEGIN SELECT RAISE(ABORT,'market reference sources are append-only'); END;
CREATE TRIGGER market_reference_source_no_delete BEFORE DELETE ON market_reference_sources
  BEGIN SELECT RAISE(ABORT,'market reference sources are append-only'); END;

CREATE TRIGGER market_reference_version_insert BEFORE INSERT ON market_reference_versions BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM market_reference_versions WHERE id=NEW.id OR audit_id=NEW.audit_id
    OR (portfolio_id=NEW.portfolio_id AND kind=NEW.kind AND scope_key=NEW.scope_key AND version=NEW.version))
    THEN RAISE(ABORT,'market reference versions cannot be replaced') END;
  SELECT CASE WHEN NEW.version IS NOT (SELECT COALESCE(MAX(version),0)+1 FROM market_reference_versions
    WHERE portfolio_id=NEW.portfolio_id AND kind=NEW.kind AND scope_key=NEW.scope_key)
    THEN RAISE(ABORT,'market reference version must advance once') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM market_reference_sources s WHERE s.id=NEW.source_id
    AND s.portfolio_id=NEW.portfolio_id AND s.content_hash=NEW.source_hash AND s.known_at<=NEW.known_at
    AND json_extract(NEW.document_json,'$.source_known_at') IS s.known_at)
    THEN RAISE(ABORT,'market reference source mismatch') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.id=NEW.audit_id AND a.portfolio_id=NEW.portfolio_id
    AND a.actor_id=NEW.created_by AND a.action='publish_market_reference' AND a.object_type='market_reference'
    AND a.object_id=NEW.id AND a.created_at=NEW.known_at AND json_extract(a.payload_json,'$.actor_kind') IS 'human'
    AND json_extract(a.payload_json,'$.input.portfolio_id') IS NEW.portfolio_id
    AND json_type(a.payload_json,'$.input.expected_version') IS 'integer'
    AND json_extract(a.payload_json,'$.input.expected_version') IS NEW.version-1
    AND json_extract(a.payload_json,'$.input.source_id') IS NEW.source_id AND json_extract(a.payload_json,'$.input.source_hash') IS NEW.source_hash
    AND json_extract(a.payload_json,'$.input.review_reason') IS json_extract(NEW.document_json,'$.review_reason')
    AND json_type(a.payload_json,'$.input.acknowledgement') IS 'true'
    AND json_extract(a.payload_json,'$.input.document.kind') IS NEW.kind
    AND json_extract(a.payload_json,'$.input.document.facts') IS json_extract(NEW.document_json,'$.facts')
    AND json_extract(a.payload_json,'$.result.id') IS NEW.id AND json_extract(a.payload_json,'$.result.portfolio_id') IS NEW.portfolio_id
    AND json_extract(a.payload_json,'$.result.kind') IS NEW.kind AND json_extract(a.payload_json,'$.result.scope_key') IS NEW.scope_key
    AND json_type(a.payload_json,'$.result.version') IS 'integer' AND json_extract(a.payload_json,'$.result.version') IS NEW.version
    AND json_extract(a.payload_json,'$.result.source_id') IS NEW.source_id AND json_extract(a.payload_json,'$.result.source_hash') IS NEW.source_hash
    AND json_extract(a.payload_json,'$.result.known_at') IS NEW.known_at AND json_extract(a.payload_json,'$.result.content_hash') IS NEW.content_hash
    AND json_extract(a.payload_json,'$.result.verification_status') IS 'human_reviewed_not_provider_verified')
    THEN RAISE(ABORT,'market reference requires matching human review audit') END;
END;
CREATE TRIGGER market_reference_version_no_update BEFORE UPDATE ON market_reference_versions
  BEGIN SELECT RAISE(ABORT,'market reference versions are append-only'); END;
CREATE TRIGGER market_reference_version_no_delete BEFORE DELETE ON market_reference_versions
  BEGIN SELECT RAISE(ABORT,'market reference versions are append-only'); END;

CREATE TRIGGER market_reference_head_insert BEFORE INSERT ON market_reference_heads BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM market_reference_heads WHERE portfolio_id=NEW.portfolio_id AND kind=NEW.kind AND scope_key=NEW.scope_key)
    THEN RAISE(ABORT,'market reference heads cannot be replaced') END;
  SELECT CASE WHEN NEW.version IS NOT 1 OR NOT EXISTS(SELECT 1 FROM market_reference_versions v WHERE v.id=NEW.version_id
    AND v.portfolio_id=NEW.portfolio_id AND v.kind=NEW.kind AND v.scope_key=NEW.scope_key AND v.version=NEW.version AND v.known_at=NEW.updated_at)
    THEN RAISE(ABORT,'market reference head must start at version one') END;
END;
CREATE TRIGGER market_reference_head_update BEFORE UPDATE ON market_reference_heads BEGIN
  SELECT CASE WHEN NEW.portfolio_id IS NOT OLD.portfolio_id OR NEW.kind IS NOT OLD.kind OR NEW.scope_key IS NOT OLD.scope_key
    OR NEW.version IS NOT OLD.version+1 OR NEW.version_id IS OLD.version_id OR NEW.updated_at<OLD.updated_at
    OR NOT EXISTS(SELECT 1 FROM market_reference_versions v WHERE v.id=NEW.version_id AND v.portfolio_id=NEW.portfolio_id
      AND v.kind=NEW.kind AND v.scope_key=NEW.scope_key AND v.version=NEW.version AND v.known_at=NEW.updated_at)
    THEN RAISE(ABORT,'market reference head CAS mismatch') END;
END;
CREATE TRIGGER market_reference_head_no_delete BEFORE DELETE ON market_reference_heads
  BEGIN SELECT RAISE(ABORT,'market reference heads cannot be deleted'); END;

CREATE TABLE market_sdk_captures (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id)) BETWEEN 1 AND 160),
  batch_id TEXT NOT NULL UNIQUE REFERENCES market_batches(id) DEFERRABLE INITIALLY DEFERRED,
  command_request_id TEXT NOT NULL UNIQUE REFERENCES command_requests(id),
  job_id TEXT NOT NULL REFERENCES job_runs(id),
  attempt INTEGER NOT NULL CHECK(typeof(attempt)='integer' AND attempt BETWEEN 1 AND 9007199254740991),
  raw_body BLOB NOT NULL CHECK(typeof(raw_body)='blob' AND length(raw_body) BETWEEN 1 AND 2097152),
  receipt_json TEXT NOT NULL CHECK(typeof(receipt_json)='text' AND json_valid(receipt_json) AND json_type(receipt_json)='object'
    AND length(CAST(receipt_json AS BLOB))<=16384 AND json_extract(receipt_json,'$.schema_version') IS 'market-sdk-capture-v1'
    AND json_extract(receipt_json,'$.provider') IS 'longport' AND json_extract(receipt_json,'$.capture_kind') IS 'sdk_projection'
    AND json_extract(receipt_json,'$.parser_version') IS 'longport-price-collection-v1' AND json_extract(receipt_json,'$.sdk_version') IS '4.3.7'
    AND json_type(receipt_json,'$.attempt') IS 'integer' AND json_type(receipt_json,'$.fencing_token') IS 'integer'
    AND json_extract(receipt_json,'$.fencing_token') BETWEEN 1 AND 9007199254740991
    AND json_extract(receipt_json,'$.raw_bytes') IS length(raw_body)
    AND json_extract(receipt_json,'$.publication_time_status') IS 'not_supplied'
    AND json_extract(receipt_json,'$.rate_kind') IS 'market_price_not_executable'
    AND json_extract(receipt_json,'$.timestamp_semantics') IS 'provider_bar_timestamp_not_confirmed_close'
    AND json_extract(receipt_json,'$.coverage_kind') IS 'reviewed_calendar_exact_dates'),
  receipt_hash TEXT NOT NULL CHECK(typeof(receipt_hash)='text' AND length(receipt_hash)=64 AND receipt_hash NOT GLOB '*[^0-9a-f]*'),
  normalized_json TEXT NOT NULL CHECK(typeof(normalized_json)='text' AND json_valid(normalized_json)
    AND json_type(normalized_json)='object' AND length(CAST(normalized_json AS BLOB))<=4194304),
  document_json TEXT NOT NULL CHECK(typeof(document_json)='text' AND json_valid(document_json) AND json_type(document_json)='object'
    AND length(CAST(document_json AS BLOB))<=4194304 AND json_extract(document_json,'$.schema_version') IS 'market-price-provider-batch-v1'
    AND json_extract(document_json,'$.batch.source_id') IS 'provider:longport:prices'
    AND json_extract(document_json,'$.batch.batch_type') IS 'prices'),
  created_at TEXT NOT NULL CHECK(typeof(created_at)='text' AND length(created_at)=27
    AND substr(created_at,20,1)='.' AND substr(created_at,27,1)='Z' AND substr(created_at,21,6) NOT GLOB '*[^0-9]*'
    AND substr(created_at,1,4)!='0000' AND strftime('%Y-%m-%dT%H:%M:%S',created_at) IS substr(created_at,1,19))
);

CREATE TRIGGER sdk_capture_worker_attempt BEFORE INSERT ON market_sdk_captures BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM job_runs j JOIN command_requests c ON c.id=j.command_request_id
    JOIN job_attempts a ON a.job_id=j.id AND a.attempt=j.attempt_count
    WHERE j.id=NEW.job_id AND j.status='running' AND j.job_type='market_collect_prices'
    AND typeof(j.lease_owner)='text' AND length(trim(j.lease_owner))>0
    AND c.id=NEW.command_request_id AND c.command_type='market_collect_prices' AND j.scope=c.portfolio_id
    AND json_extract(c.payload_json,'$.schema_version') IS 'market-price-collect-v1' AND json_extract(c.payload_json,'$.provider') IS 'longport'
    AND a.status='running' AND a.attempt=NEW.attempt AND j.fencing_token=json_extract(NEW.receipt_json,'$.fencing_token')
    AND a.fencing_token=j.fencing_token AND j.lease_until>NEW.created_at
    AND json_extract(NEW.receipt_json,'$.id') IS NEW.id AND json_extract(NEW.receipt_json,'$.batch_id') IS NEW.batch_id
    AND json_extract(NEW.receipt_json,'$.job_id') IS NEW.job_id AND json_extract(NEW.receipt_json,'$.attempt') IS NEW.attempt
    AND json_extract(NEW.receipt_json,'$.command_request_id') IS c.id AND json_extract(NEW.receipt_json,'$.request_hash') IS c.payload_hash
    AND json_extract(NEW.receipt_json,'$.request_started_at')>=a.started_at
    AND json_extract(NEW.receipt_json,'$.received_at')>=json_extract(NEW.receipt_json,'$.request_started_at')
    AND json_extract(NEW.receipt_json,'$.received_at')<=NEW.created_at)
    THEN RAISE(ABORT,'SDK capture requires matching live worker attempt') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.receipt_json) WHERE key IN ('request_hash','raw_sha256','normalized_hash','document_hash','references_hash')
    AND (type!='text' OR length(value)!=64 OR value GLOB '*[^0-9a-f]*'))
    OR (SELECT count(*) FROM json_each(NEW.receipt_json) WHERE key IN ('request_hash','raw_sha256','normalized_hash','document_hash','references_hash'))!=5
    THEN RAISE(ABORT,'SDK capture hashes required') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.receipt_json) WHERE key IN ('request_started_at','received_at')
    AND (type!='text' OR length(value)!=27 OR substr(value,20,1)!='.' OR substr(value,27,1)!='Z'
      OR substr(value,21,6) GLOB '*[^0-9]*' OR substr(value,1,4)='0000'
      OR strftime('%Y-%m-%dT%H:%M:%S',value) IS NOT substr(value,1,19)))
    THEN RAISE(ABORT,'SDK capture requires canonical UTC times') END;
END;
CREATE TRIGGER sdk_capture_no_replace BEFORE INSERT ON market_sdk_captures
  WHEN EXISTS(SELECT 1 FROM market_sdk_captures WHERE id=NEW.id OR batch_id=NEW.batch_id OR command_request_id=NEW.command_request_id)
  BEGIN SELECT RAISE(ABORT,'SDK captures cannot be replaced'); END;
CREATE TRIGGER sdk_capture_no_update BEFORE UPDATE ON market_sdk_captures
  BEGIN SELECT RAISE(ABORT,'SDK captures are append-only'); END;
CREATE TRIGGER sdk_capture_no_delete BEFORE DELETE ON market_sdk_captures
  BEGIN SELECT RAISE(ABORT,'SDK captures are append-only'); END;

DROP TRIGGER provider_batch_requires_capture;
CREATE TRIGGER provider_batch_requires_capture BEFORE INSERT ON market_batches
  WHEN (NEW.source_id LIKE 'provider:%' OR NEW.scope LIKE 'provider:%'
    OR json_extract(NEW.validation_json,'$.plan.source_mode')='provider_observed')
    AND NOT EXISTS(SELECT 1 FROM market_provider_captures p WHERE p.batch_id=NEW.id
      AND p.id=json_extract(NEW.validation_json,'$.plan.provider_capture_id')
      AND NEW.source_id='provider:ecb:reference-fx' AND NEW.batch_type='fx'
      AND NEW.id=json_extract(p.document_json,'$.batch.id') AND NEW.source_id=json_extract(p.document_json,'$.batch.source_id')
      AND NEW.scope=json_extract(p.document_json,'$.batch.scope') AND NEW.batch_type=json_extract(p.document_json,'$.batch.batch_type')
      AND NEW.expected_pages=json_extract(p.document_json,'$.batch.expected_pages')
      AND NEW.started_at=json_extract(p.receipt_json,'$.request_started_at')
      AND json_extract(p.document_json,'$.batch.source_mode')='provider_observed'
      AND json_extract(p.document_json,'$.batch')=json_extract(NEW.validation_json,'$.plan'))
    AND NOT EXISTS(SELECT 1 FROM market_sdk_captures p WHERE p.batch_id=NEW.id
      AND p.id=json_extract(NEW.validation_json,'$.plan.provider_capture_id')
      AND NEW.source_id='provider:longport:prices' AND NEW.batch_type='prices'
      AND NEW.id=json_extract(p.document_json,'$.batch.id') AND NEW.source_id=json_extract(p.document_json,'$.batch.source_id')
      AND NEW.scope=json_extract(p.document_json,'$.batch.scope') AND NEW.batch_type=json_extract(p.document_json,'$.batch.batch_type')
      AND NEW.expected_pages=json_extract(p.document_json,'$.batch.expected_pages')
      AND NEW.started_at=json_extract(p.receipt_json,'$.request_started_at')
      AND json_extract(p.document_json,'$.batch.source_mode')='provider_observed'
      AND json_extract(p.document_json,'$.batch')=json_extract(NEW.validation_json,'$.plan'))
  BEGIN SELECT RAISE(ABORT,'provider batch requires captured document'); END;
