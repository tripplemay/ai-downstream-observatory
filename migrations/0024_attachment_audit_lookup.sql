CREATE INDEX audit_attachment_scope_lookup
  ON audit_events(object_id, portfolio_id)
  WHERE action = 'store_attachment' AND object_type = 'attachment';
