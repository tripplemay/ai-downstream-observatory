CREATE TABLE market_batch_pages (
  batch_id TEXT NOT NULL REFERENCES market_batches(id),
  page_number INTEGER NOT NULL CHECK(page_number > 0),
  payload_hash TEXT NOT NULL,
  observations_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY(batch_id, page_number)
);

CREATE TABLE market_batch_members (
  batch_id TEXT NOT NULL REFERENCES market_batches(id),
  observation_id TEXT NOT NULL REFERENCES market_observations(id),
  PRIMARY KEY(batch_id, observation_id)
);
CREATE INDEX market_members_observation ON market_batch_members(observation_id, batch_id);

CREATE TABLE market_publication_events (
  scope TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  batch_id TEXT NOT NULL REFERENCES market_batches(id),
  manifest_hash TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY(scope, revision)
);
CREATE INDEX market_publication_history ON market_publication_events(scope, published_at, revision);

CREATE TRIGGER market_pages_staging BEFORE INSERT ON market_batch_pages
  WHEN NOT EXISTS (SELECT 1 FROM market_batches b WHERE b.id = NEW.batch_id AND b.status = 'staging'
    AND b.expected_pages >= NEW.page_number)
  BEGIN SELECT RAISE(ABORT, 'page requires staging batch and expected page number'); END;
CREATE TRIGGER market_pages_no_update BEFORE UPDATE ON market_batch_pages BEGIN SELECT RAISE(ABORT, 'market page originals are append-only'); END;
CREATE TRIGGER market_pages_no_delete BEFORE DELETE ON market_batch_pages BEGIN SELECT RAISE(ABORT, 'market page originals are append-only'); END;

CREATE TRIGGER market_members_staging BEFORE INSERT ON market_batch_members
  WHEN NOT EXISTS (SELECT 1 FROM market_batches b JOIN market_observations o ON o.id = NEW.observation_id
    WHERE b.id = NEW.batch_id AND b.status IN ('staging','validated') AND b.source_id = o.source_id)
  BEGIN SELECT RAISE(ABORT, 'membership requires unfinalized same-source batch'); END;
CREATE TRIGGER market_members_no_update BEFORE UPDATE ON market_batch_members BEGIN SELECT RAISE(ABORT, 'market membership is append-only'); END;
CREATE TRIGGER market_members_no_delete BEFORE DELETE ON market_batch_members BEGIN SELECT RAISE(ABORT, 'market membership is append-only'); END;

CREATE TRIGGER market_batches_start_staging BEFORE INSERT ON market_batches
  WHEN NEW.status != 'staging'
  BEGIN SELECT RAISE(ABORT, 'new market batch must begin staging'); END;
CREATE TRIGGER market_batches_transition BEFORE UPDATE ON market_batches
  WHEN OLD.status IN ('published','partial','failed')
    OR NEW.id != OLD.id OR NEW.source_id != OLD.source_id OR NEW.batch_type != OLD.batch_type
    OR NEW.scope != OLD.scope OR NEW.expected_pages IS NOT OLD.expected_pages OR NEW.started_at != OLD.started_at
    OR (OLD.status = 'staging' AND NEW.status NOT IN ('staging','validated','partial','failed'))
    OR (OLD.status = 'validated' AND (NEW.status NOT IN ('published','failed')
      OR NEW.manifest_hash IS NOT OLD.manifest_hash OR NEW.validation_json != OLD.validation_json
      OR NEW.received_pages != OLD.received_pages OR NEW.row_count != OLD.row_count))
  BEGIN SELECT RAISE(ABORT, 'invalid market batch transition or frozen metadata'); END;
CREATE TRIGGER market_batches_no_delete BEFORE DELETE ON market_batches BEGIN SELECT RAISE(ABORT, 'market batch history cannot be deleted'); END;

CREATE TRIGGER market_history_validated BEFORE INSERT ON market_publication_events
  WHEN NOT EXISTS (SELECT 1 FROM market_batches b WHERE b.id = NEW.batch_id AND b.status IN ('validated','published')
    AND b.manifest_hash = NEW.manifest_hash AND b.scope = NEW.scope)
    OR NEW.revision != COALESCE((SELECT MAX(e.revision) + 1 FROM market_publication_events e WHERE e.scope = NEW.scope), 1)
  BEGIN SELECT RAISE(ABORT, 'publication history requires validated manifest and next revision'); END;
CREATE TRIGGER market_history_no_update BEFORE UPDATE ON market_publication_events BEGIN SELECT RAISE(ABORT, 'market publication history is append-only'); END;
CREATE TRIGGER market_history_no_delete BEFORE DELETE ON market_publication_events BEGIN SELECT RAISE(ABORT, 'market publication history is append-only'); END;

CREATE TRIGGER market_publication_scope_insert BEFORE INSERT ON market_publications
  WHEN (SELECT scope FROM market_batches WHERE id = NEW.batch_id) != NEW.scope
  BEGIN SELECT RAISE(ABORT, 'market publication scope mismatch'); END;
CREATE TRIGGER market_publication_scope_update BEFORE UPDATE ON market_publications
  WHEN (SELECT scope FROM market_batches WHERE id = NEW.batch_id) != NEW.scope
  BEGIN SELECT RAISE(ABORT, 'market publication scope mismatch'); END;
