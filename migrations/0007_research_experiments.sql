CREATE TABLE research_experiments (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  plan_json TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  dataset_manifest_json TEXT NOT NULL,
  dataset_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX research_experiment_dataset ON research_experiments(dataset_hash);

CREATE TABLE research_trials (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES research_experiments(id),
  run_id TEXT NOT NULL UNIQUE REFERENCES research_runs(id),
  trial_number INTEGER NOT NULL CHECK(trial_number > 0),
  phase TEXT NOT NULL CHECK(phase IN ('train','validation','holdout')),
  parameters_json TEXT NOT NULL,
  parameters_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(experiment_id,trial_number),
  UNIQUE(experiment_id,idempotency_key)
);

CREATE TABLE research_holdout_events (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES research_experiments(id),
  trial_id TEXT REFERENCES research_trials(id),
  action TEXT NOT NULL CHECK(action IN ('freeze_candidate','unseal')),
  parameters_hash TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(experiment_id,action)
);

CREATE TRIGGER experiments_no_update BEFORE UPDATE ON research_experiments BEGIN SELECT RAISE(ABORT, 'experiment registration is immutable'); END;
CREATE TRIGGER experiments_no_delete BEFORE DELETE ON research_experiments BEGIN SELECT RAISE(ABORT, 'experiment registration is immutable'); END;
CREATE TRIGGER trials_no_update BEFORE UPDATE ON research_trials BEGIN SELECT RAISE(ABORT, 'trial registration is immutable'); END;
CREATE TRIGGER trials_no_delete BEFORE DELETE ON research_trials BEGIN SELECT RAISE(ABORT, 'trial registration is immutable'); END;
CREATE TRIGGER holdout_no_update BEFORE UPDATE ON research_holdout_events BEGIN SELECT RAISE(ABORT, 'holdout history is immutable'); END;
CREATE TRIGGER holdout_no_delete BEFORE DELETE ON research_holdout_events BEGIN SELECT RAISE(ABORT, 'holdout history is immutable'); END;
CREATE TRIGGER trial_portfolio_scope BEFORE INSERT ON research_trials
  WHEN (SELECT portfolio_id FROM research_experiments WHERE id=NEW.experiment_id)
    != (SELECT portfolio_id FROM research_runs WHERE id=NEW.run_id)
  BEGIN SELECT RAISE(ABORT, 'trial portfolio mismatch'); END;
CREATE TRIGGER holdout_trial_scope BEFORE INSERT ON research_holdout_events
  WHEN NEW.trial_id IS NOT NULL AND (SELECT experiment_id FROM research_trials WHERE id=NEW.trial_id) != NEW.experiment_id
  BEGIN SELECT RAISE(ABORT, 'holdout trial scope mismatch'); END;
CREATE TRIGGER holdout_unseal_requires_candidate BEFORE INSERT ON research_holdout_events
  WHEN NEW.action='unseal' AND NOT EXISTS (SELECT 1 FROM research_holdout_events h
    WHERE h.experiment_id=NEW.experiment_id AND h.action='freeze_candidate' AND h.parameters_hash=NEW.parameters_hash)
  BEGIN SELECT RAISE(ABORT, 'holdout unseal requires frozen candidate'); END;
CREATE TRIGGER research_run_freeze_registered BEFORE UPDATE ON research_runs
  WHEN EXISTS (SELECT 1 FROM research_trials t WHERE t.run_id=OLD.id) AND (
    NEW.id != OLD.id OR NEW.portfolio_id != OLD.portfolio_id OR NEW.environment != OLD.environment
    OR NEW.strategy_version_id IS NOT OLD.strategy_version_id OR NEW.policy_version_id IS NOT OLD.policy_version_id
    OR NEW.input_manifest != OLD.input_manifest OR NEW.experiment_plan_json != OLD.experiment_plan_json
    OR NEW.created_at != OLD.created_at OR OLD.status IN ('succeeded','failed','cancelled')
    OR (OLD.status='queued' AND NEW.status NOT IN ('running','failed','cancelled'))
    OR (OLD.status='running' AND NEW.status NOT IN ('succeeded','failed','cancelled')))
  BEGIN SELECT RAISE(ABORT, 'registered research run metadata or terminal result is immutable'); END;
