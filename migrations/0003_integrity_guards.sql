CREATE TRIGGER activations_scope_insert BEFORE INSERT ON activations
  WHEN (SELECT portfolio_id FROM policy_versions WHERE id = NEW.policy_version_id) != NEW.portfolio_id
    OR (NEW.strategy_version_id IS NOT NULL AND (SELECT portfolio_id FROM strategy_versions WHERE id = NEW.strategy_version_id) != NEW.portfolio_id)
  BEGIN SELECT RAISE(ABORT, 'activation portfolio mismatch'); END;
CREATE TRIGGER activations_scope_update BEFORE UPDATE ON activations
  WHEN NEW.id != OLD.id OR NEW.portfolio_id != OLD.portfolio_id OR NEW.policy_version_id != OLD.policy_version_id
    OR NEW.strategy_version_id IS NOT OLD.strategy_version_id OR NEW.mode != OLD.mode OR NEW.valid_from != OLD.valid_from
    OR NEW.evidence_json != OLD.evidence_json OR NEW.approved_by != OLD.approved_by OR NEW.created_at != OLD.created_at
    OR OLD.valid_to IS NOT NULL OR NEW.valid_to IS NULL
  BEGIN SELECT RAISE(ABORT, 'only closing an open activation is permitted'); END;
CREATE TRIGGER activations_no_delete BEFORE DELETE ON activations BEGIN SELECT RAISE(ABORT, 'activation history cannot be deleted'); END;
CREATE TRIGGER activations_no_overlap BEFORE INSERT ON activations
  WHEN EXISTS (SELECT 1 FROM activations a WHERE a.portfolio_id = NEW.portfolio_id AND a.mode = NEW.mode
    AND (a.valid_to IS NULL OR NEW.valid_from < a.valid_to)
    AND (NEW.valid_to IS NULL OR a.valid_from < NEW.valid_to))
  BEGIN SELECT RAISE(ABORT, 'activation interval overlaps'); END;

CREATE TRIGGER capabilities_no_overlap BEFORE INSERT ON account_capabilities
  WHEN EXISTS (SELECT 1 FROM account_capabilities a WHERE a.account_id = NEW.account_id AND a.market = NEW.market
    AND (a.valid_to IS NULL OR NEW.valid_from < a.valid_to)
    AND (NEW.valid_to IS NULL OR a.valid_from < NEW.valid_to))
  BEGIN SELECT RAISE(ABORT, 'account capability interval overlaps'); END;

CREATE TRIGGER proposal_scope BEFORE INSERT ON proposals
  WHEN (SELECT portfolio_id FROM policy_versions WHERE id = NEW.policy_version_id) != NEW.portfolio_id
    OR (NEW.strategy_version_id IS NOT NULL AND (SELECT portfolio_id FROM strategy_versions WHERE id = NEW.strategy_version_id) != NEW.portfolio_id)
  BEGIN SELECT RAISE(ABORT, 'proposal portfolio mismatch'); END;
CREATE TRIGGER proposal_item_scope BEFORE INSERT ON proposal_items
  WHEN (SELECT portfolio_id FROM accounts WHERE id = NEW.account_id) != (SELECT portfolio_id FROM proposals WHERE id = NEW.proposal_id)
  BEGIN SELECT RAISE(ABORT, 'proposal item portfolio mismatch'); END;
CREATE TRIGGER reservation_item_scope BEFORE INSERT ON reservations
  WHEN NEW.proposal_item_id IS NOT NULL AND (
    (SELECT account_id FROM proposal_items WHERE id = NEW.proposal_item_id) != NEW.account_id
    OR (SELECT portfolio_id FROM proposals WHERE id = (SELECT proposal_id FROM proposal_items WHERE id = NEW.proposal_item_id)) != NEW.portfolio_id)
  BEGIN SELECT RAISE(ABORT, 'reservation proposal scope mismatch'); END;
CREATE TRIGGER evaluation_scope BEFORE INSERT ON evaluation_cycles
  WHEN (SELECT portfolio_id FROM policy_versions WHERE id = NEW.policy_version_id) != NEW.portfolio_id
    OR (SELECT portfolio_id FROM strategy_versions WHERE id = NEW.strategy_version_id) != NEW.portfolio_id
  BEGIN SELECT RAISE(ABORT, 'evaluation portfolio mismatch'); END;
