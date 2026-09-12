CREATE TABLE csv_confirmation_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL CHECK(length(trim(actor_id)) > 0),
  session_hash TEXT NOT NULL CHECK(typeof(session_hash)='text' AND length(session_hash)=64 AND session_hash NOT GLOB '*[^a-f0-9]*'),
  portfolio_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES csv_import_manifests(batch_id),
  preview_hash TEXT NOT NULL CHECK(typeof(preview_hash)='text' AND length(preview_hash)=64 AND preview_hash NOT GLOB '*[^a-f0-9]*'),
  expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740991),
  payload_text TEXT NOT NULL CHECK(typeof(payload_text)='text' AND length(CAST(payload_text AS BLOB)) BETWEEN 1 AND 5242880),
  payload_hash TEXT NOT NULL CHECK(typeof(payload_hash)='text' AND length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  FOREIGN KEY(account_id,portfolio_id) REFERENCES accounts(id,portfolio_id),
  UNIQUE(actor_id,session_hash,portfolio_id,batch_id,payload_hash)
);

CREATE INDEX csv_confirmation_attempts_session ON csv_confirmation_attempts(actor_id,session_hash,created_at DESC,id DESC);

CREATE TRIGGER csv_confirmation_attempt_scope BEFORE INSERT ON csv_confirmation_attempts BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM csv_confirmation_attempts WHERE id=NEW.id)
    OR EXISTS(SELECT 1 FROM csv_confirmation_attempts WHERE actor_id=NEW.actor_id AND session_hash=NEW.session_hash
      AND portfolio_id=NEW.portfolio_id AND batch_id=NEW.batch_id AND payload_hash=NEW.payload_hash)
    THEN RAISE(ABORT,'CSV confirmation attempts are append-only') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM import_batches b JOIN csv_import_manifests m ON m.batch_id=b.id
    WHERE b.id=NEW.batch_id AND b.parser_version='csv-v1'
      AND b.portfolio_id=NEW.portfolio_id AND b.account_id=NEW.account_id
      AND b.preview_hash=NEW.preview_hash AND b.expected_revision=NEW.expected_revision)
    THEN RAISE(ABORT,'CSV confirmation attempt scope mismatch') END;
END;
CREATE TRIGGER csv_confirmation_attempt_no_update BEFORE UPDATE ON csv_confirmation_attempts BEGIN
  SELECT RAISE(ABORT,'CSV confirmation attempts are append-only');
END;
CREATE TRIGGER csv_confirmation_attempt_no_delete BEFORE DELETE ON csv_confirmation_attempts BEGIN
  SELECT RAISE(ABORT,'CSV confirmation attempts are append-only');
END;
