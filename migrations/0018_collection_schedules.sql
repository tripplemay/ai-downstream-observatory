CREATE TABLE collection_schedules (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id)) BETWEEN 1 AND 160),
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  provider TEXT NOT NULL CHECK(provider='ecb'),
  scope_key TEXT NOT NULL CHECK(length(scope_key) BETWEEN 24 AND 160 AND scope_key LIKE 'provider:ecb:fx:daily:%'),
  created_by TEXT NOT NULL CHECK(length(trim(created_by)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL CHECK(length(created_at)=27 AND substr(created_at,20,1)='.' AND substr(created_at,27,1)='Z'
    AND substr(created_at,21,6) NOT GLOB '*[^0-9]*' AND substr(created_at,1,4)!='0000'
    AND strftime('%Y-%m-%dT%H:%M:%S',substr(created_at,1,19)) IS substr(created_at,1,19)),
  UNIQUE(portfolio_id,scope_key), UNIQUE(id,portfolio_id,scope_key), UNIQUE(id,scope_key)
);

CREATE TABLE collection_schedule_versions (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id)) BETWEEN 1 AND 160),
  schedule_id TEXT NOT NULL REFERENCES collection_schedules(id),
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  definition_json TEXT NOT NULL CHECK(typeof(definition_json)='text' AND json_valid(definition_json)
    AND json_type(definition_json)='object' AND length(CAST(definition_json AS BLOB)) BETWEEN 1 AND 65536),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  created_by TEXT NOT NULL CHECK(length(trim(created_by)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL CHECK(length(created_at)=27 AND substr(created_at,20,1)='.' AND substr(created_at,27,1)='Z'
    AND substr(created_at,21,6) NOT GLOB '*[^0-9]*' AND substr(created_at,1,4)!='0000'
    AND strftime('%Y-%m-%dT%H:%M:%S',substr(created_at,1,19)) IS substr(created_at,1,19)),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(schedule_id,version), UNIQUE(id,schedule_id)
);

CREATE TABLE collection_schedule_controls (
  schedule_id TEXT NOT NULL REFERENCES collection_schedules(id),
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
  FOREIGN KEY(version_id,schedule_id) REFERENCES collection_schedule_versions(id,schedule_id)
);
CREATE INDEX collection_control_history ON collection_schedule_controls(schedule_id,created_at,revision);

CREATE TABLE collection_schedule_heads (
  schedule_id TEXT PRIMARY KEY NOT NULL,
  scope_key TEXT NOT NULL,
  current_version_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL CHECK(status IN ('paused','enabled')),
  last_audit_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(schedule_id,scope_key) REFERENCES collection_schedules(id,scope_key),
  FOREIGN KEY(schedule_id,revision,current_version_id,status,last_audit_id,updated_at)
    REFERENCES collection_schedule_controls(schedule_id,revision,version_id,status,audit_id,created_at)
);
CREATE UNIQUE INDEX collection_enabled_scope ON collection_schedule_heads(scope_key) WHERE status='enabled';
CREATE INDEX collection_schedule_due ON collection_schedule_heads(status,schedule_id);

CREATE TABLE collection_schedule_slots (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id)) BETWEEN 1 AND 160),
  portfolio_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
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
  disposition TEXT NOT NULL CHECK(disposition IN ('requested','missed')),
  reason_code TEXT,
  command_request_id TEXT UNIQUE REFERENCES command_requests(id),
  expected_publication_revision INTEGER CHECK(expected_publication_revision IS NULL
    OR (typeof(expected_publication_revision)='integer' AND expected_publication_revision BETWEEN 0 AND 9007199254740991)),
  UNIQUE(scope_key,period),
  FOREIGN KEY(schedule_id,portfolio_id,scope_key) REFERENCES collection_schedules(id,portfolio_id,scope_key),
  FOREIGN KEY(schedule_version_id,schedule_id) REFERENCES collection_schedule_versions(id,schedule_id),
  FOREIGN KEY(schedule_id,authorization_revision,schedule_version_id,authorization_audit_id)
    REFERENCES collection_schedule_controls(schedule_id,revision,version_id,audit_id),
  CHECK((disposition='requested' AND reason_code IS NULL AND command_request_id IS NOT NULL AND expected_publication_revision IS NOT NULL)
    OR (disposition='missed' AND reason_code IN ('DEADLINE_EXPIRED','AUTHORIZATION_ENDED') AND reason_code IS NOT NULL
      AND command_request_id IS NULL AND expected_publication_revision IS NULL))
);
CREATE INDEX collection_slot_history ON collection_schedule_slots(portfolio_id,period DESC,id DESC);
CREATE INDEX collection_slot_schedule ON collection_schedule_slots(schedule_id,period);