CREATE TRIGGER research_scope BEFORE INSERT ON research_runs
  WHEN (NEW.policy_version_id IS NOT NULL AND (SELECT portfolio_id FROM policy_versions WHERE id = NEW.policy_version_id) != NEW.portfolio_id)
    OR (NEW.strategy_version_id IS NOT NULL AND (SELECT portfolio_id FROM strategy_versions WHERE id = NEW.strategy_version_id) != NEW.portfolio_id)
  BEGIN SELECT RAISE(ABORT, 'research portfolio mismatch'); END;
CREATE TRIGGER simulation_run_environment BEFORE INSERT ON simulation_events
  WHEN NEW.environment != (SELECT environment FROM research_runs WHERE id = NEW.run_id)
  BEGIN SELECT RAISE(ABORT, 'simulation environment mismatch'); END;

CREATE TRIGGER market_publication_validated_insert BEFORE INSERT ON market_publications
  WHEN NOT EXISTS (SELECT 1 FROM market_batches b WHERE b.id = NEW.batch_id AND b.status IN ('validated','published') AND b.manifest_hash = NEW.manifest_hash)
  BEGIN SELECT RAISE(ABORT, 'market publication requires validated matching manifest'); END;
CREATE TRIGGER market_publication_validated_update BEFORE UPDATE ON market_publications
  WHEN NEW.scope != OLD.scope OR NEW.revision <= OLD.revision
    OR NOT EXISTS (SELECT 1 FROM market_batches b WHERE b.id = NEW.batch_id AND b.status IN ('validated','published') AND b.manifest_hash = NEW.manifest_hash)
  BEGIN SELECT RAISE(ABORT, 'market publication requires newer validated matching manifest'); END;

CREATE TRIGGER proposals_no_update BEFORE UPDATE ON proposals BEGIN SELECT RAISE(ABORT, 'proposal versions are append-only'); END;
CREATE TRIGGER proposals_no_delete BEFORE DELETE ON proposals BEGIN SELECT RAISE(ABORT, 'proposal versions are append-only'); END;
CREATE TRIGGER proposal_items_no_update BEFORE UPDATE ON proposal_items BEGIN SELECT RAISE(ABORT, 'proposal items are append-only'); END;
CREATE TRIGGER proposal_items_no_delete BEFORE DELETE ON proposal_items BEGIN SELECT RAISE(ABORT, 'proposal items are append-only'); END;
CREATE TRIGGER risk_runs_no_update BEFORE UPDATE ON risk_runs BEGIN SELECT RAISE(ABORT, 'risk evidence is append-only'); END;
CREATE TRIGGER risk_runs_no_delete BEFORE DELETE ON risk_runs BEGIN SELECT RAISE(ABORT, 'risk evidence is append-only'); END;
CREATE TRIGGER funding_plan_no_update BEFORE UPDATE ON funding_plan_versions BEGIN SELECT RAISE(ABORT, 'funding plans are append-only'); END;
CREATE TRIGGER funding_plan_no_delete BEFORE DELETE ON funding_plan_versions BEGIN SELECT RAISE(ABORT, 'funding plans are append-only'); END;
CREATE TRIGGER execution_reports_no_update BEFORE UPDATE ON execution_reports BEGIN SELECT RAISE(ABORT, 'execution reports are append-only'); END;
CREATE TRIGGER execution_reports_no_delete BEFORE DELETE ON execution_reports BEGIN SELECT RAISE(ABORT, 'execution reports are append-only'); END;
CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
CREATE TRIGGER research_notes_no_update BEFORE UPDATE ON research_notes BEGIN SELECT RAISE(ABORT, 'research note versions are append-only'); END;
CREATE TRIGGER research_notes_no_delete BEFORE DELETE ON research_notes BEGIN SELECT RAISE(ABORT, 'research note versions are append-only'); END;
CREATE TRIGGER command_dedup_no_update BEFORE UPDATE ON command_dedup BEGIN SELECT RAISE(ABORT, 'command result is immutable'); END;
CREATE TRIGGER command_dedup_no_delete BEFORE DELETE ON command_dedup BEGIN SELECT RAISE(ABORT, 'command result is immutable'); END;
