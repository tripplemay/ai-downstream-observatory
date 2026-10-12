CREATE TABLE investor_evidence_inputs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id),
  source_qualification TEXT NOT NULL CHECK(source_qualification='owner_reviewed_reconstructed'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=1048576),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  valid_until TEXT NOT NULL CHECK(valid_until>created_at),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,content_hash),
  CHECK(json_extract(document_json,'$.source_qualification') IS source_qualification),
  CHECK(json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_extract(document_json,'$.valid_until') IS valid_until)
);
CREATE TRIGGER investor_evidence_input_insert BEFORE INSERT ON investor_evidence_inputs BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_evidence_inputs WHERE id=NEW.id OR (workspace_id=NEW.workspace_id AND content_hash=NEW.content_hash))
    OR NOT EXISTS(SELECT 1 FROM investor_workspaces w JOIN audit_events a ON a.id=NEW.audit_id
      WHERE w.id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND a.actor_id=NEW.actor_id
      AND a.action='investor_admit_research_source' AND a.object_type='investor_evidence_input' AND a.object_id=NEW.id
      AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'investor evidence input binding differs') END;
END;
CREATE TRIGGER investor_evidence_input_no_update BEFORE UPDATE ON investor_evidence_inputs BEGIN SELECT RAISE(ABORT,'investor evidence input is immutable'); END;
CREATE TRIGGER investor_evidence_input_no_delete BEFORE DELETE ON investor_evidence_inputs BEGIN SELECT RAISE(ABORT,'investor evidence input is immutable'); END;

ALTER TABLE investor_research_requests ADD COLUMN evidence_input_id TEXT REFERENCES investor_evidence_inputs(id);
CREATE TRIGGER investor_research_evidence_request_insert BEFORE INSERT ON investor_research_requests BEGIN
  SELECT CASE WHEN NEW.evidence_input_id IS NOT NULL AND (NEW.input_id IS NOT NULL OR NOT EXISTS(
    SELECT 1 FROM investor_evidence_inputs i WHERE i.id=NEW.evidence_input_id AND i.workspace_id=NEW.workspace_id
      AND i.created_at<=NEW.created_at
      AND json_extract(NEW.document_json,'$.input_hash') IS i.content_hash))
    THEN RAISE(ABORT,'investor evidence request binding differs') END;
END;
CREATE VIEW investor_research_source_heads AS
  SELECT id,workspace_id,content_hash,created_at,source_qualification,rowid source_order,'synthetic' source_kind FROM investor_research_inputs
  UNION ALL
  SELECT id,workspace_id,content_hash,created_at,source_qualification,rowid source_order,'evidence' source_kind FROM investor_evidence_inputs;