-- Full UTF-16 string limits and raw hashes are independently rechecked by both readers.
CREATE TRIGGER collection_audit_insert BEFORE INSERT ON audit_events
WHEN NEW.object_type='collection_schedule' OR NEW.action IN ('save_collection_schedule','set_collection_schedule_status') BEGIN
  SELECT CASE WHEN NEW.object_type IS NOT 'collection_schedule'
    OR NEW.action NOT IN ('save_collection_schedule','set_collection_schedule_status')
    OR typeof(NEW.actor_id)!='text' OR substr(NEW.actor_id,1,7)='system:'
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
    OR length(json_extract(NEW.payload_json,'$.input.reason')) NOT BETWEEN 1 AND 2000
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
    THEN RAISE(ABORT,'collection audit requires strict human command evidence') END;
  SELECT CASE WHEN NEW.action='save_collection_schedule' AND (
    EXISTS(SELECT 1 FROM json_each(NEW.payload_json,'$.input') WHERE key NOT IN ('portfolio_id','idempotency_key','reason','acknowledgement','expected_schedule_revision','expected_schedule_id','definition_json'))
    OR NOT (json_type(NEW.payload_json,'$.input.expected_schedule_id') IS 'null' OR (json_type(NEW.payload_json,'$.input.expected_schedule_id') IS 'text'
      AND length(json_extract(NEW.payload_json,'$.input.expected_schedule_id')) BETWEEN 1 AND 160
      AND substr(json_extract(NEW.payload_json,'$.input.expected_schedule_id'),1,1) GLOB '[A-Za-z0-9]'
      AND json_extract(NEW.payload_json,'$.input.expected_schedule_id') NOT GLOB '*[^A-Za-z0-9_.:-]*'))
    OR json_type(NEW.payload_json,'$.input.definition_json') IS NOT 'text'
    OR length(CAST(json_extract(NEW.payload_json,'$.input.definition_json') AS BLOB)) NOT BETWEEN 1 AND 65536)
    THEN RAISE(ABORT,'collection save audit input is invalid') END;
  SELECT CASE WHEN NEW.action='set_collection_schedule_status' AND (
    EXISTS(SELECT 1 FROM json_each(NEW.payload_json,'$.input') WHERE key NOT IN ('portfolio_id','idempotency_key','reason','acknowledgement','expected_schedule_revision','schedule_id','status'))
    OR json_extract(NEW.payload_json,'$.input.expected_schedule_revision')<1
    OR json_type(NEW.payload_json,'$.input.status') IS NOT 'text'
    OR json_extract(NEW.payload_json,'$.input.status') NOT IN ('enabled','paused'))
    THEN RAISE(ABORT,'collection status audit input is invalid') END;
END;

CREATE TRIGGER collection_schedule_insert BEFORE INSERT ON collection_schedules BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM collection_schedules WHERE id=NEW.id OR (portfolio_id=NEW.portfolio_id AND scope_key=NEW.scope_key))
    THEN RAISE(ABORT,'collection schedule identity cannot be replaced') END;
END;
CREATE TRIGGER collection_schedule_no_update BEFORE UPDATE ON collection_schedules BEGIN SELECT RAISE(ABORT,'collection schedule identity is immutable'); END;
CREATE TRIGGER collection_schedule_no_delete BEFORE DELETE ON collection_schedules BEGIN SELECT RAISE(ABORT,'collection schedule identity is immutable'); END;

