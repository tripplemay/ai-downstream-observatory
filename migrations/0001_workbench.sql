CREATE TABLE portfolios (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_currency TEXT NOT NULL DEFAULT 'CNY' CHECK(base_currency = 'CNY'),
  performance_inception_at TEXT,
  created_at TEXT NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 0 CHECK(row_version >= 0)
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  name TEXT NOT NULL,
  broker TEXT NOT NULL,
  base_currency TEXT NOT NULL CHECK(length(base_currency) = 3),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','reconciliation_required')),
  created_at TEXT NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 0 CHECK(row_version >= 0),
  UNIQUE(id, portfolio_id)
);

CREATE TABLE ledger_heads (
  portfolio_id TEXT PRIMARY KEY REFERENCES portfolios(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE instruments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  asset_class TEXT NOT NULL DEFAULT 'unknown',
  fund_id TEXT,
  index_id TEXT,
  domicile TEXT,
  exposure_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE listings (
  id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  market TEXT NOT NULL CHECK(market IN ('CN','HK','US')),
  exchange TEXT NOT NULL,
  ticker TEXT NOT NULL,
  currency TEXT NOT NULL CHECK(length(currency) = 3),
  quantity_step TEXT CHECK(quantity_step IS NULL OR typeof(quantity_step) = 'text'),
  price_step TEXT CHECK(price_step IS NULL OR typeof(price_step) = 'text'),
  status TEXT NOT NULL DEFAULT 'unverified' CHECK(status IN ('unverified','active','suspended','delisted')),
  settlement_rule_json TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(market, exchange, ticker)
);

CREATE TABLE ticker_aliases (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id),
  source_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  UNIQUE(source_id, alias, valid_from)
);

CREATE TABLE account_capabilities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  market TEXT NOT NULL CHECK(market IN ('CN','HK','US')),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  rules_json TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE(account_id, market, valid_from)
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  storage_key TEXT NOT NULL UNIQUE,
  retention_policy TEXT NOT NULL DEFAULT 'retain',
  created_at TEXT NOT NULL
);

CREATE TABLE funding_plan_versions (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  version INTEGER NOT NULL CHECK(version > 0),
  currency TEXT NOT NULL DEFAULT 'CNY',
  plan_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(portfolio_id, version)
);

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  account_id TEXT NOT NULL,
  attachment_id TEXT REFERENCES attachments(id),
  content_hash TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  mapping_version TEXT NOT NULL DEFAULT '1',
  status TEXT NOT NULL CHECK(status IN ('preview','invalid','confirmed','cancelled')),
  preview_hash TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
  row_count INTEGER NOT NULL DEFAULT 0 CHECK(row_count >= 0),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK(error_count >= 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  confirmed_revision INTEGER,
  FOREIGN KEY(account_id, portfolio_id) REFERENCES accounts(id, portfolio_id)
);

CREATE TABLE import_rows (
  batch_id TEXT NOT NULL REFERENCES import_batches(id),
  row_number INTEGER NOT NULL CHECK(row_number > 0),
  raw_json TEXT NOT NULL,
  normalized_json TEXT,
  errors_json TEXT NOT NULL DEFAULT '[]',
  source_event_id TEXT,
  PRIMARY KEY(batch_id, row_number)
);

CREATE TABLE ledger_events (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  account_id TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'actual' CHECK(environment = 'actual'),
  event_type TEXT NOT NULL CHECK(length(event_type) > 0),
  effective_at TEXT NOT NULL,
  time_precision TEXT NOT NULL DEFAULT 'second' CHECK(time_precision IN ('second','date')),
  source_timezone TEXT NOT NULL DEFAULT 'UTC',
  recorded_at TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_event_id TEXT,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  reversal_of TEXT REFERENCES ledger_events(id),
  transfer_group_id TEXT,
  execution_item_id TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version > 0),
  ledger_revision INTEGER NOT NULL CHECK(ledger_revision > 0),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  import_batch_id TEXT REFERENCES import_batches(id),
  FOREIGN KEY(account_id, portfolio_id) REFERENCES accounts(id, portfolio_id),
  UNIQUE(portfolio_id, idempotency_key),
  UNIQUE(id, account_id)
);
CREATE UNIQUE INDEX ledger_source_event_unique ON ledger_events(account_id, source_id, source_event_id, event_type)
  WHERE source_event_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_one_reversal ON ledger_events(reversal_of) WHERE reversal_of IS NOT NULL;
