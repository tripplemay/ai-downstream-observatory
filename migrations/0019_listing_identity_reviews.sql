CREATE TABLE listing_review_versions (
  id TEXT PRIMARY KEY NOT NULL CHECK(typeof(id)='text' AND length(id) BETWEEN 1 AND 160
    AND substr(id,1,1) GLOB '[A-Za-z0-9]' AND id NOT GLOB '*[^A-Za-z0-9_.:-]*'),
  portfolio_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  source_id TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK(typeof(source_hash)='text' AND length(source_hash)=64 AND source_hash NOT GLOB '*[^a-f0-9]*'),
  source_known_at TEXT NOT NULL,
  identity_json TEXT NOT NULL CHECK(typeof(identity_json)='text' AND json_valid(identity_json)
    AND json_type(identity_json)='object' AND length(CAST(identity_json AS BLOB)) BETWEEN 1 AND 4096),
  identity_hash TEXT NOT NULL CHECK(typeof(identity_hash)='text' AND length(identity_hash)=64 AND identity_hash NOT GLOB '*[^a-f0-9]*'),
  known_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK(typeof(created_by)='text' AND length(created_by) BETWEEN 1 AND 160
    AND substr(created_by,1,1) GLOB '[A-Za-z0-9]' AND created_by NOT GLOB '*[^A-Za-z0-9_.:-]*'
    AND substr(created_by,1,7)!='system:'),
  review_until TEXT NOT NULL CHECK(review_until>known_at),
  reason TEXT NOT NULL CHECK(typeof(reason)='text' AND length(trim(reason)) BETWEEN 1 AND 2000),
  facts_json TEXT NOT NULL CHECK(typeof(facts_json)='text' AND json_valid(facts_json)
    AND json_type(facts_json)='object' AND length(CAST(facts_json AS BLOB)) BETWEEN 1 AND 16384),
  document_json TEXT NOT NULL CHECK(typeof(document_json)='text' AND json_valid(document_json)
    AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB)) BETWEEN 1 AND 65536),
  content_hash TEXT NOT NULL CHECK(typeof(content_hash)='text' AND length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(portfolio_id,listing_id,revision),
  UNIQUE(id,portfolio_id,listing_id,revision),
  FOREIGN KEY(portfolio_id,listing_id) REFERENCES catalog_entries(portfolio_id,listing_id),
  FOREIGN KEY(source_id,portfolio_id) REFERENCES market_reference_sources(id,portfolio_id)
);
CREATE INDEX listing_review_history ON listing_review_versions(portfolio_id,listing_id,known_at DESC,revision DESC);

CREATE TABLE listing_review_heads (
  portfolio_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  version_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(portfolio_id,listing_id),
  FOREIGN KEY(version_id,portfolio_id,listing_id,revision)
    REFERENCES listing_review_versions(id,portfolio_id,listing_id,revision)
);

