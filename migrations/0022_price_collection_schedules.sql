CREATE TABLE price_collection_schedules (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id)) BETWEEN 1 AND 160),
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  provider TEXT NOT NULL CHECK(provider='longport'),
  market TEXT NOT NULL CHECK(market IN ('CN','HK','US')),
  scope_key TEXT NOT NULL CHECK(length(scope_key)=89 AND substr(scope_key,1,25)='provider:longport:prices:' AND substr(scope_key,26) NOT GLOB '*[^a-f0-9]*'),
  created_by TEXT NOT NULL CHECK(length(trim(created_by)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL CHECK(length(created_at)=27 AND substr(created_at,20,1)='.' AND substr(created_at,27,1)='Z'
    AND substr(created_at,21,6) NOT GLOB '*[^0-9]*' AND substr(created_at,1,4)!='0000'
    AND strftime('%Y-%m-%dT%H:%M:%S',substr(created_at,1,19)) IS substr(created_at,1,19)),
  UNIQUE(portfolio_id,scope_key), UNIQUE(id,portfolio_id,scope_key), UNIQUE(id,scope_key)
);

CREATE TABLE price_collection_schedule_versions (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id)) BETWEEN 1 AND 160),
  schedule_id TEXT NOT NULL REFERENCES price_collection_schedules(id),
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  definition_json TEXT NOT NULL CHECK(typeof(definition_json)='text' AND json_valid(definition_json)
    AND json_type(definition_json)='object' AND length(CAST(definition_json AS BLOB)) BETWEEN 1 AND 65536),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  reference_binding_json TEXT NOT NULL CHECK(typeof(reference_binding_json)='text' AND json_valid(reference_binding_json) AND json_type(reference_binding_json)='object' AND length(CAST(reference_binding_json AS BLOB)) BETWEEN 1 AND 65536),
  reference_binding_hash TEXT NOT NULL CHECK(length(reference_binding_hash)=64 AND reference_binding_hash NOT GLOB '*[^a-f0-9]*'),
  created_by TEXT NOT NULL CHECK(length(trim(created_by)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL CHECK(length(created_at)=27 AND substr(created_at,20,1)='.' AND substr(created_at,27,1)='Z'
    AND substr(created_at,21,6) NOT GLOB '*[^0-9]*' AND substr(created_at,1,4)!='0000'
    AND strftime('%Y-%m-%dT%H:%M:%S',substr(created_at,1,19)) IS substr(created_at,1,19)),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(schedule_id,version), UNIQUE(id,schedule_id)
);

CREATE TABLE price_collection_schedule_controls (
  schedule_id TEXT NOT NULL REFERENCES price_collection_schedules(id),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  version_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('paused','enabled')),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  created_at TEXT NOT NULL CHECK(length(created_at)=27 AND substr(created_at,20,1)='.' AND substr(created_at,27,1)='Z'
    AND substr(created_at,21,6) NOT GLOB '*[^0-9]*' AND substr(created_at,1,4)!='0000'
    AND strftime('%Y-%m-%dT%H:%M:%S',substr(created_at,1,19)) IS substr(created_at,1,19)),
  PRIMARY KEY(schedule_id,revision),
  UNIQUE(schedule_id,revision,version_id,status,audit_id,created_at),
  UNIQUE(schedule_id,revision,version_id,audit_id),
  FOREIGN KEY(version_id,schedule_id) REFERENCES price_collection_schedule_versions(id,schedule_id)
);
CREATE INDEX price_collection_control_history ON price_collection_schedule_controls(schedule_id,created_at,revision);

CREATE TABLE price_collection_schedule_heads (
  schedule_id TEXT PRIMARY KEY NOT NULL,
  scope_key TEXT NOT NULL,
  current_version_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL CHECK(status IN ('paused','enabled')),
  last_audit_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(schedule_id,scope_key) REFERENCES price_collection_schedules(id,scope_key),
  FOREIGN KEY(schedule_id,revision,current_version_id,status,last_audit_id,updated_at)
    REFERENCES price_collection_schedule_controls(schedule_id,revision,version_id,status,audit_id,created_at)
);
CREATE UNIQUE INDEX price_collection_enabled_scope ON price_collection_schedule_heads(scope_key) WHERE status='enabled';
CREATE INDEX price_collection_schedule_due ON price_collection_schedule_heads(status,schedule_id);

