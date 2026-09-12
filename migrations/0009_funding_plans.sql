CREATE UNIQUE INDEX funding_versions_scope ON funding_plan_versions(id, portfolio_id);

CREATE TABLE funding_plan_heads (
  portfolio_id TEXT PRIMARY KEY REFERENCES portfolios(id),
  current_version_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  updated_at TEXT NOT NULL,
  FOREIGN KEY(current_version_id, portfolio_id) REFERENCES funding_plan_versions(id, portfolio_id)
);

CREATE TABLE funding_plan_items (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL,
  plan_version_id TEXT NOT NULL,
  logical_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('source','tranche')),
  parent_key TEXT,
  currency TEXT NOT NULL,
  planned_amount TEXT NOT NULL CHECK(typeof(planned_amount)='text'),
  item_json TEXT NOT NULL,
  UNIQUE(plan_version_id, logical_id),
  UNIQUE(id, portfolio_id),
  FOREIGN KEY(plan_version_id, portfolio_id) REFERENCES funding_plan_versions(id, portfolio_id),
  FOREIGN KEY(plan_version_id, parent_key) REFERENCES funding_plan_items(plan_version_id, logical_id),
  CHECK((kind='source' AND parent_key IS NULL) OR (kind='tranche' AND parent_key IS NOT NULL))
);
CREATE INDEX funding_items_logical ON funding_plan_items(portfolio_id, logical_id, plan_version_id);

CREATE TABLE funding_plan_links (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  plan_item_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('receipt_attach','receipt_detach','execution_attach','execution_detach')),
  ledger_event_id TEXT REFERENCES ledger_events(id),
  proposal_item_id TEXT REFERENCES proposal_items(id),
  amount TEXT CHECK(amount IS NULL OR typeof(amount)='text'),
  currency TEXT NOT NULL,
  reverses_link_id TEXT UNIQUE REFERENCES funding_plan_links(id),
  funding_revision INTEGER NOT NULL CHECK(funding_revision>0),
  ledger_revision INTEGER NOT NULL CHECK(ledger_revision>=0),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(plan_item_id, portfolio_id) REFERENCES funding_plan_items(id, portfolio_id),
  CHECK((action LIKE 'receipt_%' AND ledger_event_id IS NOT NULL AND proposal_item_id IS NULL AND amount IS NOT NULL)
     OR (action LIKE 'execution_%' AND ledger_event_id IS NULL AND proposal_item_id IS NOT NULL AND amount IS NULL)),
  CHECK((action LIKE '%_attach' AND reverses_link_id IS NULL) OR (action LIKE '%_detach' AND reverses_link_id IS NOT NULL))
);
CREATE INDEX funding_links_scope ON funding_plan_links(portfolio_id, funding_revision, id);
CREATE INDEX funding_links_receipts ON funding_plan_links(ledger_event_id, action);
CREATE INDEX funding_links_executions ON funding_plan_links(proposal_item_id, action);

CREATE TRIGGER funding_item_no_update BEFORE UPDATE ON funding_plan_items BEGIN SELECT RAISE(ABORT,'funding items are append-only'); END;
CREATE TRIGGER funding_item_no_delete BEFORE DELETE ON funding_plan_items BEGIN SELECT RAISE(ABORT,'funding items are append-only'); END;
CREATE TRIGGER funding_item_parent BEFORE INSERT ON funding_plan_items WHEN NEW.kind='tranche' BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM funding_plan_items i WHERE i.plan_version_id=NEW.plan_version_id AND i.logical_id=NEW.parent_key AND i.kind='source' AND i.portfolio_id=NEW.portfolio_id AND i.currency=NEW.currency) THEN RAISE(ABORT,'funding tranche source mismatch') END;
END;
CREATE TRIGGER funding_link_no_update BEFORE UPDATE ON funding_plan_links BEGIN SELECT RAISE(ABORT,'funding links are append-only'); END;
CREATE TRIGGER funding_link_no_delete BEFORE DELETE ON funding_plan_links BEGIN SELECT RAISE(ABORT,'funding links are append-only'); END;
CREATE TRIGGER funding_head_revision BEFORE UPDATE ON funding_plan_heads WHEN NEW.revision != OLD.revision+1 OR NEW.portfolio_id != OLD.portfolio_id
BEGIN SELECT RAISE(ABORT,'funding head revision must advance once'); END;
CREATE TRIGGER funding_head_no_delete BEFORE DELETE ON funding_plan_heads BEGIN SELECT RAISE(ABORT,'funding heads cannot be deleted'); END;

CREATE TRIGGER funding_link_scope BEFORE INSERT ON funding_plan_links BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM funding_plan_items i WHERE i.id=NEW.plan_item_id AND i.portfolio_id=NEW.portfolio_id AND i.currency=NEW.currency
    AND i.kind=CASE WHEN NEW.action LIKE 'receipt_%' THEN 'source' ELSE 'tranche' END) THEN RAISE(ABORT,'funding link item scope mismatch') END;
  SELECT CASE WHEN NEW.ledger_event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ledger_events e WHERE e.id=NEW.ledger_event_id AND e.portfolio_id=NEW.portfolio_id AND e.event_type IN ('deposit','opening_cash') AND json_extract(e.payload_json,'$.fact.currency')=NEW.currency) THEN RAISE(ABORT,'funding receipt scope mismatch') END;
  SELECT CASE WHEN NEW.proposal_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM proposal_items i JOIN proposals p ON p.id=i.proposal_id WHERE i.id=NEW.proposal_item_id AND p.portfolio_id=NEW.portfolio_id AND p.environment='actual' AND i.side='buy' AND i.currency=NEW.currency) THEN RAISE(ABORT,'funding execution scope mismatch') END;
  SELECT CASE WHEN NEW.reverses_link_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM funding_plan_links l WHERE l.id=NEW.reverses_link_id AND l.portfolio_id=NEW.portfolio_id AND l.plan_item_id=NEW.plan_item_id AND l.currency=NEW.currency AND l.ledger_event_id IS NEW.ledger_event_id AND l.proposal_item_id IS NEW.proposal_item_id AND l.amount IS NEW.amount AND l.action=replace(NEW.action,'_detach','_attach')) THEN RAISE(ABORT,'funding reversal scope mismatch') END;
  SELECT CASE WHEN NEW.action='execution_attach' AND EXISTS(SELECT 1 FROM funding_plan_links l WHERE l.proposal_item_id=NEW.proposal_item_id AND l.action='execution_attach' AND NOT EXISTS(SELECT 1 FROM funding_plan_links r WHERE r.reverses_link_id=l.id)) THEN RAISE(ABORT,'funding execution already linked') END;
END;
