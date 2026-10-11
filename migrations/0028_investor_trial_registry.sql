CREATE TABLE investor_experiments (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  implementation_hash TEXT NOT NULL CHECK(length(implementation_hash)=64 AND implementation_hash NOT GLOB '*[^a-f0-9]*'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object'
    AND length(CAST(document_json AS BLOB))<=32768),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  FOREIGN KEY(request_id,workspace_id) REFERENCES investor_research_requests(id,workspace_id),
  UNIQUE(id,workspace_id), UNIQUE(request_id,implementation_hash),
  CHECK(json_extract(document_json,'$.experiment_id') IS id),
  CHECK(json_extract(document_json,'$.request_id') IS request_id),
  CHECK(json_extract(document_json,'$.workspace_id') IS workspace_id),
  CHECK(json_extract(document_json,'$.implementation_hash') IS implementation_hash),
  CHECK(json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_extract(document_json,'$.source_qualification') IS 'synthetic_test_only'),
  CHECK(json_extract(document_json,'$.live_advice_eligible') IS 0)
);

CREATE TABLE investor_trial_intents (
  id TEXT PRIMARY KEY NOT NULL,
  experiment_id TEXT NOT NULL REFERENCES investor_experiments(id),
  phase TEXT NOT NULL CHECK(phase IN ('train','validation','holdout')),
  parameters_hash TEXT NOT NULL CHECK(length(parameters_hash)=64 AND parameters_hash NOT GLOB '*[^a-f0-9]*'),
  window_start_us INTEGER NOT NULL,
  window_end_us INTEGER NOT NULL CHECK(window_end_us>=window_start_us),
  job_id TEXT NOT NULL REFERENCES job_runs(id),
  fencing_token INTEGER NOT NULL CHECK(fencing_token>0),
  created_at TEXT NOT NULL,
  UNIQUE(id,experiment_id), UNIQUE(experiment_id,phase,parameters_hash)
);
CREATE INDEX investor_trial_exposure_window ON investor_trial_intents(window_start_us,window_end_us);

CREATE TABLE investor_trial_results (
  trial_id TEXT PRIMARY KEY NOT NULL REFERENCES investor_trial_intents(id),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object'
    AND length(CAST(document_json AS BLOB))<=65536),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  job_id TEXT NOT NULL REFERENCES job_runs(id),
  fencing_token INTEGER NOT NULL CHECK(fencing_token>0),
  created_at TEXT NOT NULL
);

CREATE TABLE investor_candidate_freezes (
  experiment_id TEXT PRIMARY KEY NOT NULL REFERENCES investor_experiments(id),
  parameters_hash TEXT NOT NULL CHECK(length(parameters_hash)=64 AND parameters_hash NOT GLOB '*[^a-f0-9]*'),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='object'
    AND length(CAST(evidence_json AS BLOB))<=32768),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  job_id TEXT NOT NULL REFERENCES job_runs(id),
  fencing_token INTEGER NOT NULL CHECK(fencing_token>0),
  created_at TEXT NOT NULL,
  CHECK(json_extract(evidence_json,'$.parameters_hash') IS parameters_hash),
  CHECK(json_extract(evidence_json,'$.experiment_id') IS experiment_id),
  CHECK(json_extract(evidence_json,'$.selection_basis') IS 'train_only')
);

CREATE TRIGGER investor_experiment_insert BEFORE INSERT ON investor_experiments BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_experiments WHERE id=NEW.id OR
    (request_id=NEW.request_id AND implementation_hash=NEW.implementation_hash))
    OR NOT EXISTS(SELECT 1 FROM investor_research_requests r JOIN job_runs j ON j.period=r.id
      JOIN investor_research_inputs i ON i.id=r.input_id AND i.workspace_id=r.workspace_id
      WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id AND j.scope=r.workspace_id
      AND j.job_type='investor_research' AND j.command_request_id IS NULL AND j.status='running'
      AND j.input_version=r.input_version AND i.source_qualification='synthetic_test_only'
      AND json_extract(NEW.document_json,'$.input_version') IS r.input_version)
    THEN RAISE(ABORT,'investor experiment cannot be replaced') END;
END;
CREATE TRIGGER investor_experiment_no_update BEFORE UPDATE ON investor_experiments BEGIN SELECT RAISE(ABORT,'investor experiment is immutable'); END;
CREATE TRIGGER investor_experiment_no_delete BEFORE DELETE ON investor_experiments BEGIN SELECT RAISE(ABORT,'investor experiment is immutable'); END;