CREATE TRIGGER listing_review_version_insert BEFORE INSERT ON listing_review_versions BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM listing_review_versions WHERE id=NEW.id OR audit_id=NEW.audit_id
    OR (portfolio_id=NEW.portfolio_id AND listing_id=NEW.listing_id AND revision=NEW.revision))
    THEN RAISE(ABORT,'listing reviews cannot be replaced') END;
  SELECT CASE WHEN NEW.revision IS NOT (SELECT COALESCE(MAX(revision),0)+1 FROM listing_review_versions
      WHERE portfolio_id=NEW.portfolio_id AND listing_id=NEW.listing_id)
    OR NEW.revision IS NOT (SELECT COALESCE(MAX(revision),0)+1 FROM listing_review_heads
      WHERE portfolio_id=NEW.portfolio_id AND listing_id=NEW.listing_id)
    OR EXISTS(SELECT 1 FROM listing_review_heads WHERE portfolio_id=NEW.portfolio_id AND listing_id=NEW.listing_id AND updated_at>NEW.known_at)
    THEN RAISE(ABORT,'listing review revision CAS mismatch') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(json_array(NEW.source_known_at,NEW.known_at,NEW.review_until))
    WHERE type!='text' OR length(value)!=27 OR substr(value,20,1)!='.' OR substr(value,27,1)!='Z'
      OR substr(value,21,6) GLOB '*[^0-9]*' OR substr(value,1,4)='0000'
      OR substr(value,12,2) NOT BETWEEN '00' AND '23'
      OR strftime('%Y-%m-%dT%H:%M:%S',substr(value,1,19)) IS NOT substr(value,1,19)
      OR date(substr(value,1,10),'+0 days') IS NOT substr(value,1,10))
    THEN RAISE(ABORT,'listing review requires canonical UTC times') END;
  SELECT CASE WHEN (SELECT count(*) FROM json_each(NEW.identity_json))!=6
    OR (SELECT count(DISTINCT key) FROM json_each(NEW.identity_json))!=6
    OR EXISTS(SELECT 1 FROM json_each(NEW.identity_json) WHERE key NOT IN ('listing_id','instrument_id','market','exchange','ticker','currency') OR type!='text')
    OR NOT EXISTS(SELECT 1 FROM listings l WHERE l.id=NEW.listing_id
      AND json_extract(NEW.identity_json,'$.listing_id') IS l.id
      AND json_extract(NEW.identity_json,'$.instrument_id') IS l.instrument_id
      AND json_extract(NEW.identity_json,'$.market') IS l.market
      AND json_extract(NEW.identity_json,'$.exchange') IS l.exchange
      AND json_extract(NEW.identity_json,'$.ticker') IS l.ticker
      AND json_extract(NEW.identity_json,'$.currency') IS l.currency)
    THEN RAISE(ABORT,'listing review identity mismatch') END;
  SELECT CASE WHEN (SELECT count(*) FROM json_each(NEW.facts_json))!=9
    OR (SELECT count(DISTINCT key) FROM json_each(NEW.facts_json))!=9
    OR EXISTS(SELECT 1 FROM json_each(NEW.facts_json) WHERE key NOT IN
      ('instrument_kind','lifecycle_status','quantity_step','price_step','source_effective_date','fund_identifier','share_class_identifier','risk_classification','product_structure'))
    OR json_extract(NEW.facts_json,'$.instrument_kind') NOT IN ('ETF','ETN','equity','fund','other','unknown')
    OR json_extract(NEW.facts_json,'$.lifecycle_status') NOT IN ('active','suspended','delisted','unknown')
    OR json_type(NEW.facts_json,'$.instrument_kind') IS NOT 'text' OR json_type(NEW.facts_json,'$.lifecycle_status') IS NOT 'text'
    OR json_type(NEW.facts_json,'$.risk_classification') IS NOT 'object'
    OR (SELECT count(*) FROM json_each(NEW.facts_json,'$.risk_classification'))!=3
    OR (SELECT count(DISTINCT key) FROM json_each(NEW.facts_json,'$.risk_classification'))!=3
    OR EXISTS(SELECT 1 FROM json_each(NEW.facts_json,'$.risk_classification') WHERE key NOT IN ('index_id','region','sector'))
    OR json_type(NEW.facts_json,'$.product_structure') IS NOT 'object'
    OR (SELECT count(*) FROM json_each(NEW.facts_json,'$.product_structure'))!=2
    OR (SELECT count(DISTINCT key) FROM json_each(NEW.facts_json,'$.product_structure'))!=2
    OR EXISTS(SELECT 1 FROM json_each(NEW.facts_json,'$.product_structure') WHERE key NOT IN ('leverage','direction') OR type!='text')
    OR json_extract(NEW.facts_json,'$.product_structure.leverage') NOT IN ('unleveraged','leveraged','unknown')
    OR json_extract(NEW.facts_json,'$.product_structure.direction') NOT IN ('long_only','inverse','unknown')
    THEN RAISE(ABORT,'listing review facts shape invalid') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.facts_json) WHERE key IN ('quantity_step','price_step') AND type!='null'
    AND (type!='text' OR length(value) NOT BETWEEN 1 AND 39 OR value GLOB '*[^0-9.]*'
      OR substr(value,1,1) NOT GLOB '[0-9]' OR substr(value,-1,1) NOT GLOB '[0-9]'
      OR length(value)-length(replace(value,'.',''))>1
      OR (length(value)>1 AND substr(value,1,1)='0' AND substr(value,2,1)!='.')
      OR length(replace(value,'.',''))>38 OR (instr(value,'.')>0 AND length(value)-instr(value,'.') NOT BETWEEN 1 AND 18)
      OR replace(replace(value,'0',''),'.','')=''))
    THEN RAISE(ABORT,'listing review steps require positive exact decimal text') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.facts_json) WHERE key IN ('fund_identifier','share_class_identifier') AND type!='null'
    AND (type!='text' OR length(trim(value)) NOT BETWEEN 1 AND 160))
    OR EXISTS(SELECT 1 FROM json_each(NEW.facts_json,'$.risk_classification') WHERE type!='null'
      AND (type!='text' OR length(trim(value)) NOT BETWEEN 1 AND 160))
    OR (json_type(NEW.facts_json,'$.source_effective_date') IS NOT 'null'
      AND (json_type(NEW.facts_json,'$.source_effective_date') IS NOT 'text'
        OR length(json_extract(NEW.facts_json,'$.source_effective_date'))!=10
        OR substr(json_extract(NEW.facts_json,'$.source_effective_date'),1,4)='0000'
        OR date(json_extract(NEW.facts_json,'$.source_effective_date'),'+0 days') IS NOT json_extract(NEW.facts_json,'$.source_effective_date')))
    THEN RAISE(ABORT,'listing review source facts invalid') END;
  SELECT CASE WHEN (SELECT count(*) FROM json_each(NEW.document_json))!=16
    OR (SELECT count(DISTINCT key) FROM json_each(NEW.document_json))!=16
    OR EXISTS(SELECT 1 FROM json_each(NEW.document_json) WHERE key NOT IN
      ('schema_version','id','portfolio_id','listing_id','revision','source_id','source_hash','source_known_at','identity_snapshot','identity_hash','known_at','created_by','review_until','reason','review_basis','facts'))
    OR json_extract(NEW.document_json,'$.schema_version') IS NOT 'listing-review-v1'
    OR json_extract(NEW.document_json,'$.id') IS NOT NEW.id OR json_extract(NEW.document_json,'$.portfolio_id') IS NOT NEW.portfolio_id
    OR json_extract(NEW.document_json,'$.listing_id') IS NOT NEW.listing_id
    OR json_type(NEW.document_json,'$.revision') IS NOT 'integer' OR json_extract(NEW.document_json,'$.revision') IS NOT NEW.revision
    OR json_extract(NEW.document_json,'$.source_id') IS NOT NEW.source_id OR json_extract(NEW.document_json,'$.source_hash') IS NOT NEW.source_hash
    OR json_extract(NEW.document_json,'$.source_known_at') IS NOT NEW.source_known_at
    OR json_extract(NEW.document_json,'$.identity_snapshot') IS NOT json(NEW.identity_json)
    OR json_extract(NEW.document_json,'$.identity_hash') IS NOT NEW.identity_hash
    OR json_extract(NEW.document_json,'$.known_at') IS NOT NEW.known_at OR json_extract(NEW.document_json,'$.created_by') IS NOT NEW.created_by
    OR json_extract(NEW.document_json,'$.review_until') IS NOT NEW.review_until OR json_extract(NEW.document_json,'$.reason') IS NOT NEW.reason
    OR json_extract(NEW.document_json,'$.review_basis') IS NOT 'human_reviewed_not_provider_verified'
    OR json_extract(NEW.document_json,'$.facts') IS NOT json(NEW.facts_json)
    THEN RAISE(ABORT,'listing review document binding mismatch') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM market_reference_sources s WHERE s.id=NEW.source_id AND s.portfolio_id=NEW.portfolio_id
    AND s.content_hash=NEW.source_hash AND s.known_at=NEW.source_known_at AND s.known_at<=NEW.known_at
    AND length(s.created_by) BETWEEN 1 AND 160 AND substr(s.created_by,1,7)!='system:'
    AND substr(s.created_by,1,1) GLOB '[A-Za-z0-9]' AND s.created_by NOT GLOB '*[^A-Za-z0-9_.:-]*'
    AND EXISTS(SELECT 1 FROM audit_events a WHERE a.portfolio_id=s.portfolio_id AND a.actor_id=s.created_by
      AND a.action='store_market_reference_source' AND a.object_type='market_reference_source' AND a.object_id=s.id
      AND a.ledger_revision IS NULL AND a.created_at=s.known_at AND json_extract(a.payload_json,'$.actor_kind') IS 'human'
      AND (SELECT count(*) FROM json_each(a.payload_json))=3 AND (SELECT count(DISTINCT key) FROM json_each(a.payload_json))=3
      AND NOT EXISTS(SELECT 1 FROM json_each(a.payload_json) WHERE key NOT IN ('actor_kind','input_hash','result'))
      AND json_type(a.payload_json,'$.input_hash') IS 'text' AND length(json_extract(a.payload_json,'$.input_hash'))=64
      AND json_extract(a.payload_json,'$.input_hash') NOT GLOB '*[^a-f0-9]*'
      AND json_type(a.payload_json,'$.result') IS 'object'
      AND (SELECT count(*) FROM json_each(a.payload_json,'$.result'))=5 AND (SELECT count(DISTINCT key) FROM json_each(a.payload_json,'$.result'))=5
      AND NOT EXISTS(SELECT 1 FROM json_each(a.payload_json,'$.result') WHERE key NOT IN ('id','portfolio_id','reference','content_hash','known_at'))
      AND json_extract(a.payload_json,'$.result.id') IS s.id AND json_extract(a.payload_json,'$.result.portfolio_id') IS s.portfolio_id
      AND json_extract(a.payload_json,'$.result.reference') IS s.reference AND json_extract(a.payload_json,'$.result.content_hash') IS s.content_hash
      AND json_extract(a.payload_json,'$.result.known_at') IS s.known_at))
    THEN RAISE(ABORT,'listing review requires scoped human source evidence') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.id=NEW.audit_id AND a.portfolio_id=NEW.portfolio_id
    AND a.actor_id=NEW.created_by AND a.action='publish_listing_review' AND a.object_type='listing_review' AND a.object_id=NEW.id
    AND a.ledger_revision IS NULL AND a.created_at=NEW.known_at AND json_type(a.payload_json) IS 'object'
    AND (SELECT count(*) FROM json_each(a.payload_json))=3 AND (SELECT count(DISTINCT key) FROM json_each(a.payload_json))=3
    AND NOT EXISTS(SELECT 1 FROM json_each(a.payload_json) WHERE key NOT IN ('actor_kind','input','result'))
    AND json_extract(a.payload_json,'$.actor_kind') IS 'human'
    AND json_type(a.payload_json,'$.input') IS 'object' AND (SELECT count(*) FROM json_each(a.payload_json,'$.input'))=11
    AND (SELECT count(DISTINCT key) FROM json_each(a.payload_json,'$.input'))=11
    AND NOT EXISTS(SELECT 1 FROM json_each(a.payload_json,'$.input') WHERE key NOT IN
      ('portfolio_id','listing_id','expected_review_revision','expected_identity_hash','source_id','source_hash','facts','review_until','reason','acknowledgement','idempotency_key'))
    AND json_extract(a.payload_json,'$.input.portfolio_id') IS NEW.portfolio_id AND json_extract(a.payload_json,'$.input.listing_id') IS NEW.listing_id
    AND json_type(a.payload_json,'$.input.expected_review_revision') IS 'integer'
    AND json_extract(a.payload_json,'$.input.expected_review_revision') IS NEW.revision-1
    AND json_extract(a.payload_json,'$.input.expected_identity_hash') IS NEW.identity_hash
    AND json_extract(a.payload_json,'$.input.source_id') IS NEW.source_id AND json_extract(a.payload_json,'$.input.source_hash') IS NEW.source_hash
    AND json_extract(a.payload_json,'$.input.facts') IS json(NEW.facts_json)
    AND json_extract(a.payload_json,'$.input.review_until') IS NEW.review_until AND json_extract(a.payload_json,'$.input.reason') IS NEW.reason
    AND json_type(a.payload_json,'$.input.acknowledgement') IS 'true'
    AND json_type(a.payload_json,'$.input.idempotency_key') IS 'text'
    AND length(json_extract(a.payload_json,'$.input.idempotency_key')) BETWEEN 1 AND 160
    AND json_extract(a.payload_json,'$.input.idempotency_key') NOT GLOB '*[^A-Za-z0-9_.:-]*'
    AND substr(json_extract(a.payload_json,'$.input.idempotency_key'),1,1) GLOB '[A-Za-z0-9]'
    AND json_type(a.payload_json,'$.result') IS 'object' AND (SELECT count(*) FROM json_each(a.payload_json,'$.result'))=11
    AND (SELECT count(DISTINCT key) FROM json_each(a.payload_json,'$.result'))=11
    AND NOT EXISTS(SELECT 1 FROM json_each(a.payload_json,'$.result') WHERE key NOT IN
      ('id','portfolio_id','listing_id','revision','content_hash','identity_hash','source_id','source_hash','known_at','review_until','review_basis'))
    AND json_extract(a.payload_json,'$.result.id') IS NEW.id AND json_extract(a.payload_json,'$.result.portfolio_id') IS NEW.portfolio_id
    AND json_extract(a.payload_json,'$.result.listing_id') IS NEW.listing_id
    AND json_type(a.payload_json,'$.result.revision') IS 'integer' AND json_extract(a.payload_json,'$.result.revision') IS NEW.revision
    AND json_extract(a.payload_json,'$.result.content_hash') IS NEW.content_hash AND json_extract(a.payload_json,'$.result.identity_hash') IS NEW.identity_hash
    AND json_extract(a.payload_json,'$.result.source_id') IS NEW.source_id AND json_extract(a.payload_json,'$.result.source_hash') IS NEW.source_hash
    AND json_extract(a.payload_json,'$.result.known_at') IS NEW.known_at AND json_extract(a.payload_json,'$.result.review_until') IS NEW.review_until
    AND json_extract(a.payload_json,'$.result.review_basis') IS 'human_reviewed_not_provider_verified')
    THEN RAISE(ABORT,'listing review requires matching human audit') END;