CREATE TABLE price_collection_schedule_slots (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id)) BETWEEN 1 AND 160),
  portfolio_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  reference_binding_json TEXT NOT NULL CHECK(typeof(reference_binding_json)='text' AND json_valid(reference_binding_json) AND json_type(reference_binding_json)='object' AND length(CAST(reference_binding_json AS BLOB)) BETWEEN 1 AND 65536),
  reference_binding_hash TEXT NOT NULL CHECK(length(reference_binding_hash)=64 AND reference_binding_hash NOT GLOB '*[^a-f0-9]*'),
  period TEXT NOT NULL CHECK(length(period)=10 AND substr(period,1,4)!='0000' AND date(period,'+0 days') IS period),
  schedule_id TEXT NOT NULL,
  schedule_version_id TEXT NOT NULL,
  authorization_audit_id TEXT NOT NULL,
  authorization_revision INTEGER NOT NULL CHECK(typeof(authorization_revision)='integer' AND authorization_revision BETWEEN 1 AND 9007199254740991),
  scheduled_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK(length(created_at)=27 AND substr(created_at,20,1)='.' AND substr(created_at,27,1)='Z'
    AND substr(created_at,21,6) NOT GLOB '*[^0-9]*' AND substr(created_at,1,4)!='0000'
    AND strftime('%Y-%m-%dT%H:%M:%S',substr(created_at,1,19)) IS substr(created_at,1,19)),
  disposition TEXT NOT NULL CHECK(disposition IN ('requested','skipped','blocked','missed')),
  reason_code TEXT,
  command_request_id TEXT UNIQUE REFERENCES command_requests(id),
  expected_publication_revision INTEGER CHECK(expected_publication_revision IS NULL
    OR (typeof(expected_publication_revision)='integer' AND expected_publication_revision BETWEEN 0 AND 9007199254740991)),
  UNIQUE(scope_key,period),
  FOREIGN KEY(schedule_id,portfolio_id,scope_key) REFERENCES price_collection_schedules(id,portfolio_id,scope_key),
  FOREIGN KEY(schedule_version_id,schedule_id) REFERENCES price_collection_schedule_versions(id,schedule_id),
  FOREIGN KEY(schedule_id,authorization_revision,schedule_version_id,authorization_audit_id)
    REFERENCES price_collection_schedule_controls(schedule_id,revision,version_id,audit_id),
  CHECK((disposition='requested' AND reason_code IS NULL AND command_request_id IS NOT NULL AND expected_publication_revision IS NOT NULL)
    OR (disposition='missed' AND reason_code IN ('DEADLINE_EXPIRED','AUTHORIZATION_ENDED') AND reason_code IS NOT NULL
      AND command_request_id IS NULL AND expected_publication_revision IS NULL)
    OR (disposition='skipped' AND reason_code='MARKET_CLOSED' AND command_request_id IS NULL AND expected_publication_revision IS NULL)
    OR (disposition='blocked' AND reason_code IN ('MIXED_CALENDAR_SESSION','REFERENCE_CHANGED','REFERENCE_INVALID') AND reason_code IS NOT NULL AND command_request_id IS NULL AND expected_publication_revision IS NULL))
);
CREATE INDEX price_collection_slot_history ON price_collection_schedule_slots(portfolio_id,period DESC,id DESC);
CREATE INDEX price_collection_slot_schedule ON price_collection_schedule_slots(schedule_id,period);

-- Full UTF-16 string limits and raw hashes are independently rechecked by both readers.
CREATE TRIGGER price_collection_audit_insert BEFORE INSERT ON audit_events
WHEN NEW.object_type='price_collection_schedule' OR NEW.action IN ('save_price_collection_schedule','set_price_collection_schedule_status') BEGIN
  SELECT CASE WHEN NEW.object_type IS NOT 'price_collection_schedule'
    OR NEW.action NOT IN ('save_price_collection_schedule','set_price_collection_schedule_status')
    OR typeof(NEW.actor_id)!='text' OR lower(NEW.actor_id)='system' OR substr(lower(NEW.actor_id),1,7)='system:'
    OR length(NEW.actor_id) NOT BETWEEN 1 AND 160 OR length(CAST(NEW.actor_id AS BLOB))!=length(NEW.actor_id)
    OR NEW.actor_id GLOB '*[^!-~]*'
    OR length(trim(NEW.actor_id,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))=0
    OR NEW.ledger_revision IS NOT NULL OR typeof(NEW.payload_json)!='text' OR json_valid(NEW.payload_json) IS NOT 1
    OR json_type(NEW.payload_json) IS NOT 'object' OR (SELECT COUNT(*) FROM json_each(NEW.payload_json))!=3
    OR EXISTS(SELECT 1 FROM json_each(NEW.payload_json) WHERE key NOT IN ('actor_kind','input','result'))
    OR EXISTS(SELECT 1 FROM json_tree(NEW.payload_json) WHERE key IS NOT NULL AND typeof(key)='text' GROUP BY parent,key HAVING COUNT(*)>1)
    OR json_extract(NEW.payload_json,'$.actor_kind') IS NOT 'human'
    OR json_type(NEW.payload_json,'$.input') IS NOT 'object' OR (SELECT COUNT(*) FROM json_each(NEW.payload_json,'$.input'))!=7
    OR json_type(NEW.payload_json,'$.result') IS NOT 'object' OR (SELECT COUNT(*) FROM json_each(NEW.payload_json,'$.result'))!=7
    OR EXISTS(SELECT 1 FROM json_each(NEW.payload_json,'$.result') WHERE key NOT IN ('schedule_id','version_id','version','schedule_revision','status','scope_key','content_hash'))
    OR json_type(NEW.payload_json,'$.input.acknowledgement') IS NOT 'true'
    OR json_type(NEW.payload_json,'$.input.reason') IS NOT 'text'
    OR length(json_extract(NEW.payload_json,'$.input.reason')) NOT BETWEEN 1 AND 1000
    OR instr(json_extract(NEW.payload_json,'$.input.reason'),char(0))>0
    OR instr(json_extract(NEW.payload_json,'$.input.reason'),char(28))>0 OR instr(json_extract(NEW.payload_json,'$.input.reason'),char(29))>0
    OR instr(json_extract(NEW.payload_json,'$.input.reason'),char(30))>0 OR instr(json_extract(NEW.payload_json,'$.input.reason'),char(31))>0 OR instr(json_extract(NEW.payload_json,'$.input.reason'),char(133))>0
    OR length(trim(json_extract(NEW.payload_json,'$.input.reason'),char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))=0
    OR EXISTS(SELECT 1 FROM json_each(NEW.payload_json,'$.input') WHERE key IN ('portfolio_id','idempotency_key','schedule_id')
      AND (type!='text' OR length(value) NOT BETWEEN 1 AND 160 OR substr(value,1,1) NOT GLOB '[A-Za-z0-9]' OR value GLOB '*[^A-Za-z0-9_.:-]*'))
    OR json_extract(NEW.payload_json,'$.input.portfolio_id') IS NOT NEW.portfolio_id
    OR json_type(NEW.payload_json,'$.input.expected_schedule_revision') NOT IN ('integer','real')
    OR json_extract(NEW.payload_json,'$.input.expected_schedule_revision') NOT BETWEEN 0 AND 9007199254740991
    OR json_extract(NEW.payload_json,'$.input.expected_schedule_revision')!=CAST(json_extract(NEW.payload_json,'$.input.expected_schedule_revision') AS INTEGER)
    OR EXISTS(SELECT 1 FROM json_each(NEW.payload_json,'$.result') WHERE key IN ('version','schedule_revision')
      AND (type NOT IN ('integer','real') OR value NOT BETWEEN 1 AND 9007199254740991 OR value!=CAST(value AS INTEGER)))
    OR EXISTS(SELECT 1 FROM json_each(NEW.payload_json,'$.result') WHERE key NOT IN ('version','schedule_revision') AND type!='text')
    OR json_extract(NEW.payload_json,'$.result.status') NOT IN ('enabled','paused')
    THEN RAISE(ABORT,'price_collection audit requires strict human command evidence') END;
  SELECT CASE WHEN NEW.action='save_price_collection_schedule' AND (
    EXISTS(SELECT 1 FROM json_each(NEW.payload_json,'$.input') WHERE key NOT IN ('portfolio_id','idempotency_key','reason','acknowledgement','expected_schedule_revision','expected_schedule_id','definition_json'))
    OR NOT (json_type(NEW.payload_json,'$.input.expected_schedule_id') IS 'null' OR (json_type(NEW.payload_json,'$.input.expected_schedule_id') IS 'text'
      AND length(json_extract(NEW.payload_json,'$.input.expected_schedule_id')) BETWEEN 1 AND 160
      AND substr(json_extract(NEW.payload_json,'$.input.expected_schedule_id'),1,1) GLOB '[A-Za-z0-9]'
      AND json_extract(NEW.payload_json,'$.input.expected_schedule_id') NOT GLOB '*[^A-Za-z0-9_.:-]*'))
    OR json_type(NEW.payload_json,'$.input.definition_json') IS NOT 'text'
    OR length(CAST(json_extract(NEW.payload_json,'$.input.definition_json') AS BLOB)) NOT BETWEEN 1 AND 65536)
    THEN RAISE(ABORT,'price_collection save audit input is invalid') END;
  SELECT CASE WHEN NEW.action='set_price_collection_schedule_status' AND (
    EXISTS(SELECT 1 FROM json_each(NEW.payload_json,'$.input') WHERE key NOT IN ('portfolio_id','idempotency_key','reason','acknowledgement','expected_schedule_revision','schedule_id','status'))
    OR json_extract(NEW.payload_json,'$.input.expected_schedule_revision')<1
    OR json_type(NEW.payload_json,'$.input.status') IS NOT 'text'
    OR json_extract(NEW.payload_json,'$.input.status') NOT IN ('enabled','paused'))
    THEN RAISE(ABORT,'price_collection status audit input is invalid') END;