-- Replace only the registry schema, retaining every historical row and rowid.
-- Trial rowids are publication watermarks and must not be renumbered.
CREATE TABLE investor_experiments_next (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  implementation_hash TEXT NOT NULL CHECK(length(implementation_hash)=64 AND implementation_hash NOT GLOB '*[^a-f0-9]*'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=32768),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  FOREIGN KEY(request_id,workspace_id) REFERENCES investor_research_requests(id,workspace_id),
  UNIQUE(id,workspace_id), UNIQUE(request_id,implementation_hash),
  CHECK(json_extract(document_json,'$.experiment_id') IS id), CHECK(json_extract(document_json,'$.request_id') IS request_id),
  CHECK(json_extract(document_json,'$.workspace_id') IS workspace_id), CHECK(json_extract(document_json,'$.implementation_hash') IS implementation_hash),
  CHECK(json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_extract(document_json,'$.source_qualification') IN ('synthetic_test_only','owner_reviewed_reconstructed')),
  CHECK(json_extract(document_json,'$.source_qualification') IS NOT NULL),
  CHECK(json_extract(document_json,'$.live_advice_eligible') IS 0)
);
CREATE TABLE investor_trial_intents_next (
  id TEXT PRIMARY KEY NOT NULL, experiment_id TEXT NOT NULL REFERENCES investor_experiments_next(id),
  phase TEXT NOT NULL CHECK(phase IN ('train','validation','holdout')),
  parameters_hash TEXT NOT NULL CHECK(length(parameters_hash)=64 AND parameters_hash NOT GLOB '*[^a-f0-9]*'),
  window_start_us INTEGER NOT NULL, window_end_us INTEGER NOT NULL CHECK(window_end_us>=window_start_us),
  job_id TEXT NOT NULL REFERENCES job_runs(id), fencing_token INTEGER NOT NULL CHECK(fencing_token>0), created_at TEXT NOT NULL,
  UNIQUE(id,experiment_id), UNIQUE(experiment_id,phase,parameters_hash)
);
CREATE TABLE investor_trial_results_next (
  trial_id TEXT PRIMARY KEY NOT NULL REFERENCES investor_trial_intents_next(id),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=65536),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  job_id TEXT NOT NULL REFERENCES job_runs(id), fencing_token INTEGER NOT NULL CHECK(fencing_token>0), created_at TEXT NOT NULL
);
CREATE TABLE investor_candidate_freezes_next (
  experiment_id TEXT PRIMARY KEY NOT NULL REFERENCES investor_experiments_next(id),
  parameters_hash TEXT NOT NULL CHECK(length(parameters_hash)=64 AND parameters_hash NOT GLOB '*[^a-f0-9]*'),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='object' AND length(CAST(evidence_json AS BLOB))<=32768),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  job_id TEXT NOT NULL REFERENCES job_runs(id), fencing_token INTEGER NOT NULL CHECK(fencing_token>0), created_at TEXT NOT NULL,
  CHECK(json_extract(evidence_json,'$.parameters_hash') IS parameters_hash), CHECK(json_extract(evidence_json,'$.experiment_id') IS experiment_id),
  CHECK(json_extract(evidence_json,'$.selection_basis') IS 'train_only')
);
INSERT INTO investor_experiments_next(rowid,id,workspace_id,request_id,implementation_hash,document_json,content_hash,created_at) SELECT rowid,* FROM investor_experiments;
INSERT INTO investor_trial_intents_next(rowid,id,experiment_id,phase,parameters_hash,window_start_us,window_end_us,job_id,fencing_token,created_at) SELECT rowid,* FROM investor_trial_intents;
INSERT INTO investor_trial_results_next(rowid,trial_id,document_json,content_hash,job_id,fencing_token,created_at) SELECT rowid,* FROM investor_trial_results;
INSERT INTO investor_candidate_freezes_next(rowid,experiment_id,parameters_hash,evidence_json,content_hash,job_id,fencing_token,created_at) SELECT rowid,* FROM investor_candidate_freezes;
DROP TABLE investor_candidate_freezes;
DROP TABLE investor_trial_results;
DROP TABLE investor_trial_intents;
DROP TABLE investor_experiments;
ALTER TABLE investor_experiments_next RENAME TO investor_experiments;
ALTER TABLE investor_trial_intents_next RENAME TO investor_trial_intents;
ALTER TABLE investor_trial_results_next RENAME TO investor_trial_results;
ALTER TABLE investor_candidate_freezes_next RENAME TO investor_candidate_freezes;
CREATE INDEX investor_trial_exposure_window ON investor_trial_intents(window_start_us,window_end_us);

CREATE TRIGGER investor_experiment_insert BEFORE INSERT ON investor_experiments BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_experiments WHERE id=NEW.id OR (request_id=NEW.request_id AND implementation_hash=NEW.implementation_hash))
    OR NOT EXISTS(SELECT 1 FROM investor_research_requests r JOIN job_runs j ON j.period=r.id
      LEFT JOIN investor_research_inputs s ON s.id=r.input_id AND s.workspace_id=r.workspace_id
      LEFT JOIN investor_evidence_inputs e ON e.id=r.evidence_input_id AND e.workspace_id=r.workspace_id
      WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id AND j.scope=r.workspace_id
      AND j.job_type='investor_research' AND j.command_request_id IS NULL AND j.status='running' AND j.input_version=r.input_version
      AND json_extract(NEW.document_json,'$.input_version') IS r.input_version
      AND ((s.source_qualification='synthetic_test_only' AND r.evidence_input_id IS NULL AND json_extract(NEW.document_json,'$.source_qualification') IS s.source_qualification)
        OR (e.source_qualification='owner_reviewed_reconstructed' AND r.input_id IS NULL AND NEW.created_at<e.valid_until AND json_extract(NEW.document_json,'$.source_qualification') IS e.source_qualification)))
    THEN RAISE(ABORT,'investor experiment cannot be replaced') END;
