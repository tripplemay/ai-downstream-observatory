CREATE TABLE postings_v12 (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES ledger_events(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  currency TEXT NOT NULL CHECK(length(currency)=3),
  ledger_account TEXT NOT NULL CHECK(ledger_account IN (
    'cash_settled','trade_receivable','trade_payable','dividend_receivable',
    'transfer_in_transit','inventory_cost','external_capital','opening_equity',
    'income','unclassified_income','expense','fx_bridge','other_liability','cash_hold',
    'inventory_in_transit_cost','capital_valuation_adjustment','dividend_tax_payable'
  )),
  amount TEXT NOT NULL CHECK(typeof(amount)='text')
);
INSERT INTO postings_v12 SELECT * FROM postings;
DROP TABLE postings;
ALTER TABLE postings_v12 RENAME TO postings;
CREATE INDEX postings_event ON postings(event_id);
CREATE TRIGGER postings_same_portfolio BEFORE INSERT ON postings
  WHEN (SELECT portfolio_id FROM accounts WHERE id=NEW.account_id)!=(SELECT portfolio_id FROM ledger_events WHERE id=NEW.event_id)
  BEGIN SELECT RAISE(ABORT,'posting portfolio mismatch'); END;
CREATE TRIGGER postings_no_update BEFORE UPDATE ON postings BEGIN SELECT RAISE(ABORT,'postings are append-only'); END;
CREATE TRIGGER postings_no_delete BEFORE DELETE ON postings BEGIN SELECT RAISE(ABORT,'postings are append-only'); END;