END;

CREATE TRIGGER price_collection_schedule_insert BEFORE INSERT ON price_collection_schedules BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM price_collection_schedules WHERE id=NEW.id OR (portfolio_id=NEW.portfolio_id AND scope_key=NEW.scope_key))
    THEN RAISE(ABORT,'price_collection schedule identity cannot be replaced') END;
END;
CREATE TRIGGER price_collection_schedule_no_update BEFORE UPDATE ON price_collection_schedules BEGIN SELECT RAISE(ABORT,'price_collection schedule identity is immutable'); END;
CREATE TRIGGER price_collection_schedule_no_delete BEFORE DELETE ON price_collection_schedules BEGIN SELECT RAISE(ABORT,'price_collection schedule identity is immutable'); END;

CREATE TRIGGER price_collection_version_insert BEFORE INSERT ON price_collection_schedule_versions BEGIN
  SELECT CASE WHEN NEW.version>1023 THEN RAISE(ABORT,'price_collection version proof budget exceeded') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM price_collection_schedule_versions WHERE id=NEW.id OR (schedule_id=NEW.schedule_id AND version=NEW.version) OR audit_id=NEW.audit_id)
    THEN RAISE(ABORT,'price_collection versions cannot be replaced') END;
  SELECT CASE WHEN NEW.version IS NOT (SELECT COALESCE(MAX(version),0)+1 FROM price_collection_schedule_versions WHERE schedule_id=NEW.schedule_id)
    THEN RAISE(ABORT,'price_collection version must advance once') END;
  SELECT CASE WHEN json_extract(NEW.definition_json,'$.schema_version') IS NOT 'price-collection-schedule-v1'
    OR json_extract(NEW.definition_json,'$.provider') IS NOT 'longport'
    OR json_extract(NEW.definition_json,'$.frequency') IS NOT 'daily'
    OR json_type(NEW.definition_json,'$.publish') IS NOT 'true'
    OR json_extract(NEW.definition_json,'$.missed_policy') IS NOT 'record_no_backfill'
    OR json_extract(NEW.definition_json,'$.market') NOT IN ('CN','HK','US')
    OR json_extract(NEW.definition_json,'$.timezone') IS NOT CASE json_extract(NEW.definition_json,'$.market') WHEN 'CN' THEN 'Asia/Shanghai' WHEN 'HK' THEN 'Asia/Hong_Kong' WHEN 'US' THEN 'America/New_York' END
    OR (SELECT COUNT(*) FROM json_each(NEW.definition_json))!=14
    OR EXISTS(SELECT 1 FROM json_each(NEW.definition_json) WHERE key NOT IN ('schema_version','provider','frequency','publish','market','timezone','mapping_version_ids','calendar_version_ids','start_date','end_date','trigger_local','deadline_seconds','max_attempts','missed_policy'))
    OR EXISTS(SELECT 1 FROM json_tree(NEW.definition_json) WHERE key IS NOT NULL AND typeof(key)='text' GROUP BY parent,key HAVING COUNT(*)>1)
    OR json_type(NEW.definition_json,'$.mapping_version_ids') IS NOT 'array'
    OR json_type(NEW.definition_json,'$.calendar_version_ids') IS NOT 'array'
    OR json_array_length(NEW.definition_json,'$.mapping_version_ids') NOT BETWEEN 1 AND 4
    OR json_array_length(NEW.definition_json,'$.calendar_version_ids') NOT BETWEEN 1 AND 4
    OR (SELECT COUNT(DISTINCT value) FROM json_each(NEW.definition_json,'$.mapping_version_ids'))!=json_array_length(NEW.definition_json,'$.mapping_version_ids')
    OR (SELECT COUNT(DISTINCT value) FROM json_each(NEW.definition_json,'$.calendar_version_ids'))!=json_array_length(NEW.definition_json,'$.calendar_version_ids')
    OR EXISTS(SELECT 1 FROM json_each(NEW.definition_json,'$.mapping_version_ids') WHERE type!='text' OR length(value) NOT BETWEEN 1 AND 160 OR substr(value,1,1) NOT GLOB '[A-Za-z0-9]' OR value GLOB '*[^A-Za-z0-9_.:-]*')
    OR EXISTS(SELECT 1 FROM json_each(NEW.definition_json,'$.calendar_version_ids') WHERE type!='text' OR length(value) NOT BETWEEN 1 AND 160 OR substr(value,1,1) NOT GLOB '[A-Za-z0-9]' OR value GLOB '*[^A-Za-z0-9_.:-]*')
    OR json_type(NEW.definition_json,'$.start_date') IS NOT 'text' OR length(json_extract(NEW.definition_json,'$.start_date'))!=10
    OR substr(json_extract(NEW.definition_json,'$.start_date'),1,4)='0000'
    OR date(json_extract(NEW.definition_json,'$.start_date'),'+0 days') IS NOT json_extract(NEW.definition_json,'$.start_date')
    OR json_type(NEW.definition_json,'$.end_date') IS NOT 'text' OR length(json_extract(NEW.definition_json,'$.end_date'))!=10
    OR date(json_extract(NEW.definition_json,'$.end_date'),'+0 days') IS NOT json_extract(NEW.definition_json,'$.end_date')
    OR json_extract(NEW.definition_json,'$.end_date')<json_extract(NEW.definition_json,'$.start_date')
    OR julianday(json_extract(NEW.definition_json,'$.end_date'))-julianday(json_extract(NEW.definition_json,'$.start_date'))>3659
    OR json_type(NEW.definition_json,'$.trigger_local') IS NOT 'object' OR (SELECT COUNT(*) FROM json_each(NEW.definition_json,'$.trigger_local'))!=2
    OR EXISTS(SELECT 1 FROM json_each(NEW.definition_json,'$.trigger_local') WHERE key NOT IN ('hour','minute') OR type NOT IN ('integer','real') OR value!=CAST(value AS INTEGER)
      OR (key='hour' AND value NOT BETWEEN 0 AND 23) OR (key='minute' AND value NOT BETWEEN 0 AND 59))
    OR json_type(NEW.definition_json,'$.deadline_seconds') NOT IN ('integer','real')
    OR json_extract(NEW.definition_json,'$.deadline_seconds') NOT BETWEEN 60 AND 86400
    OR json_extract(NEW.definition_json,'$.deadline_seconds')!=CAST(json_extract(NEW.definition_json,'$.deadline_seconds') AS INTEGER)
    OR json_type(NEW.definition_json,'$.max_attempts') NOT IN ('integer','real') OR json_extract(NEW.definition_json,'$.max_attempts') NOT BETWEEN 1 AND 5
    OR json_extract(NEW.definition_json,'$.max_attempts')!=CAST(json_extract(NEW.definition_json,'$.max_attempts') AS INTEGER)
    THEN RAISE(ABORT,'invalid price collection schedule definition') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM price_collection_schedules s WHERE s.id=NEW.schedule_id
    AND s.market=json_extract(NEW.definition_json,'$.market')
    AND json_extract(NEW.reference_binding_json,'$.schema_version')='price-schedule-reference-binding-v1'
    AND json_extract(NEW.reference_binding_json,'$.portfolio_id')=s.portfolio_id
    AND json_extract(NEW.reference_binding_json,'$.market')=s.market
    AND json_extract(NEW.reference_binding_json,'$.timezone')=json_extract(NEW.definition_json,'$.timezone')
    AND json_extract(NEW.reference_binding_json,'$.start_date')=json_extract(NEW.definition_json,'$.start_date')
    AND json_extract(NEW.reference_binding_json,'$.end_date')=json_extract(NEW.definition_json,'$.end_date')
    AND json_extract(NEW.reference_binding_json,'$.known_at')=NEW.created_at
    AND json_array_length(NEW.reference_binding_json,'$.mappings')=json_array_length(NEW.definition_json,'$.mapping_version_ids')
    AND json_array_length(NEW.reference_binding_json,'$.calendars')=json_array_length(NEW.definition_json,'$.calendar_version_ids')
    AND (NEW.version!=1 OR (s.created_by=NEW.created_by AND s.created_at=NEW.created_at)))
    THEN RAISE(ABORT,'price collection definition binding mismatch') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM audit_events a JOIN price_collection_schedules s ON s.id=NEW.schedule_id
    WHERE a.id=NEW.audit_id AND a.action='save_price_collection_schedule' AND a.object_type='price_collection_schedule' AND a.object_id=s.id
    AND a.portfolio_id=s.portfolio_id AND a.actor_id=NEW.created_by AND a.ledger_revision IS NULL AND a.created_at=NEW.created_at
    AND json_extract(a.payload_json,'$.actor_kind') IS 'human' AND json_extract(a.payload_json,'$.input.portfolio_id') IS s.portfolio_id
    AND json_type(a.payload_json,'$.input.acknowledgement') IS 'true'
    AND json_extract(a.payload_json,'$.input.expected_schedule_id') IS CASE WHEN NEW.version=1 THEN NULL ELSE s.id END
    AND json_type(a.payload_json,'$.input.expected_schedule_id') IS CASE WHEN NEW.version=1 THEN 'null' ELSE 'text' END
    AND json_extract(a.payload_json,'$.input.expected_schedule_revision') IS COALESCE((SELECT revision FROM price_collection_schedule_heads WHERE schedule_id=s.id),0)
    AND json_extract(a.payload_json,'$.input.definition_json') IS NEW.definition_json
    AND json_extract(a.payload_json,'$.result.schedule_id') IS s.id AND json_extract(a.payload_json,'$.result.version_id') IS NEW.id
    AND json_extract(a.payload_json,'$.result.version') IS NEW.version AND json_extract(a.payload_json,'$.result.status') IS 'paused'
    AND json_extract(a.payload_json,'$.result.schedule_revision') IS COALESCE((SELECT revision+1 FROM price_collection_schedule_heads WHERE schedule_id=s.id),1)
    AND json_extract(a.payload_json,'$.result.scope_key') IS s.scope_key AND json_extract(a.payload_json,'$.result.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'price_collection version requires matching human save audit') END;
END;
CREATE TRIGGER price_collection_version_no_update BEFORE UPDATE ON price_collection_schedule_versions BEGIN SELECT RAISE(ABORT,'price_collection versions are append-only'); END;
CREATE TRIGGER price_collection_version_no_delete BEFORE DELETE ON price_collection_schedule_versions BEGIN SELECT RAISE(ABORT,'price_collection versions are append-only'); END;

CREATE TRIGGER price_collection_control_insert BEFORE INSERT ON price_collection_schedule_controls BEGIN
  SELECT CASE WHEN NEW.revision>1024 OR (NEW.revision=1024 AND (NEW.status!='paused'
    OR NOT EXISTS(SELECT 1 FROM price_collection_schedule_heads h JOIN audit_events a ON a.id=NEW.audit_id
      WHERE h.schedule_id=NEW.schedule_id AND h.revision=1023 AND h.status='enabled'
      AND a.action='set_price_collection_schedule_status')))
    THEN RAISE(ABORT,'price_collection control proof budget reserves final pause') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM price_collection_schedule_controls WHERE (schedule_id=NEW.schedule_id AND revision=NEW.revision) OR audit_id=NEW.audit_id)
    THEN RAISE(ABORT,'price_collection controls cannot be replaced') END;
  SELECT CASE WHEN NEW.revision IS NOT (SELECT COALESCE(MAX(revision),0)+1 FROM price_collection_schedule_controls WHERE schedule_id=NEW.schedule_id)
    OR (NEW.revision>1 AND NOT EXISTS(SELECT 1 FROM price_collection_schedule_heads h WHERE h.schedule_id=NEW.schedule_id AND h.revision=NEW.revision-1 AND h.updated_at<=NEW.created_at))
    THEN RAISE(ABORT,'price_collection control CAS mismatch') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM price_collection_schedules s JOIN price_collection_schedule_versions v ON v.id=NEW.version_id AND v.schedule_id=s.id
    JOIN audit_events a ON a.id=NEW.audit_id LEFT JOIN price_collection_schedule_heads h ON h.schedule_id=s.id
    LEFT JOIN price_collection_schedule_versions old ON old.id=h.current_version_id
    WHERE s.id=NEW.schedule_id AND a.portfolio_id=s.portfolio_id AND a.object_type='price_collection_schedule' AND a.object_id=s.id
    AND length(trim(a.actor_id))>0 AND a.ledger_revision IS NULL AND a.created_at=NEW.created_at AND v.created_at<=NEW.created_at
    AND json_extract(a.payload_json,'$.actor_kind') IS 'human' AND json_extract(a.payload_json,'$.input.portfolio_id') IS s.portfolio_id
    AND json_type(a.payload_json,'$.input.acknowledgement') IS 'true'
    AND json_extract(a.payload_json,'$.input.expected_schedule_revision') IS NEW.revision-1
    AND json_extract(a.payload_json,'$.result.schedule_id') IS s.id AND json_extract(a.payload_json,'$.result.version_id') IS v.id
    AND json_extract(a.payload_json,'$.result.version') IS v.version AND json_extract(a.payload_json,'$.result.schedule_revision') IS NEW.revision
    AND json_extract(a.payload_json,'$.result.status') IS NEW.status AND json_extract(a.payload_json,'$.result.scope_key') IS s.scope_key
    AND json_extract(a.payload_json,'$.result.content_hash') IS v.content_hash
    AND ((a.action='save_price_collection_schedule' AND v.audit_id=a.id AND NEW.status='paused' AND v.created_at=NEW.created_at
      AND ((NEW.revision=1 AND v.version=1) OR (NEW.revision>1 AND v.version=old.version+1)))
      OR (a.action='set_price_collection_schedule_status' AND NEW.revision>1 AND NEW.version_id=h.current_version_id
        AND json_extract(a.payload_json,'$.input.schedule_id') IS s.id AND json_extract(a.payload_json,'$.input.status') IS NEW.status)))
    THEN RAISE(ABORT,'price_collection control requires matching human audit') END;
