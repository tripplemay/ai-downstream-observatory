CREATE TABLE investor_portfolio_links (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id),
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version>0),
  portfolio_id TEXT REFERENCES portfolios(id),
  creation_audit_id TEXT REFERENCES audit_events(id),
  ledger_revision_at_link INTEGER CHECK(ledger_revision_at_link IS NULL OR (typeof(ledger_revision_at_link)='integer' AND ledger_revision_at_link>=0)),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=4096),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(workspace_id,version),
  CHECK((portfolio_id IS NULL AND creation_audit_id IS NULL AND ledger_revision_at_link IS NULL)
    OR (portfolio_id IS NOT NULL AND creation_audit_id IS NOT NULL AND ledger_revision_at_link IS NOT NULL)),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-portfolio-link-v1'),
  CHECK(json_extract(document_json,'$.portfolio_id') IS portfolio_id),
  CHECK(json_extract(document_json,'$.creation_audit_id') IS creation_audit_id),
  CHECK(json_extract(document_json,'$.ledger_revision_at_link') IS ledger_revision_at_link),
  CHECK(json_extract(document_json,'$.linked_at') IS created_at)
);
CREATE INDEX investor_portfolio_link_history ON investor_portfolio_links(workspace_id,version DESC);
CREATE TRIGGER investor_portfolio_link_insert BEFORE INSERT ON investor_portfolio_links BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_portfolio_links WHERE id=NEW.id OR audit_id=NEW.audit_id)
    OR NEW.version IS NOT (SELECT COALESCE(MAX(version),0)+1 FROM investor_portfolio_links WHERE workspace_id=NEW.workspace_id)
    OR NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR EXISTS(SELECT 1 FROM investor_portfolio_links WHERE workspace_id=NEW.workspace_id AND created_at>NEW.created_at)
    OR NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.id=NEW.audit_id AND a.actor_id=NEW.actor_id
      AND a.action IN ('investor_link_portfolio','investor_create_account_book') AND a.object_type='investor_workspace'
      AND a.object_id=NEW.workspace_id AND a.portfolio_id IS NULL AND a.ledger_revision IS NULL AND a.created_at=NEW.created_at
      AND json_extract(a.payload_json,'$.result.link_id') IS NEW.id
      AND json_extract(a.payload_json,'$.result.execution_authorized') IS 0)
    OR (NEW.portfolio_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM audit_events a JOIN portfolios p ON p.id=NEW.portfolio_id
      JOIN ledger_heads h ON h.portfolio_id=p.id WHERE a.id=NEW.creation_audit_id AND a.actor_id=NEW.actor_id
      AND a.action='create_portfolio' AND a.object_type='portfolio' AND a.object_id=p.id AND a.portfolio_id=p.id
      AND a.ledger_revision=0 AND a.created_at=p.created_at AND a.created_at<=NEW.created_at
      AND h.revision=NEW.ledger_revision_at_link))
    THEN RAISE(ABORT,'investor portfolio link binding differs') END;
END;
CREATE TRIGGER investor_portfolio_link_no_update BEFORE UPDATE ON investor_portfolio_links BEGIN SELECT RAISE(ABORT,'investor portfolio link is immutable'); END;
CREATE TRIGGER investor_portfolio_link_no_delete BEFORE DELETE ON investor_portfolio_links BEGIN SELECT RAISE(ABORT,'investor portfolio link is immutable'); END;
