CREATE TABLE postings_v10 (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES ledger_events(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  currency TEXT NOT NULL CHECK(length(currency)=3),
  ledger_account TEXT NOT NULL CHECK(ledger_account IN (
    'cash_settled','trade_receivable','trade_payable','dividend_receivable',
    'transfer_in_transit','inventory_cost','external_capital','opening_equity',
    'income','unclassified_income','expense','fx_bridge','other_liability','cash_hold',
    'inventory_in_transit_cost','capital_valuation_adjustment'
  )),
  amount TEXT NOT NULL CHECK(typeof(amount)='text')
);
INSERT INTO postings_v10 SELECT * FROM postings;
DROP TABLE postings;
ALTER TABLE postings_v10 RENAME TO postings;
CREATE INDEX postings_event ON postings(event_id);
CREATE TRIGGER postings_same_portfolio BEFORE INSERT ON postings
  WHEN (SELECT portfolio_id FROM accounts WHERE id=NEW.account_id)!=(SELECT portfolio_id FROM ledger_events WHERE id=NEW.event_id)
  BEGIN SELECT RAISE(ABORT,'posting portfolio mismatch'); END;
CREATE TRIGGER postings_no_update BEFORE UPDATE ON postings BEGIN SELECT RAISE(ABORT,'postings are append-only'); END;
CREATE TRIGGER postings_no_delete BEFORE DELETE ON postings BEGIN SELECT RAISE(ABORT,'postings are append-only'); END;

CREATE TABLE security_transit_movements (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES ledger_events(id),
  transfer_event_id TEXT NOT NULL REFERENCES ledger_events(id),
  source_account_id TEXT NOT NULL REFERENCES accounts(id),
  target_account_id TEXT NOT NULL REFERENCES accounts(id),
  listing_id TEXT NOT NULL REFERENCES listings(id),
  currency TEXT NOT NULL CHECK(length(currency)=3),
  quantity TEXT NOT NULL CHECK(typeof(quantity)='text'),
  cost_amount TEXT NOT NULL CHECK(typeof(cost_amount)='text'),
  cost_known INTEGER NOT NULL CHECK(cost_known IN (0,1)),
  CHECK(source_account_id!=target_account_id),
  UNIQUE(event_id,transfer_event_id)
);
CREATE INDEX security_transit_movements_transfer ON security_transit_movements(transfer_event_id,event_id);
CREATE TRIGGER security_transit_movements_scope BEFORE INSERT ON security_transit_movements BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ledger_events e JOIN accounts a ON a.id=NEW.source_account_id JOIN accounts b ON b.id=NEW.target_account_id
    WHERE e.id=NEW.event_id AND e.portfolio_id=a.portfolio_id AND a.portfolio_id=b.portfolio_id)
    THEN RAISE(ABORT,'security transit portfolio mismatch') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ledger_events e JOIN listings l ON l.id=NEW.listing_id
    WHERE e.id=NEW.transfer_event_id AND e.event_type='security_transfer_out' AND e.account_id=NEW.source_account_id
    AND json_extract(e.payload_json,'$.fact.target_account_id')=NEW.target_account_id
    AND json_extract(e.payload_json,'$.fact.listing_id')=NEW.listing_id
    AND json_extract(e.payload_json,'$.fact.currency')=NEW.currency AND l.currency=NEW.currency)
    THEN RAISE(ABORT,'security transit identity mismatch') END;
END;
CREATE TRIGGER security_transit_no_update BEFORE UPDATE ON security_transit_movements BEGIN SELECT RAISE(ABORT,'security transit movements are append-only'); END;
CREATE TRIGGER security_transit_no_delete BEFORE DELETE ON security_transit_movements BEGIN SELECT RAISE(ABORT,'security transit movements are append-only'); END;

CREATE TABLE security_transit_projections (
  transfer_event_id TEXT PRIMARY KEY REFERENCES ledger_events(id),
  source_account_id TEXT NOT NULL REFERENCES accounts(id),
  target_account_id TEXT NOT NULL REFERENCES accounts(id),
  listing_id TEXT NOT NULL REFERENCES listings(id),
  currency TEXT NOT NULL CHECK(length(currency)=3),
  quantity TEXT NOT NULL CHECK(typeof(quantity)='text'),
  cost_amount TEXT NOT NULL CHECK(typeof(cost_amount)='text'),
  cost_known INTEGER NOT NULL CHECK(cost_known IN (0,1)),
  ledger_revision INTEGER NOT NULL CHECK(ledger_revision>=0),
  CHECK(source_account_id!=target_account_id)
);
CREATE INDEX security_transit_projections_scope ON security_transit_projections(source_account_id,listing_id);