END;
CREATE TRIGGER price_collection_control_no_update BEFORE UPDATE ON price_collection_schedule_controls BEGIN SELECT RAISE(ABORT,'price_collection controls are append-only'); END;
CREATE TRIGGER price_collection_control_no_delete BEFORE DELETE ON price_collection_schedule_controls BEGIN SELECT RAISE(ABORT,'price_collection controls are append-only'); END;

CREATE TRIGGER price_collection_head_insert BEFORE INSERT ON price_collection_schedule_heads BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM price_collection_schedule_heads WHERE schedule_id=NEW.schedule_id OR (scope_key=NEW.scope_key AND status='enabled' AND NEW.status='enabled'))
    THEN RAISE(ABORT,'price_collection schedule heads cannot be replaced') END;
  SELECT CASE WHEN NEW.revision IS NOT 1 OR NEW.status IS NOT 'paused' THEN RAISE(ABORT,'price_collection schedule must start paused') END;
END;
CREATE TRIGGER price_collection_head_update BEFORE UPDATE ON price_collection_schedule_heads BEGIN
  SELECT CASE WHEN NEW.status='enabled' AND EXISTS(SELECT 1 FROM price_collection_schedule_heads WHERE scope_key=NEW.scope_key
    AND status='enabled' AND schedule_id!=OLD.schedule_id) THEN RAISE(ABORT,'price_collection scope already enabled') END;
  SELECT CASE WHEN NEW.schedule_id IS NOT OLD.schedule_id OR NEW.scope_key IS NOT OLD.scope_key OR NEW.revision IS NOT OLD.revision+1
    OR NEW.updated_at<OLD.updated_at OR NEW.revision IS NOT (SELECT MAX(revision) FROM price_collection_schedule_controls WHERE schedule_id=NEW.schedule_id)
    THEN RAISE(ABORT,'price_collection head CAS mismatch') END;
