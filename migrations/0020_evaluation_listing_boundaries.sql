CREATE TABLE listing_review_sequences (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 9007199254740991),
  version_id TEXT NOT NULL UNIQUE REFERENCES listing_review_versions(id),
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id)
);
CREATE INDEX listing_review_sequence_portfolio ON listing_review_sequences(portfolio_id,sequence);

-- Baseline order is not reconstructed commit order; old cycles never receive a guessed watermark.
INSERT INTO listing_review_sequences(version_id,portfolio_id)
  SELECT id,portfolio_id FROM listing_review_versions ORDER BY portfolio_id,listing_id,revision,id;

CREATE TRIGGER listing_review_sequence_insert BEFORE INSERT ON listing_review_sequences BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM listing_review_sequences WHERE sequence=NEW.sequence OR version_id=NEW.version_id)
    THEN RAISE(ABORT,'listing review sequences cannot be replaced') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM listing_review_versions WHERE id=NEW.version_id AND portfolio_id=NEW.portfolio_id)
    THEN RAISE(ABORT,'listing review sequence portfolio mismatch') END;
END;
CREATE TRIGGER listing_review_sequence_no_update BEFORE UPDATE ON listing_review_sequences
  BEGIN SELECT RAISE(ABORT,'listing review sequences are immutable'); END;
CREATE TRIGGER listing_review_sequence_no_delete BEFORE DELETE ON listing_review_sequences
  BEGIN SELECT RAISE(ABORT,'listing review sequences are immutable'); END;
CREATE TRIGGER listing_review_capture_sequence AFTER INSERT ON listing_review_versions BEGIN
  INSERT INTO listing_review_sequences(version_id,portfolio_id) VALUES(NEW.id,NEW.portfolio_id);
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM listing_review_sequences WHERE version_id=NEW.id AND portfolio_id=NEW.portfolio_id)
    THEN RAISE(ABORT,'listing review sequence capture failed') END;
END;

CREATE TABLE evaluation_listing_review_boundaries (
  cycle_id TEXT PRIMARY KEY NOT NULL REFERENCES evaluation_cycles(id),
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  knowledge_at TEXT,
  capture_kind TEXT NOT NULL CHECK(capture_kind IN ('cycle_insert_transaction','legacy_missing')),
  watermark_sequence INTEGER,
  CHECK((capture_kind='legacy_missing' AND watermark_sequence IS NULL)
    OR (capture_kind='cycle_insert_transaction' AND typeof(knowledge_at)='text'
      AND typeof(watermark_sequence)='integer' AND watermark_sequence BETWEEN 0 AND 9007199254740991))
);

INSERT INTO evaluation_listing_review_boundaries(cycle_id,portfolio_id,knowledge_at,capture_kind,watermark_sequence)
  SELECT id,portfolio_id,knowledge_at,'legacy_missing',NULL FROM evaluation_cycles;

CREATE TRIGGER evaluation_listing_boundary_insert BEFORE INSERT ON evaluation_listing_review_boundaries BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM evaluation_listing_review_boundaries WHERE cycle_id=NEW.cycle_id)
    THEN RAISE(ABORT,'evaluation listing boundaries cannot be replaced') END;
  SELECT CASE WHEN NEW.capture_kind IS NOT 'cycle_insert_transaction'
    OR NOT EXISTS(SELECT 1 FROM evaluation_cycles WHERE id=NEW.cycle_id AND portfolio_id=NEW.portfolio_id
      AND knowledge_at IS NEW.knowledge_at AND knowledge_at IS NOT NULL)
    OR NEW.watermark_sequence IS NOT (SELECT COALESCE(MAX(sequence),0) FROM listing_review_sequences WHERE portfolio_id=NEW.portfolio_id)
    THEN RAISE(ABORT,'evaluation listing boundary requires current cycle transaction watermark') END;
END;
CREATE TRIGGER evaluation_listing_boundary_no_update BEFORE UPDATE ON evaluation_listing_review_boundaries
  BEGIN SELECT RAISE(ABORT,'evaluation listing boundaries are immutable'); END;
CREATE TRIGGER evaluation_listing_boundary_no_delete BEFORE DELETE ON evaluation_listing_review_boundaries
  BEGIN SELECT RAISE(ABORT,'evaluation listing boundaries are immutable'); END;
CREATE TRIGGER evaluation_cycle_capture_listing_boundary AFTER INSERT ON evaluation_cycles BEGIN
  INSERT INTO evaluation_listing_review_boundaries(cycle_id,portfolio_id,knowledge_at,capture_kind,watermark_sequence)
    VALUES(NEW.id,NEW.portfolio_id,NEW.knowledge_at,'cycle_insert_transaction',
      (SELECT COALESCE(MAX(sequence),0) FROM listing_review_sequences WHERE portfolio_id=NEW.portfolio_id));
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM evaluation_listing_review_boundaries WHERE cycle_id=NEW.id
    AND portfolio_id=NEW.portfolio_id AND knowledge_at IS NEW.knowledge_at AND capture_kind='cycle_insert_transaction'
    AND watermark_sequence IS (SELECT COALESCE(MAX(sequence),0) FROM listing_review_sequences WHERE portfolio_id=NEW.portfolio_id))
    THEN RAISE(ABORT,'evaluation listing boundary capture failed') END;
END;
