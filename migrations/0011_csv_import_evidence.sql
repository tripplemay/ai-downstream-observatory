CREATE TABLE csv_mapping_versions (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  account_id TEXT NOT NULL,
  mapping_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(account_id,portfolio_id) REFERENCES accounts(id,portfolio_id),
  UNIQUE(portfolio_id,account_id,mapping_key,version),
  CHECK(json_extract(definition_json,'$.mapping_id')=mapping_key),
  CHECK(json_extract(definition_json,'$.version')=version)
);
CREATE TRIGGER csv_mapping_no_update BEFORE UPDATE ON csv_mapping_versions BEGIN SELECT RAISE(ABORT,'CSV mapping versions are append-only'); END;
CREATE TRIGGER csv_mapping_no_delete BEFORE DELETE ON csv_mapping_versions BEGIN SELECT RAISE(ABORT,'CSV mapping versions are append-only'); END;
CREATE TRIGGER csv_mapping_scope BEFORE INSERT ON csv_mapping_versions BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM attachments a JOIN audit_events e ON e.object_id=a.id
    WHERE a.id=NEW.attachment_id AND a.media_type='application/json' AND e.action='store_attachment' AND e.object_type='attachment'
    AND e.portfolio_id=NEW.portfolio_id AND json_extract(e.payload_json,'$.account_id')=NEW.account_id)
    THEN RAISE(ABORT,'CSV mapping attachment scope mismatch') END;
END;

CREATE TABLE csv_import_manifests (
  batch_id TEXT PRIMARY KEY REFERENCES import_batches(id),
  mapping_version_id TEXT NOT NULL REFERENCES csv_mapping_versions(id),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  created_at TEXT NOT NULL
);
CREATE TRIGGER csv_manifest_scope BEFORE INSERT ON csv_import_manifests BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM import_batches b JOIN csv_mapping_versions m ON m.id=NEW.mapping_version_id JOIN attachments a ON a.id=b.attachment_id
    WHERE b.id=NEW.batch_id AND b.portfolio_id=m.portfolio_id AND b.account_id=m.account_id AND b.parser_version='csv-v1'
    AND b.mapping_version=m.id AND b.status IN ('preview','invalid') AND b.confirmed_at IS NULL AND b.confirmed_revision IS NULL
    AND a.media_type='text/csv' AND a.content_hash=b.content_hash
    AND EXISTS(SELECT 1 FROM audit_events e WHERE e.action='store_attachment' AND e.object_type='attachment' AND e.object_id=a.id
      AND e.portfolio_id=b.portfolio_id AND json_extract(e.payload_json,'$.account_id')=b.account_id))
    THEN RAISE(ABORT,'CSV import evidence scope mismatch') END;