END;
CREATE TRIGGER price_collection_head_no_delete BEFORE DELETE ON price_collection_schedule_heads BEGIN SELECT RAISE(ABORT,'price_collection heads cannot be deleted'); END;

CREATE TRIGGER price_collection_slot_insert BEFORE INSERT ON price_collection_schedule_slots BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM price_collection_schedule_slots WHERE id=NEW.id OR (scope_key=NEW.scope_key AND period=NEW.period) OR command_request_id=NEW.command_request_id)
    THEN RAISE(ABORT,'price collection daily slot cannot be replaced') END;
  SELECT CASE WHEN length(NEW.scheduled_at)!=27 OR length(NEW.deadline_at)!=27
    OR substr(NEW.scheduled_at,20,1)!='.' OR substr(NEW.scheduled_at,27,1)!='Z'
    OR substr(NEW.scheduled_at,21,6) GLOB '*[^0-9]*'
    OR strftime('%Y-%m-%dT%H:%M:%S',substr(NEW.scheduled_at,1,19)) IS NOT substr(NEW.scheduled_at,1,19)
    OR NEW.created_at<NEW.scheduled_at
    OR NOT EXISTS(SELECT 1 FROM price_collection_schedule_controls c JOIN price_collection_schedule_versions v ON v.id=c.version_id
      WHERE c.schedule_id=NEW.schedule_id AND c.revision=NEW.authorization_revision AND c.audit_id=NEW.authorization_audit_id
      AND c.version_id=NEW.schedule_version_id AND c.status='enabled' AND c.created_at<=NEW.scheduled_at
      AND NOT EXISTS(SELECT 1 FROM price_collection_schedule_controls later WHERE later.schedule_id=c.schedule_id AND later.revision>c.revision AND later.created_at<=NEW.scheduled_at)
      AND NEW.period BETWEEN json_extract(v.definition_json,'$.start_date') AND json_extract(v.definition_json,'$.end_date')
      AND NEW.reference_binding_json IS v.reference_binding_json AND NEW.reference_binding_hash IS v.reference_binding_hash
      AND NEW.deadline_at=strftime('%Y-%m-%dT%H:%M:%S',substr(NEW.scheduled_at,1,19),'+' || CAST(json_extract(v.definition_json,'$.deadline_seconds') AS INTEGER) || ' seconds') || '.000000Z')
    THEN RAISE(ABORT,'price collection slot requires frozen due authorization') END;
  SELECT CASE WHEN NEW.disposition!='missed' AND (NEW.created_at>=NEW.deadline_at
    OR NOT EXISTS(SELECT 1 FROM price_collection_schedule_heads h WHERE h.schedule_id=NEW.schedule_id AND h.revision=NEW.authorization_revision
      AND h.current_version_id=NEW.schedule_version_id AND h.last_audit_id=NEW.authorization_audit_id AND h.status='enabled'))
    THEN RAISE(ABORT,'price collection slot requires current authorization') END;
  SELECT CASE WHEN NEW.disposition='requested' AND (NEW.expected_publication_revision IS NOT COALESCE((SELECT revision FROM market_publications WHERE scope=NEW.scope_key),0)
    OR NOT EXISTS(SELECT 1 FROM command_requests r JOIN price_collection_schedule_versions v ON v.id=NEW.schedule_version_id
      WHERE r.id=NEW.command_request_id AND r.portfolio_id=NEW.portfolio_id AND r.command_type='market_collect_prices'
      AND r.actor_id='system:price-collection-discovery' AND r.created_at=NEW.created_at
      AND r.idempotency_key='price-collection:' || NEW.id
      AND json_valid(r.payload_json) AND json_type(r.payload_json)='object' AND (SELECT COUNT(*) FROM json_each(r.payload_json))=8
      AND json_extract(r.payload_json,'$.schema_version') IS 'market-price-collect-v1'
      AND json_extract(r.payload_json,'$.provider') IS 'longport' AND json_type(r.payload_json,'$.publish') IS 'true'
      AND json_extract(r.payload_json,'$.start_date') IS NEW.period AND json_extract(r.payload_json,'$.end_date') IS NEW.period
      AND json_type(r.payload_json,'$.expected_publication_revision') IS 'integer'
      AND json_extract(r.payload_json,'$.expected_publication_revision') IS NEW.expected_publication_revision
      AND json_extract(r.payload_json,'$.mapping_version_ids') IS json_extract(v.definition_json,'$.mapping_version_ids')
      AND json_extract(r.payload_json,'$.calendar_version_ids') IS json_extract(v.definition_json,'$.calendar_version_ids')))
    THEN RAISE(ABORT,'requested price collection slot requires current scoped command') END;
  SELECT CASE WHEN NEW.disposition IN ('requested','skipped') OR (NEW.disposition='blocked' AND NEW.reason_code='MIXED_CALENDAR_SESSION') THEN
    CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.reference_binding_json,'$.heads') p
      WHERE NOT EXISTS(SELECT 1 FROM market_reference_heads h WHERE h.portfolio_id=NEW.portfolio_id
        AND h.kind=json_extract(p.value,'$.kind') AND h.scope_key=json_extract(p.value,'$.scope_key')
        AND h.version_id=json_extract(p.value,'$.version_id') AND h.version=json_extract(p.value,'$.version')
        AND h.updated_at=json_extract(p.value,'$.updated_at')))
      THEN RAISE(ABORT,'price collection slot references are no longer current') END END;
  SELECT CASE WHEN NEW.disposition='missed' AND NOT ((NEW.reason_code='DEADLINE_EXPIRED' AND NEW.created_at>=NEW.deadline_at
      AND NOT EXISTS(SELECT 1 FROM price_collection_schedule_controls c WHERE c.schedule_id=NEW.schedule_id
        AND c.revision>NEW.authorization_revision AND c.created_at<NEW.deadline_at))
    OR (NEW.reason_code='AUTHORIZATION_ENDED' AND EXISTS(SELECT 1 FROM price_collection_schedule_controls c WHERE c.schedule_id=NEW.schedule_id
      AND c.revision>NEW.authorization_revision AND c.created_at<NEW.deadline_at AND c.created_at<=NEW.created_at)))
    THEN RAISE(ABORT,'missed price collection slot requires elapsed authorization or deadline') END;
  SELECT CASE WHEN NEW.disposition IN ('requested','skipped') OR (NEW.disposition='blocked' AND NEW.reason_code='MIXED_CALENDAR_SESSION') THEN
    CASE WHEN (SELECT COUNT(*) FROM json_each(NEW.reference_binding_json,'$.mappings') m
      JOIN market_reference_versions v ON v.id=json_extract(m.value,'$.calendar_version_id')
      JOIN json_each(v.document_json,'$.facts.days') d WHERE json_extract(d.value,'$.date')=NEW.period
      AND json_extract(d.value,'$.kind') IN ('full','half','closed'))!=json_array_length(NEW.reference_binding_json,'$.mappings')
      THEN RAISE(ABORT,'price collection slot needs every reviewed calendar day') END END;
  SELECT CASE WHEN NEW.disposition='requested' AND EXISTS(SELECT 1 FROM json_each(NEW.reference_binding_json,'$.mappings') m
      JOIN market_reference_versions v ON v.id=json_extract(m.value,'$.calendar_version_id')
      JOIN json_each(v.document_json,'$.facts.days') d WHERE json_extract(d.value,'$.date')=NEW.period AND json_extract(d.value,'$.kind')='closed')
    THEN RAISE(ABORT,'requested price collection slot requires complete open sessions') END;
  SELECT CASE WHEN NEW.disposition='skipped' AND (SELECT COUNT(*) FROM json_each(NEW.reference_binding_json,'$.mappings') m
      JOIN market_reference_versions v ON v.id=json_extract(m.value,'$.calendar_version_id')
      JOIN json_each(v.document_json,'$.facts.days') d WHERE json_extract(d.value,'$.date')=NEW.period AND json_extract(d.value,'$.kind')='closed')!=json_array_length(NEW.reference_binding_json,'$.mappings')
    THEN RAISE(ABORT,'skipped price collection slot requires all sessions closed') END;
  SELECT CASE WHEN NEW.disposition='blocked' AND NEW.reason_code='MIXED_CALENDAR_SESSION' AND
    (SELECT COUNT(*) FROM json_each(NEW.reference_binding_json,'$.mappings') m
      JOIN market_reference_versions v ON v.id=json_extract(m.value,'$.calendar_version_id')
      JOIN json_each(v.document_json,'$.facts.days') d WHERE json_extract(d.value,'$.date')=NEW.period AND json_extract(d.value,'$.kind')='closed')
      NOT BETWEEN 1 AND json_array_length(NEW.reference_binding_json,'$.mappings')-1
    THEN RAISE(ABORT,'mixed price collection slot requires both open and closed sessions') END;
  SELECT CASE WHEN NEW.disposition='blocked' AND NEW.reason_code='REFERENCE_CHANGED' AND NOT EXISTS(
    SELECT 1 FROM json_each(NEW.reference_binding_json,'$.heads') p WHERE NOT EXISTS(
      SELECT 1 FROM market_reference_heads h WHERE h.portfolio_id=NEW.portfolio_id AND h.kind=json_extract(p.value,'$.kind')
        AND h.scope_key=json_extract(p.value,'$.scope_key') AND h.version_id=json_extract(p.value,'$.version_id')
        AND h.version=json_extract(p.value,'$.version') AND h.updated_at=json_extract(p.value,'$.updated_at')))
    THEN RAISE(ABORT,'changed reference slot requires changed reviewed heads') END;