CREATE TRIGGER collection_version_insert BEFORE INSERT ON collection_schedule_versions BEGIN
  SELECT CASE WHEN NEW.version>1023 THEN RAISE(ABORT,'collection version proof budget exceeded') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM collection_schedule_versions WHERE id=NEW.id OR (schedule_id=NEW.schedule_id AND version=NEW.version) OR audit_id=NEW.audit_id)
    THEN RAISE(ABORT,'collection versions cannot be replaced') END;
  SELECT CASE WHEN NEW.version IS NOT (SELECT COALESCE(MAX(version),0)+1 FROM collection_schedule_versions WHERE schedule_id=NEW.schedule_id)
    THEN RAISE(ABORT,'collection version must advance once') END;
  SELECT CASE WHEN json_valid(NEW.definition_json) IS NOT 1 OR json_type(NEW.definition_json) IS NOT 'object'
    OR json_extract(NEW.definition_json,'$.schema_version') IS NOT 'collection-schedule-v1'
    OR json_extract(NEW.definition_json,'$.provider') IS NOT 'ecb' OR json_extract(NEW.definition_json,'$.feed') IS NOT 'daily'
    OR json_extract(NEW.definition_json,'$.frequency') IS NOT 'daily' OR json_extract(NEW.definition_json,'$.timezone') IS NOT 'UTC'
    OR json_type(NEW.definition_json,'$.publish') IS NOT 'true' OR json_extract(NEW.definition_json,'$.missed_policy') IS NOT 'record_no_backfill'
    OR (SELECT COUNT(*) FROM json_each(NEW.definition_json))!=13
    OR EXISTS(SELECT 1 FROM json_each(NEW.definition_json) WHERE key NOT IN ('schema_version','provider','feed','currencies','frequency','timezone','start_date','end_date','trigger','deadline_seconds','max_attempts','publish','missed_policy'))
    OR EXISTS(SELECT 1 FROM json_tree(NEW.definition_json) WHERE key IS NOT NULL AND typeof(key)='text' GROUP BY parent,key HAVING COUNT(*)>1)
    OR json_type(NEW.definition_json,'$.currencies') IS NOT 'array'
    OR json_array_length(NEW.definition_json,'$.currencies') NOT BETWEEN 1 AND 8
    OR EXISTS(SELECT 1 FROM json_each(NEW.definition_json,'$.currencies') WHERE type!='text' OR value NOT IN ('CNY','HKD','USD','EUR','GBP','JPY','CHF','SGD'))
    OR (SELECT COUNT(DISTINCT value) FROM json_each(NEW.definition_json,'$.currencies')) IS NOT json_array_length(NEW.definition_json,'$.currencies')
    OR json_type(NEW.definition_json,'$.start_date') IS NOT 'text' OR length(json_extract(NEW.definition_json,'$.start_date'))!=10
    OR substr(json_extract(NEW.definition_json,'$.start_date'),1,4)='0000'
    OR date(json_extract(NEW.definition_json,'$.start_date'),'+0 days') IS NOT json_extract(NEW.definition_json,'$.start_date')
    OR NOT (json_type(NEW.definition_json,'$.end_date') IS 'null' OR (json_type(NEW.definition_json,'$.end_date') IS 'text'
      AND length(json_extract(NEW.definition_json,'$.end_date'))=10 AND date(json_extract(NEW.definition_json,'$.end_date'),'+0 days') IS json_extract(NEW.definition_json,'$.end_date')
      AND json_extract(NEW.definition_json,'$.end_date')>=json_extract(NEW.definition_json,'$.start_date')))
    OR json_type(NEW.definition_json,'$.trigger') IS NOT 'object' OR (SELECT COUNT(*) FROM json_each(NEW.definition_json,'$.trigger'))!=2
    OR EXISTS(SELECT 1 FROM json_each(NEW.definition_json,'$.trigger') WHERE key NOT IN ('hour','minute') OR type NOT IN ('integer','real') OR value!=CAST(value AS INTEGER)
      OR (key='hour' AND value NOT BETWEEN 0 AND 23) OR (key='minute' AND value NOT BETWEEN 0 AND 59))
    OR json_type(NEW.definition_json,'$.deadline_seconds') NOT IN ('integer','real')
    OR json_extract(NEW.definition_json,'$.deadline_seconds') NOT BETWEEN 60 AND 86400
    OR json_extract(NEW.definition_json,'$.deadline_seconds')!=CAST(json_extract(NEW.definition_json,'$.deadline_seconds') AS INTEGER)
    OR json_type(NEW.definition_json,'$.max_attempts') NOT IN ('integer','real') OR json_extract(NEW.definition_json,'$.max_attempts') NOT BETWEEN 1 AND 5
    OR json_extract(NEW.definition_json,'$.max_attempts')!=CAST(json_extract(NEW.definition_json,'$.max_attempts') AS INTEGER)
    THEN RAISE(ABORT,'invalid collection schedule definition') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM collection_schedules s WHERE s.id=NEW.schedule_id
    AND s.scope_key='provider:ecb:fx:daily:' || (SELECT group_concat(value,'-') FROM (SELECT value FROM json_each(NEW.definition_json,'$.currencies') ORDER BY value COLLATE BINARY))
    AND (NEW.version!=1 OR (s.created_by=NEW.created_by AND s.created_at=NEW.created_at)))
    THEN RAISE(ABORT,'collection definition scope mismatch') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM audit_events a JOIN collection_schedules s ON s.id=NEW.schedule_id
    WHERE a.id=NEW.audit_id AND a.action='save_collection_schedule' AND a.object_type='collection_schedule' AND a.object_id=s.id
    AND a.portfolio_id=s.portfolio_id AND a.actor_id=NEW.created_by AND a.ledger_revision IS NULL AND a.created_at=NEW.created_at
    AND json_extract(a.payload_json,'$.actor_kind') IS 'human' AND json_extract(a.payload_json,'$.input.portfolio_id') IS s.portfolio_id
    AND json_type(a.payload_json,'$.input.acknowledgement') IS 'true'
    AND json_extract(a.payload_json,'$.input.expected_schedule_id') IS CASE WHEN NEW.version=1 THEN NULL ELSE s.id END
    AND json_type(a.payload_json,'$.input.expected_schedule_id') IS CASE WHEN NEW.version=1 THEN 'null' ELSE 'text' END
    AND json_extract(a.payload_json,'$.input.expected_schedule_revision') IS COALESCE((SELECT revision FROM collection_schedule_heads WHERE schedule_id=s.id),0)
    AND json_extract(a.payload_json,'$.input.definition_json') IS NEW.definition_json
    AND json_extract(a.payload_json,'$.result.schedule_id') IS s.id AND json_extract(a.payload_json,'$.result.version_id') IS NEW.id
    AND json_extract(a.payload_json,'$.result.version') IS NEW.version AND json_extract(a.payload_json,'$.result.status') IS 'paused'
    AND json_extract(a.payload_json,'$.result.schedule_revision') IS COALESCE((SELECT revision+1 FROM collection_schedule_heads WHERE schedule_id=s.id),1)
    AND json_extract(a.payload_json,'$.result.scope_key') IS s.scope_key AND json_extract(a.payload_json,'$.result.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'collection version requires matching human save audit') END;
END;
CREATE TRIGGER collection_version_no_update BEFORE UPDATE ON collection_schedule_versions BEGIN SELECT RAISE(ABORT,'collection versions are append-only'); END;
CREATE TRIGGER collection_version_no_delete BEFORE DELETE ON collection_schedule_versions BEGIN SELECT RAISE(ABORT,'collection versions are append-only'); END;

CREATE TRIGGER collection_control_insert BEFORE INSERT ON collection_schedule_controls BEGIN
  SELECT CASE WHEN NEW.revision>1024 OR (NEW.revision=1024 AND (NEW.status!='paused'
    OR NOT EXISTS(SELECT 1 FROM collection_schedule_heads h JOIN audit_events a ON a.id=NEW.audit_id
      WHERE h.schedule_id=NEW.schedule_id AND h.revision=1023 AND h.status='enabled'
      AND a.action='set_collection_schedule_status')))
    THEN RAISE(ABORT,'collection control proof budget reserves final pause') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM collection_schedule_controls WHERE (schedule_id=NEW.schedule_id AND revision=NEW.revision) OR audit_id=NEW.audit_id)
    THEN RAISE(ABORT,'collection controls cannot be replaced') END;
  SELECT CASE WHEN NEW.revision IS NOT (SELECT COALESCE(MAX(revision),0)+1 FROM collection_schedule_controls WHERE schedule_id=NEW.schedule_id)
    OR (NEW.revision>1 AND NOT EXISTS(SELECT 1 FROM collection_schedule_heads h WHERE h.schedule_id=NEW.schedule_id AND h.revision=NEW.revision-1 AND h.updated_at<=NEW.created_at))
    THEN RAISE(ABORT,'collection control CAS mismatch') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM collection_schedules s JOIN collection_schedule_versions v ON v.id=NEW.version_id AND v.schedule_id=s.id
    JOIN audit_events a ON a.id=NEW.audit_id LEFT JOIN collection_schedule_heads h ON h.schedule_id=s.id
    LEFT JOIN collection_schedule_versions old ON old.id=h.current_version_id
    WHERE s.id=NEW.schedule_id AND a.portfolio_id=s.portfolio_id AND a.object_type='collection_schedule' AND a.object_id=s.id
    AND length(trim(a.actor_id))>0 AND a.ledger_revision IS NULL AND a.created_at=NEW.created_at AND v.created_at<=NEW.created_at
    AND json_extract(a.payload_json,'$.actor_kind') IS 'human' AND json_extract(a.payload_json,'$.input.portfolio_id') IS s.portfolio_id
    AND json_type(a.payload_json,'$.input.acknowledgement') IS 'true'
    AND json_extract(a.payload_json,'$.input.expected_schedule_revision') IS NEW.revision-1
    AND json_extract(a.payload_json,'$.result.schedule_id') IS s.id AND json_extract(a.payload_json,'$.result.version_id') IS v.id
    AND json_extract(a.payload_json,'$.result.version') IS v.version AND json_extract(a.payload_json,'$.result.schedule_revision') IS NEW.revision
    AND json_extract(a.payload_json,'$.result.status') IS NEW.status AND json_extract(a.payload_json,'$.result.scope_key') IS s.scope_key
    AND json_extract(a.payload_json,'$.result.content_hash') IS v.content_hash
    AND ((a.action='save_collection_schedule' AND v.audit_id=a.id AND NEW.status='paused' AND v.created_at=NEW.created_at
      AND ((NEW.revision=1 AND v.version=1) OR (NEW.revision>1 AND v.version=old.version+1)))
      OR (a.action='set_collection_schedule_status' AND NEW.revision>1 AND NEW.version_id=h.current_version_id
        AND json_extract(a.payload_json,'$.input.schedule_id') IS s.id AND json_extract(a.payload_json,'$.input.status') IS NEW.status)))
    THEN RAISE(ABORT,'collection control requires matching human audit') END;