END;
CREATE TRIGGER investor_experiment_no_update BEFORE UPDATE ON investor_experiments BEGIN SELECT RAISE(ABORT,'investor experiment is immutable'); END;
CREATE TRIGGER investor_experiment_no_delete BEFORE DELETE ON investor_experiments BEGIN SELECT RAISE(ABORT,'investor experiment is immutable'); END;
CREATE TRIGGER investor_trial_intent_insert BEFORE INSERT ON investor_trial_intents BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_trial_intents WHERE id=NEW.id OR (experiment_id=NEW.experiment_id AND phase=NEW.phase AND parameters_hash=NEW.parameters_hash))
    OR NOT EXISTS(SELECT 1 FROM investor_experiments e JOIN job_runs j ON j.period=e.request_id
      WHERE e.id=NEW.experiment_id AND j.id=NEW.job_id AND j.scope=e.workspace_id AND j.job_type='investor_research'
      AND j.command_request_id IS NULL AND j.status='running' AND j.fencing_token=NEW.fencing_token)
    OR NOT EXISTS(SELECT 1 FROM investor_experiments e,json_each(e.document_json,'$.candidate_hashes') c WHERE e.id=NEW.experiment_id AND c.value=NEW.parameters_hash)
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
    OR NOT EXISTS(SELECT 1 FROM investor_trial_intents t JOIN investor_experiments e ON e.id=t.experiment_id JOIN job_runs j ON j.period=e.request_id
      WHERE t.id=NEW.trial_id AND j.id=NEW.job_id AND j.scope=e.workspace_id AND j.job_type='investor_research'
      AND j.command_request_id IS NULL AND j.status='running' AND j.fencing_token=NEW.fencing_token AND json_extract(NEW.document_json,'$.phase') IS t.phase)
    THEN RAISE(ABORT,'investor trial result binding differs') END;
END;
CREATE TRIGGER investor_trial_result_no_update BEFORE UPDATE ON investor_trial_results BEGIN SELECT RAISE(ABORT,'investor trial result is immutable'); END;
CREATE TRIGGER investor_trial_result_no_delete BEFORE DELETE ON investor_trial_results BEGIN SELECT RAISE(ABORT,'investor trial result is immutable'); END;
CREATE TRIGGER investor_candidate_freeze_insert BEFORE INSERT ON investor_candidate_freezes BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_candidate_freezes WHERE experiment_id=NEW.experiment_id)
    OR NOT EXISTS(SELECT 1 FROM investor_experiments e JOIN job_runs j ON j.period=e.request_id WHERE e.id=NEW.experiment_id AND j.id=NEW.job_id
      AND j.scope=e.workspace_id AND j.job_type='investor_research' AND j.command_request_id IS NULL AND j.status='running' AND j.fencing_token=NEW.fencing_token)
    OR NOT EXISTS(SELECT 1 FROM investor_trial_intents t JOIN investor_trial_results r ON r.trial_id=t.id
      WHERE t.experiment_id=NEW.experiment_id AND t.phase='train' AND t.parameters_hash=NEW.parameters_hash)
    OR (SELECT count(*) FROM investor_trial_intents t JOIN investor_trial_results r ON r.trial_id=t.id WHERE t.experiment_id=NEW.experiment_id AND t.phase='train')
      != (SELECT json_array_length(document_json,'$.candidate_hashes') FROM investor_experiments WHERE id=NEW.experiment_id)
    THEN RAISE(ABORT,'investor freeze requires completed train evidence') END;
END;
CREATE TRIGGER investor_candidate_freeze_no_update BEFORE UPDATE ON investor_candidate_freezes BEGIN SELECT RAISE(ABORT,'investor candidate is immutable'); END;
CREATE TRIGGER investor_candidate_freeze_no_delete BEFORE DELETE ON investor_candidate_freezes BEGIN SELECT RAISE(ABORT,'investor candidate is immutable'); END;