END;
CREATE TRIGGER price_collection_slot_no_update BEFORE UPDATE ON price_collection_schedule_slots BEGIN SELECT RAISE(ABORT,'price collection slots are append-only'); END;
CREATE TRIGGER price_collection_slot_no_delete BEFORE DELETE ON price_collection_schedule_slots BEGIN SELECT RAISE(ABORT,'price collection slots are append-only'); END;

CREATE TRIGGER price_collection_audit_no_replace BEFORE INSERT ON audit_events
WHEN EXISTS(SELECT 1 FROM audit_events a WHERE a.id=NEW.id AND (a.object_type='price_collection_schedule'
  OR EXISTS(SELECT 1 FROM price_collection_schedule_controls c WHERE c.audit_id=a.id)))
BEGIN SELECT RAISE(ABORT,'price collection audit cannot be replaced'); END;
CREATE TRIGGER price_collection_command_no_replace BEFORE INSERT ON command_requests
WHEN EXISTS(SELECT 1 FROM command_requests c WHERE (c.id=NEW.id OR (c.portfolio_id=NEW.portfolio_id AND c.command_type=NEW.command_type AND c.idempotency_key=NEW.idempotency_key))
  AND (c.actor_id='system:price-collection-discovery' OR NEW.actor_id='system:price-collection-discovery'
    OR EXISTS(SELECT 1 FROM price_collection_schedule_slots s WHERE s.command_request_id=c.id)))