CREATE INDEX ledger_events_scope_time ON ledger_events(portfolio_id, effective_at, ledger_revision);
CREATE INDEX ledger_events_account_time ON ledger_events(account_id, effective_at, ledger_revision);

CREATE TABLE postings (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES ledger_events(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  currency TEXT NOT NULL CHECK(length(currency) = 3),
  ledger_account TEXT NOT NULL CHECK(ledger_account IN (
    'cash_settled','trade_receivable','trade_payable','dividend_receivable',
    'transfer_in_transit','inventory_cost','external_capital','opening_equity',
    'income','expense','fx_bridge','other_liability','cash_hold'
  )),
  amount TEXT NOT NULL CHECK(typeof(amount) = 'text')
);
CREATE INDEX postings_event ON postings(event_id);

CREATE TABLE position_movements (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES ledger_events(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  listing_id TEXT NOT NULL REFERENCES listings(id),
  quantity TEXT NOT NULL CHECK(typeof(quantity) = 'text'),
  cost_amount TEXT NOT NULL CHECK(typeof(cost_amount) = 'text'),
  cost_known INTEGER NOT NULL DEFAULT 1 CHECK(cost_known IN (0,1)),
  currency TEXT NOT NULL CHECK(length(currency) = 3)
);
CREATE INDEX position_movements_event ON position_movements(event_id);

CREATE TABLE account_projections (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  currency TEXT NOT NULL CHECK(length(currency) = 3),
  ledger_account TEXT NOT NULL,
  balance TEXT NOT NULL CHECK(typeof(balance) = 'text'),
  ledger_revision INTEGER NOT NULL CHECK(ledger_revision >= 0),
  PRIMARY KEY(account_id, currency, ledger_account)
);

CREATE TABLE position_projections (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  listing_id TEXT NOT NULL REFERENCES listings(id),
  quantity TEXT NOT NULL CHECK(typeof(quantity) = 'text'),
  cost_amount TEXT NOT NULL CHECK(typeof(cost_amount) = 'text'),
  cost_known INTEGER NOT NULL DEFAULT 1 CHECK(cost_known IN (0,1)),
  currency TEXT NOT NULL CHECK(length(currency) = 3),
  ledger_revision INTEGER NOT NULL CHECK(ledger_revision >= 0),
  PRIMARY KEY(account_id, listing_id)
);

CREATE TABLE command_dedup (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(scope, idempotency_key)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  portfolio_id TEXT REFERENCES portfolios(id),
  ledger_revision INTEGER,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX audit_scope_time ON audit_events(portfolio_id, created_at);

CREATE TABLE reconciliation_runs (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  account_id TEXT REFERENCES accounts(id),
  ledger_revision INTEGER NOT NULL,
  attachment_id TEXT REFERENCES attachments(id),
  status TEXT NOT NULL CHECK(status IN ('pending','matched','issues','failed')),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE reconciliation_issues (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES reconciliation_runs(id),
  issue_type TEXT NOT NULL,
  details_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','acknowledged')),
  resolution_json TEXT,
  resolved_by TEXT,
  resolved_at TEXT
);

CREATE TABLE policy_versions (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  version INTEGER NOT NULL CHECK(version > 0),
  policy_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(portfolio_id, version)
);

CREATE TABLE strategy_versions (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  strategy_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  parameters_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(portfolio_id, strategy_key, version)
);

CREATE TABLE activations (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  policy_version_id TEXT NOT NULL REFERENCES policy_versions(id),
  strategy_version_id TEXT REFERENCES strategy_versions(id),
  mode TEXT NOT NULL CHECK(mode IN ('research','simulation','live_advice')),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  evidence_json TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(valid_to IS NULL OR valid_to > valid_from)
);
CREATE UNIQUE INDEX one_open_activation ON activations(portfolio_id, mode) WHERE valid_to IS NULL;

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  environment TEXT NOT NULL CHECK(environment IN ('research','simulation','actual')),
  policy_version_id TEXT NOT NULL REFERENCES policy_versions(id),
  strategy_version_id TEXT REFERENCES strategy_versions(id),
  ledger_revision INTEGER NOT NULL,
  market_manifest TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','blocked','ready')),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE proposal_items (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  listing_id TEXT NOT NULL REFERENCES listings(id),
  side TEXT NOT NULL CHECK(side IN ('buy','sell')),
  currency TEXT NOT NULL,
  quantity TEXT NOT NULL CHECK(typeof(quantity) = 'text'),
  limit_price TEXT NOT NULL CHECK(typeof(limit_price) = 'text'),
  estimated_fees TEXT NOT NULL DEFAULT '0' CHECK(typeof(estimated_fees) = 'text'),
  dependencies_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE risk_runs (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pass','blocked','failed')),
  checks_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE approval_events (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('approve','reject','cancel_remainder','expire','prepare_execution')),
  expected_revision INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  account_id TEXT NOT NULL,
  proposal_item_id TEXT REFERENCES proposal_items(id),
  approval_id TEXT REFERENCES approval_events(id),
  listing_id TEXT REFERENCES listings(id),
  currency TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('buy','sell')),
  amount TEXT NOT NULL DEFAULT '0' CHECK(typeof(amount) = 'text'),
  quantity TEXT NOT NULL DEFAULT '0' CHECK(typeof(quantity) = 'text'),
  status TEXT NOT NULL CHECK(status IN ('active','released','filled','expired')),
  row_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(account_id, portfolio_id) REFERENCES accounts(id, portfolio_id)
);
CREATE INDEX reservations_active_cash ON reservations(account_id, currency, status);
CREATE INDEX reservations_active_shares ON reservations(account_id, listing_id, status);

CREATE TABLE execution_reports (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  account_id TEXT NOT NULL,
  proposal_item_id TEXT REFERENCES proposal_items(id),
  source_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('submitted','partial','filled','cancelled','rejected')),
  payload_json TEXT NOT NULL,
  attachment_id TEXT REFERENCES attachments(id),
  actor_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY(account_id, portfolio_id) REFERENCES accounts(id, portfolio_id),
  UNIQUE(account_id, source_id, source_event_id)
);

CREATE TRIGGER ledger_events_no_update BEFORE UPDATE ON ledger_events BEGIN SELECT RAISE(ABORT, 'ledger events are append-only'); END;
CREATE TRIGGER postings_same_portfolio BEFORE INSERT ON postings
  WHEN (SELECT portfolio_id FROM accounts WHERE id = NEW.account_id) != (SELECT portfolio_id FROM ledger_events WHERE id = NEW.event_id)
  BEGIN SELECT RAISE(ABORT, 'posting portfolio mismatch'); END;
CREATE TRIGGER movements_same_portfolio BEFORE INSERT ON position_movements
  WHEN (SELECT portfolio_id FROM accounts WHERE id = NEW.account_id) != (SELECT portfolio_id FROM ledger_events WHERE id = NEW.event_id)
  BEGIN SELECT RAISE(ABORT, 'movement portfolio mismatch'); END;
CREATE TRIGGER ledger_events_no_delete BEFORE DELETE ON ledger_events BEGIN SELECT RAISE(ABORT, 'ledger events are append-only'); END;
CREATE TRIGGER postings_no_update BEFORE UPDATE ON postings BEGIN SELECT RAISE(ABORT, 'postings are append-only'); END;
CREATE TRIGGER postings_no_delete BEFORE DELETE ON postings BEGIN SELECT RAISE(ABORT, 'postings are append-only'); END;
CREATE TRIGGER position_movements_no_update BEFORE UPDATE ON position_movements BEGIN SELECT RAISE(ABORT, 'position movements are append-only'); END;
CREATE TRIGGER position_movements_no_delete BEFORE DELETE ON position_movements BEGIN SELECT RAISE(ABORT, 'position movements are append-only'); END;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
CREATE TRIGGER policy_versions_no_update BEFORE UPDATE ON policy_versions BEGIN SELECT RAISE(ABORT, 'policy versions are append-only'); END;
CREATE TRIGGER policy_versions_no_delete BEFORE DELETE ON policy_versions BEGIN SELECT RAISE(ABORT, 'policy versions are append-only'); END;
CREATE TRIGGER strategy_versions_no_update BEFORE UPDATE ON strategy_versions BEGIN SELECT RAISE(ABORT, 'strategy versions are append-only'); END;
CREATE TRIGGER strategy_versions_no_delete BEFORE DELETE ON strategy_versions BEGIN SELECT RAISE(ABORT, 'strategy versions are append-only'); END;
CREATE TRIGGER approval_events_no_update BEFORE UPDATE ON approval_events BEGIN SELECT RAISE(ABORT, 'approval events are append-only'); END;
CREATE TRIGGER approval_events_no_delete BEFORE DELETE ON approval_events BEGIN SELECT RAISE(ABORT, 'approval events are append-only'); END;