END;
CREATE TRIGGER collection_control_no_update BEFORE UPDATE ON collection_schedule_controls BEGIN SELECT RAISE(ABORT,'collection controls are append-only'); END;
CREATE TRIGGER collection_control_no_delete BEFORE DELETE ON collection_schedule_controls BEGIN SELECT RAISE(ABORT,'collection controls are append-only'); END;

CREATE TRIGGER collection_head_insert BEFORE INSERT ON collection_schedule_heads BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM collection_schedule_heads WHERE schedule_id=NEW.schedule_id OR (scope_key=NEW.scope_key AND status='enabled' AND NEW.status='enabled'))
    THEN RAISE(ABORT,'collection schedule heads cannot be replaced') END;
  SELECT CASE WHEN NEW.revision IS NOT 1 OR NEW.status IS NOT 'paused' THEN RAISE(ABORT,'collection schedule must start paused') END;
END;
CREATE TRIGGER collection_head_update BEFORE UPDATE ON collection_schedule_heads BEGIN
  SELECT CASE WHEN NEW.status='enabled' AND EXISTS(SELECT 1 FROM collection_schedule_heads WHERE scope_key=NEW.scope_key
    AND status='enabled' AND schedule_id!=OLD.schedule_id) THEN RAISE(ABORT,'collection scope already enabled') END;
  SELECT CASE WHEN NEW.schedule_id IS NOT OLD.schedule_id OR NEW.scope_key IS NOT OLD.scope_key OR NEW.revision IS NOT OLD.revision+1
    OR NEW.updated_at<OLD.updated_at OR NEW.revision IS NOT (SELECT MAX(revision) FROM collection_schedule_controls WHERE schedule_id=NEW.schedule_id)
    THEN RAISE(ABORT,'collection head CAS mismatch') END;