BEGIN SELECT RAISE(ABORT,'price collection requests cannot be replaced'); END;
CREATE TRIGGER price_collection_command_no_update BEFORE UPDATE ON command_requests
WHEN OLD.actor_id='system:price-collection-discovery' OR NEW.actor_id='system:price-collection-discovery'
  OR EXISTS(SELECT 1 FROM price_collection_schedule_slots WHERE command_request_id=OLD.id OR command_request_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'price collection requests are immutable'); END;
CREATE TRIGGER price_collection_command_no_delete BEFORE DELETE ON command_requests
WHEN OLD.actor_id='system:price-collection-discovery' OR EXISTS(SELECT 1 FROM price_collection_schedule_slots WHERE command_request_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'price collection requests are immutable'); END;
CREATE TRIGGER price_collection_job_insert BEFORE INSERT ON job_runs
WHEN EXISTS(SELECT 1 FROM command_requests WHERE id=NEW.command_request_id AND actor_id='system:price-collection-discovery')
  OR EXISTS(SELECT 1 FROM price_collection_schedule_slots WHERE command_request_id=NEW.command_request_id)
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM price_collection_schedule_slots s JOIN command_requests c ON c.id=s.command_request_id
    JOIN price_collection_schedule_versions v ON v.id=s.schedule_version_id
    WHERE s.command_request_id=NEW.command_request_id AND s.disposition='requested' AND NEW.job_type='market_collect_prices'
      AND NEW.scope=s.portfolio_id AND NEW.period=s.period AND NEW.input_version=c.id || ':' || c.payload_hash
      AND NEW.max_attempts=json_extract(v.definition_json,'$.max_attempts'))
    THEN RAISE(ABORT,'price collection job requires immutable slot binding') END;