END;
CREATE TRIGGER csv_manifest_no_update BEFORE UPDATE ON csv_import_manifests BEGIN SELECT RAISE(ABORT,'CSV import evidence is append-only'); END;
CREATE TRIGGER csv_manifest_no_delete BEFORE DELETE ON csv_import_manifests BEGIN SELECT RAISE(ABORT,'CSV import evidence is append-only'); END;
CREATE TRIGGER csv_rows_no_insert BEFORE INSERT ON import_rows WHEN EXISTS(SELECT 1 FROM csv_import_manifests WHERE batch_id=NEW.batch_id) BEGIN SELECT RAISE(ABORT,'CSV preview rows are frozen'); END;
CREATE TRIGGER csv_rows_no_update BEFORE UPDATE ON import_rows WHEN EXISTS(SELECT 1 FROM csv_import_manifests WHERE batch_id IN (OLD.batch_id,NEW.batch_id)) BEGIN SELECT RAISE(ABORT,'CSV preview rows are frozen'); END;
CREATE TRIGGER csv_rows_no_delete BEFORE DELETE ON import_rows WHEN EXISTS(SELECT 1 FROM csv_import_manifests WHERE batch_id=OLD.batch_id) BEGIN SELECT RAISE(ABORT,'CSV preview rows are frozen'); END;
CREATE TRIGGER csv_batch_frozen BEFORE UPDATE ON import_batches WHEN EXISTS(SELECT 1 FROM csv_import_manifests WHERE batch_id=OLD.id) BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.portfolio_id IS NOT OLD.portfolio_id OR NEW.account_id IS NOT OLD.account_id
    OR NEW.attachment_id IS NOT OLD.attachment_id OR NEW.content_hash IS NOT OLD.content_hash OR NEW.parser_version IS NOT OLD.parser_version
    OR NEW.mapping_version IS NOT OLD.mapping_version OR NEW.preview_hash IS NOT OLD.preview_hash OR NEW.expected_revision IS NOT OLD.expected_revision
    OR NEW.row_count IS NOT OLD.row_count OR NEW.error_count IS NOT OLD.error_count OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
    THEN RAISE(ABORT,'CSV import inputs are frozen') END;
  SELECT CASE WHEN NOT (NEW.status=OLD.status OR (OLD.status='preview' AND NEW.status IN ('confirmed','cancelled')) OR (OLD.status='invalid' AND NEW.status='cancelled'))
    THEN RAISE(ABORT,'invalid CSV import transition') END;
  SELECT CASE WHEN OLD.status='confirmed' AND (NEW.confirmed_at IS NOT OLD.confirmed_at OR NEW.confirmed_revision IS NOT OLD.confirmed_revision)
    THEN RAISE(ABORT,'CSV confirmation is immutable') END;
  SELECT CASE WHEN NEW.status<>'confirmed' AND (NEW.confirmed_at IS NOT NULL OR NEW.confirmed_revision IS NOT NULL)
    THEN RAISE(ABORT,'CSV confirmation fields require confirmed state') END;
  SELECT CASE WHEN NEW.status='confirmed' AND (NEW.confirmed_at IS NULL OR NEW.confirmed_revision IS NULL
    OR NEW.confirmed_revision<NEW.expected_revision OR NEW.error_count<>0 OR NEW.row_count<1
    OR (SELECT COUNT(*) FROM import_rows WHERE batch_id=OLD.id)<>NEW.row_count
    OR EXISTS(SELECT 1 FROM import_rows WHERE batch_id=OLD.id AND (normalized_json IS NULL OR json_array_length(errors_json)<>0))
    OR (SELECT COUNT(*) FROM csv_import_outcomes WHERE batch_id=OLD.id)<>NEW.row_count)
    THEN RAISE(ABORT,'CSV confirmation outcomes incomplete') END;
END;
CREATE TRIGGER csv_batch_no_delete BEFORE DELETE ON import_batches WHEN EXISTS(SELECT 1 FROM csv_import_manifests WHERE batch_id=OLD.id) BEGIN SELECT RAISE(ABORT,'CSV import batches cannot be deleted'); END;

CREATE TABLE csv_import_outcomes (
  batch_id TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  event_id TEXT NOT NULL REFERENCES ledger_events(id),
  duplicate INTEGER NOT NULL CHECK(duplicate IN (0,1)),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(batch_id,row_number),
  FOREIGN KEY(batch_id,row_number) REFERENCES import_rows(batch_id,row_number),
  FOREIGN KEY(batch_id) REFERENCES csv_import_manifests(batch_id)
);
CREATE TRIGGER csv_outcome_scope BEFORE INSERT ON csv_import_outcomes BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM import_batches b JOIN ledger_events e ON e.id=NEW.event_id
    WHERE b.id=NEW.batch_id AND b.portfolio_id=e.portfolio_id AND b.account_id=e.account_id AND b.status='preview' AND b.error_count=0
      AND json_extract(NEW.result_json,'$.receipt.event_id') IS NEW.event_id
      AND json_extract(NEW.result_json,'$.receipt.revision') IS e.ledger_revision
      AND COALESCE(json_extract(NEW.result_json,'$.receipt.duplicate'),0)=NEW.duplicate
      AND EXISTS(SELECT 1 FROM audit_events a WHERE a.id=json_extract(NEW.result_json,'$.receipt.audit_id') AND a.portfolio_id=b.portfolio_id))
    THEN RAISE(ABORT,'CSV outcome scope mismatch') END;
END;
CREATE TRIGGER csv_outcomes_no_update BEFORE UPDATE ON csv_import_outcomes BEGIN SELECT RAISE(ABORT,'CSV import outcomes are append-only'); END;
CREATE TRIGGER csv_outcomes_no_delete BEFORE DELETE ON csv_import_outcomes BEGIN SELECT RAISE(ABORT,'CSV import outcomes are append-only'); END;
CREATE INDEX csv_source_identity_lookup ON import_rows(
  json_extract(normalized_json,'$.fact.account_id'),json_extract(normalized_json,'$.source_id'),
  source_event_id,json_extract(normalized_json,'$.fact.type')
);