END;
CREATE TRIGGER listing_review_version_no_update BEFORE UPDATE ON listing_review_versions
  BEGIN SELECT RAISE(ABORT,'listing reviews are append-only'); END;
CREATE TRIGGER listing_review_version_no_delete BEFORE DELETE ON listing_review_versions
  BEGIN SELECT RAISE(ABORT,'listing reviews are append-only'); END;

CREATE TRIGGER listing_review_head_insert BEFORE INSERT ON listing_review_heads BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM listing_review_heads WHERE portfolio_id=NEW.portfolio_id AND listing_id=NEW.listing_id)
    THEN RAISE(ABORT,'listing review heads cannot be replaced') END;
  SELECT CASE WHEN NEW.revision IS NOT 1 OR NOT EXISTS(SELECT 1 FROM listing_review_versions v WHERE v.id=NEW.version_id
    AND v.portfolio_id=NEW.portfolio_id AND v.listing_id=NEW.listing_id AND v.revision=NEW.revision AND v.known_at=NEW.updated_at)
    THEN RAISE(ABORT,'listing review head must start at revision one') END;
END;
CREATE TRIGGER listing_review_head_update BEFORE UPDATE ON listing_review_heads BEGIN
  SELECT CASE WHEN NEW.portfolio_id IS NOT OLD.portfolio_id OR NEW.listing_id IS NOT OLD.listing_id
    OR NEW.revision IS NOT OLD.revision+1 OR NEW.version_id IS OLD.version_id OR NEW.updated_at<OLD.updated_at
    OR NOT EXISTS(SELECT 1 FROM listing_review_versions v WHERE v.id=NEW.version_id AND v.portfolio_id=NEW.portfolio_id
      AND v.listing_id=NEW.listing_id AND v.revision=NEW.revision AND v.known_at=NEW.updated_at)
    THEN RAISE(ABORT,'listing review head CAS mismatch') END;
END;
CREATE TRIGGER listing_review_head_no_delete BEFORE DELETE ON listing_review_heads
  BEGIN SELECT RAISE(ABORT,'listing review heads cannot be deleted'); END;
