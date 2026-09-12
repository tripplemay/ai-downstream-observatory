CREATE INDEX ledger_events_latest_effective
  ON ledger_events(portfolio_id, julianday(effective_at) DESC, ledger_revision DESC);

CREATE INDEX ledger_events_related_outstanding
  ON ledger_events(portfolio_id, json_extract(payload_json, '$.fact.related_event_id'))
  WHERE reversal_of IS NULL;
