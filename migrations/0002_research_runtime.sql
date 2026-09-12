CREATE TABLE market_batches (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  batch_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('staging','validated','published','partial','failed')),
  expected_pages INTEGER,
  received_pages INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  manifest_hash TEXT,
  validation_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE market_observations (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES market_batches(id),
  source_id TEXT NOT NULL,
  listing_id TEXT REFERENCES listings(id),
  series_key TEXT NOT NULL,
  metric TEXT NOT NULL,
  value TEXT NOT NULL CHECK(typeof(value) = 'text'),
  unit TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  published_at TEXT,
  ingested_at TEXT NOT NULL,
  source_timezone TEXT NOT NULL DEFAULT 'UTC',
  time_precision TEXT NOT NULL DEFAULT 'second' CHECK(time_precision IN ('second','date')),
  price_basis TEXT NOT NULL CHECK(price_basis IN ('unadjusted','forward_adjusted','backward_adjusted','total_return','not_applicable')),
  revision_id TEXT NOT NULL,
  raw_hash TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK(provenance IN ('live_observed','historical_point_in_time','reconstructed')),
  UNIQUE(source_id, series_key, metric, observed_at, price_basis, revision_id)
);
CREATE INDEX observations_lookup ON market_observations(series_key, metric, price_basis, observed_at, ingested_at);
CREATE INDEX observations_batch ON market_observations(batch_id);

CREATE TABLE market_publications (
  scope TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES market_batches(id),
  manifest_hash TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  published_at TEXT NOT NULL
);

CREATE TABLE valuation_runs (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  ledger_revision INTEGER NOT NULL,
  market_manifest TEXT NOT NULL,
  method_version TEXT NOT NULL,
  cutoff_at TEXT NOT NULL,
  quality TEXT NOT NULL CHECK(quality IN ('complete','provisional','blocked')),
  nav_cny TEXT CHECK(nav_cny IS NULL OR typeof(nav_cny) = 'text'),
  issues_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE(portfolio_id, ledger_revision, market_manifest, method_version, cutoff_at)
);

CREATE TABLE valuation_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES valuation_runs(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  listing_id TEXT REFERENCES listings(id),
  item_type TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount TEXT CHECK(amount IS NULL OR typeof(amount) = 'text'),
  fx_rate TEXT CHECK(fx_rate IS NULL OR typeof(fx_rate) = 'text'),
  value_cny TEXT CHECK(value_cny IS NULL OR typeof(value_cny) = 'text'),
  observed_at TEXT,
  quality TEXT NOT NULL CHECK(quality IN ('complete','provisional','blocked')),
  evidence_json TEXT NOT NULL
);

CREATE TABLE performance_runs (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  ledger_revision INTEGER NOT NULL,
  market_manifest TEXT NOT NULL,
  method_version TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  quality TEXT NOT NULL CHECK(quality IN ('complete','provisional','blocked')),
  method TEXT NOT NULL CHECK(method IN ('exact_twr','modified_dietz_estimate','mixed_estimate','unavailable')),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE research_runs (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  environment TEXT NOT NULL CHECK(environment IN ('research','simulation','legacy')),
  strategy_version_id TEXT REFERENCES strategy_versions(id),
  policy_version_id TEXT REFERENCES policy_versions(id),
  input_manifest TEXT NOT NULL,
  experiment_plan_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE simulation_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES research_runs(id),
  environment TEXT NOT NULL CHECK(environment IN ('research','simulation','legacy')),
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  event_type TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(run_id, sequence)
);

CREATE TABLE evaluation_cycles (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  strategy_version_id TEXT NOT NULL REFERENCES strategy_versions(id),
  policy_version_id TEXT NOT NULL REFERENCES policy_versions(id),
  scope TEXT NOT NULL,
  period TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','blocked','failed')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('unchanged','proposed','blocked')),
  completed_at TEXT,
  UNIQUE(strategy_version_id, policy_version_id, scope, period)
);

CREATE TABLE evaluation_attempts (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES evaluation_cycles(id),
  attempt INTEGER NOT NULL CHECK(attempt > 0),
  input_manifest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('succeeded','blocked','failed')),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(cycle_id, attempt)
);

CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  research_run_id TEXT REFERENCES research_runs(id),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_manifest TEXT NOT NULL,
  raw_output TEXT,
  result_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('valid','invalid','failed','timeout')),
  quality_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  ai_run_id TEXT REFERENCES ai_runs(id),
  source_url TEXT,
  attachment_id TEXT REFERENCES attachments(id),
  content_hash TEXT NOT NULL,
  published_at TEXT,
  observed_at TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  CHECK(source_url IS NOT NULL OR attachment_id IS NOT NULL)
);

CREATE TABLE research_notes (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  previous_version_id TEXT REFERENCES research_notes(id),
  content TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE command_requests (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  command_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(portfolio_id, command_type, idempotency_key)
);

CREATE TABLE job_runs (
  id TEXT PRIMARY KEY,
  command_request_id TEXT REFERENCES command_requests(id),
  job_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  period TEXT NOT NULL,
  input_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','partial','failed','skipped','retry_queued','cancelled')),
  lease_owner TEXT,
  lease_until TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  heartbeat_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts > 0),
  not_before TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_type, scope, period, input_version)
);
CREATE INDEX jobs_pending ON job_runs(status, not_before, lease_until);

CREATE TABLE job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES job_runs(id),
  attempt INTEGER NOT NULL,
  fencing_token INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','partial','failed','skipped','lease_expired','cancelled')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_json TEXT,
  UNIQUE(job_id, attempt)
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','uncertain')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  not_before TEXT NOT NULL,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE notification_attempts (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES outbox(id),
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('sent','failed','uncertain')),
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(outbox_id, attempt)
);

CREATE TABLE legacy_archives (
  id TEXT PRIMARY KEY,
  source_database_hash TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_row_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'legacy' CHECK(environment = 'legacy'),
  provenance_json TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  UNIQUE(source_database_hash, source_table, source_key)
);

CREATE TRIGGER observations_no_update BEFORE UPDATE ON market_observations BEGIN SELECT RAISE(ABORT, 'observations are append-only'); END;
CREATE TRIGGER observations_no_delete BEFORE DELETE ON market_observations BEGIN SELECT RAISE(ABORT, 'observations are append-only'); END;
CREATE TRIGGER valuations_no_update BEFORE UPDATE ON valuation_runs BEGIN SELECT RAISE(ABORT, 'valuations are append-only'); END;
CREATE TRIGGER valuations_no_delete BEFORE DELETE ON valuation_runs BEGIN SELECT RAISE(ABORT, 'valuations are append-only'); END;
CREATE TRIGGER valuation_items_no_update BEFORE UPDATE ON valuation_items BEGIN SELECT RAISE(ABORT, 'valuation items are append-only'); END;
CREATE TRIGGER valuation_items_no_delete BEFORE DELETE ON valuation_items BEGIN SELECT RAISE(ABORT, 'valuation items are append-only'); END;
CREATE TRIGGER performance_no_update BEFORE UPDATE ON performance_runs BEGIN SELECT RAISE(ABORT, 'performance results are append-only'); END;
CREATE TRIGGER performance_no_delete BEFORE DELETE ON performance_runs BEGIN SELECT RAISE(ABORT, 'performance results are append-only'); END;
CREATE TRIGGER simulation_no_update BEFORE UPDATE ON simulation_events BEGIN SELECT RAISE(ABORT, 'simulation events are append-only'); END;
CREATE TRIGGER simulation_no_delete BEFORE DELETE ON simulation_events BEGIN SELECT RAISE(ABORT, 'simulation events are append-only'); END;
CREATE TRIGGER ai_runs_no_update BEFORE UPDATE ON ai_runs BEGIN SELECT RAISE(ABORT, 'AI evidence is append-only'); END;
CREATE TRIGGER ai_runs_no_delete BEFORE DELETE ON ai_runs BEGIN SELECT RAISE(ABORT, 'AI evidence is append-only'); END;
CREATE TRIGGER legacy_no_update BEFORE UPDATE ON legacy_archives BEGIN SELECT RAISE(ABORT, 'legacy archives are append-only'); END;
CREATE TRIGGER legacy_no_delete BEFORE DELETE ON legacy_archives BEGIN SELECT RAISE(ABORT, 'legacy archives are append-only'); END;