END;
CREATE TRIGGER price_collection_job_identity BEFORE UPDATE ON job_runs
WHEN EXISTS(SELECT 1 FROM price_collection_schedule_slots WHERE command_request_id=OLD.command_request_id OR command_request_id=NEW.command_request_id)
BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.command_request_id IS NOT OLD.command_request_id OR NEW.job_type IS NOT OLD.job_type
    OR NEW.scope IS NOT OLD.scope OR NEW.period IS NOT OLD.period OR NEW.input_version IS NOT OLD.input_version
    OR NEW.max_attempts IS NOT OLD.max_attempts OR NEW.created_at IS NOT OLD.created_at
    THEN RAISE(ABORT,'price collection job identity is immutable') END;
END;
CREATE TRIGGER price_collection_job_no_replace BEFORE INSERT ON job_runs
WHEN EXISTS(SELECT 1 FROM job_runs j JOIN price_collection_schedule_slots s ON s.command_request_id=j.command_request_id
  WHERE j.id=NEW.id OR j.command_request_id=NEW.command_request_id
    OR (j.job_type=NEW.job_type AND j.scope=NEW.scope AND j.period=NEW.period AND j.input_version=NEW.input_version))
BEGIN SELECT RAISE(ABORT,'price collection jobs cannot be replaced'); END;
CREATE TRIGGER price_collection_job_no_delete BEFORE DELETE ON job_runs
WHEN EXISTS(SELECT 1 FROM price_collection_schedule_slots WHERE command_request_id=OLD.command_request_id)
BEGIN SELECT RAISE(ABORT,'price collection jobs cannot be deleted'); END;