CREATE TRIGGER investor_trial_intent_insert BEFORE INSERT ON investor_trial_intents BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_trial_intents WHERE id=NEW.id OR
    (experiment_id=NEW.experiment_id AND phase=NEW.phase AND parameters_hash=NEW.parameters_hash))
    OR NOT EXISTS(SELECT 1 FROM investor_experiments e JOIN job_runs j ON j.period=e.request_id
      WHERE e.id=NEW.experiment_id AND j.id=NEW.job_id AND j.scope=e.workspace_id
      AND j.job_type='investor_research' AND j.command_request_id IS NULL
      AND j.status='running' AND j.fencing_token=NEW.fencing_token)
    OR NOT EXISTS(SELECT 1 FROM investor_experiments e,json_each(e.document_json,'$.candidate_hashes') c
      WHERE e.id=NEW.experiment_id AND c.value=NEW.parameters_hash)
    OR (SELECT count(*) FROM investor_trial_intents WHERE experiment_id=NEW.experiment_id AND phase=NEW.phase)
      >= (SELECT json_extract(document_json,'$.trial_budgets.'||NEW.phase) FROM investor_experiments WHERE id=NEW.experiment_id)
    OR (NEW.phase='train' AND EXISTS(SELECT 1 FROM investor_candidate_freezes WHERE experiment_id=NEW.experiment_id))
    OR (NEW.phase!='train' AND NOT EXISTS(SELECT 1 FROM investor_candidate_freezes WHERE experiment_id=NEW.experiment_id AND parameters_hash=NEW.parameters_hash))
    OR (NEW.phase='holdout' AND NOT EXISTS(SELECT 1 FROM investor_trial_intents t JOIN investor_trial_results r ON r.trial_id=t.id
      WHERE t.experiment_id=NEW.experiment_id AND t.phase='validation' AND t.parameters_hash=NEW.parameters_hash))
    THEN RAISE(ABORT,'investor trial binding or budget differs') END;
END;
CREATE TRIGGER investor_trial_intent_no_update BEFORE UPDATE ON investor_trial_intents BEGIN SELECT RAISE(ABORT,'investor trial is immutable'); END;
CREATE TRIGGER investor_trial_intent_no_delete BEFORE DELETE ON investor_trial_intents BEGIN SELECT RAISE(ABORT,'investor trial is immutable'); END;

CREATE TRIGGER investor_trial_result_insert BEFORE INSERT ON investor_trial_results BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_trial_results WHERE trial_id=NEW.trial_id)
    OR NOT EXISTS(SELECT 1 FROM investor_trial_intents t JOIN investor_experiments e ON e.id=t.experiment_id
      JOIN job_runs j ON j.period=e.request_id WHERE t.id=NEW.trial_id AND j.id=NEW.job_id
      AND j.scope=e.workspace_id AND j.job_type='investor_research' AND j.command_request_id IS NULL
      AND j.status='running' AND j.fencing_token=NEW.fencing_token
      AND json_extract(NEW.document_json,'$.phase') IS t.phase)
    THEN RAISE(ABORT,'investor trial result binding differs') END;
END;
CREATE TRIGGER investor_trial_result_no_update BEFORE UPDATE ON investor_trial_results BEGIN SELECT RAISE(ABORT,'investor trial result is immutable'); END;
CREATE TRIGGER investor_trial_result_no_delete BEFORE DELETE ON investor_trial_results BEGIN SELECT RAISE(ABORT,'investor trial result is immutable'); END;

CREATE TRIGGER investor_candidate_freeze_insert BEFORE INSERT ON investor_candidate_freezes BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_candidate_freezes WHERE experiment_id=NEW.experiment_id)
    OR NOT EXISTS(SELECT 1 FROM investor_experiments e JOIN job_runs j ON j.period=e.request_id
      WHERE e.id=NEW.experiment_id AND j.id=NEW.job_id AND j.scope=e.workspace_id
      AND j.job_type='investor_research' AND j.command_request_id IS NULL
      AND j.status='running' AND j.fencing_token=NEW.fencing_token)
    OR NOT EXISTS(SELECT 1 FROM investor_trial_intents t JOIN investor_trial_results r ON r.trial_id=t.id
      WHERE t.experiment_id=NEW.experiment_id AND t.phase='train' AND t.parameters_hash=NEW.parameters_hash)
    OR (SELECT count(*) FROM investor_trial_intents t JOIN investor_trial_results r ON r.trial_id=t.id
      WHERE t.experiment_id=NEW.experiment_id AND t.phase='train')
      != (SELECT json_array_length(document_json,'$.candidate_hashes') FROM investor_experiments WHERE id=NEW.experiment_id)
    THEN RAISE(ABORT,'investor freeze requires completed train evidence') END;
END;
CREATE TRIGGER investor_candidate_freeze_no_update BEFORE UPDATE ON investor_candidate_freezes BEGIN SELECT RAISE(ABORT,'investor candidate is immutable'); END;
CREATE TRIGGER investor_candidate_freeze_no_delete BEFORE DELETE ON investor_candidate_freezes BEGIN SELECT RAISE(ABORT,'investor candidate is immutable'); END;