END;
CREATE TRIGGER collection_head_no_delete BEFORE DELETE ON collection_schedule_heads BEGIN SELECT RAISE(ABORT,'collection heads cannot be deleted'); END;

CREATE TRIGGER collection_slot_insert BEFORE INSERT ON collection_schedule_slots BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM collection_schedule_slots WHERE id=NEW.id OR (scope_key=NEW.scope_key AND period=NEW.period) OR command_request_id=NEW.command_request_id)
    THEN RAISE(ABORT,'collection daily slot cannot be replaced') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM collection_schedule_controls c JOIN collection_schedule_versions v ON v.id=c.version_id
    WHERE c.schedule_id=NEW.schedule_id AND c.revision=NEW.authorization_revision AND c.audit_id=NEW.authorization_audit_id
    AND c.version_id=NEW.schedule_version_id AND c.status='enabled' AND c.created_at<=NEW.scheduled_at
    AND NOT EXISTS(SELECT 1 FROM collection_schedule_controls later WHERE later.schedule_id=c.schedule_id AND later.revision>c.revision AND later.created_at<=NEW.scheduled_at)
    AND NEW.period>=json_extract(v.definition_json,'$.start_date')
    AND (json_type(v.definition_json,'$.end_date')='null' OR NEW.period<=json_extract(v.definition_json,'$.end_date'))
    AND NEW.scheduled_at=NEW.period || 'T' || printf('%02d:%02d:00.000000Z',json_extract(v.definition_json,'$.trigger.hour'),json_extract(v.definition_json,'$.trigger.minute'))
    AND NEW.deadline_at=strftime('%Y-%m-%dT%H:%M:%S',substr(NEW.scheduled_at,1,19),'+' || CAST(json_extract(v.definition_json,'$.deadline_seconds') AS INTEGER) || ' seconds') || '.000000Z'
    AND NEW.created_at>=NEW.scheduled_at)
    THEN RAISE(ABORT,'collection slot requires frozen due authorization') END;
  SELECT CASE WHEN NEW.disposition='requested' AND (NEW.created_at>=NEW.deadline_at
    OR NOT EXISTS(SELECT 1 FROM collection_schedule_heads h WHERE h.schedule_id=NEW.schedule_id AND h.revision=NEW.authorization_revision
      AND h.current_version_id=NEW.schedule_version_id AND h.last_audit_id=NEW.authorization_audit_id AND h.status='enabled')
    OR NEW.expected_publication_revision IS NOT COALESCE((SELECT revision FROM market_publications WHERE scope=NEW.scope_key),0)
    OR NOT EXISTS(SELECT 1 FROM command_requests r JOIN collection_schedule_versions v ON v.id=NEW.schedule_version_id
      WHERE r.id=NEW.command_request_id AND r.portfolio_id=NEW.portfolio_id AND r.command_type='market_collect'
      AND r.actor_id='system:collection-discovery' AND r.created_at=NEW.created_at
      AND json_valid(r.payload_json) AND json_type(r.payload_json)='object' AND (SELECT COUNT(*) FROM json_each(r.payload_json))=5
      AND json_extract(r.payload_json,'$.provider') IS 'ecb' AND json_extract(r.payload_json,'$.feed') IS 'daily' AND json_type(r.payload_json,'$.publish') IS 'true'
      AND json_type(r.payload_json,'$.expected_publication_revision') IS 'integer' AND json_extract(r.payload_json,'$.expected_publication_revision') IS NEW.expected_publication_revision
      AND json_type(r.payload_json,'$.currencies') IS 'array'
      AND json_array_length(r.payload_json,'$.currencies') IS json_array_length(v.definition_json,'$.currencies')
      AND (SELECT COUNT(DISTINCT value) FROM json_each(r.payload_json,'$.currencies')) IS json_array_length(r.payload_json,'$.currencies')
      AND NOT EXISTS(SELECT 1 FROM json_each(r.payload_json,'$.currencies') x WHERE x.type!='text' OR x.value NOT IN (SELECT value FROM json_each(v.definition_json,'$.currencies')))))
    THEN RAISE(ABORT,'requested collection slot requires current scoped command') END;
  SELECT CASE WHEN NEW.disposition='missed' AND NOT ((NEW.reason_code='DEADLINE_EXPIRED' AND NEW.created_at>=NEW.deadline_at
      AND NOT EXISTS(SELECT 1 FROM collection_schedule_controls c WHERE c.schedule_id=NEW.schedule_id
        AND c.revision>NEW.authorization_revision AND c.created_at<NEW.deadline_at))
    OR (NEW.reason_code='AUTHORIZATION_ENDED' AND EXISTS(SELECT 1 FROM collection_schedule_controls c WHERE c.schedule_id=NEW.schedule_id
      AND c.revision>NEW.authorization_revision AND c.created_at<NEW.deadline_at AND c.created_at<=NEW.created_at)))
    THEN RAISE(ABORT,'missed collection slot requires elapsed authorization or deadline') END;
END;
CREATE TRIGGER collection_slot_no_update BEFORE UPDATE ON collection_schedule_slots BEGIN SELECT RAISE(ABORT,'collection slots are append-only'); END;
CREATE TRIGGER collection_slot_no_delete BEFORE DELETE ON collection_schedule_slots BEGIN SELECT RAISE(ABORT,'collection slots are append-only'); END;
