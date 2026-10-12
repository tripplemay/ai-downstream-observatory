CREATE TABLE investor_workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL UNIQUE CHECK(length(trim(owner_id)) BETWEEN 1 AND 160),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
  created_at TEXT NOT NULL
);

CREATE TABLE investor_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id),
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version>0),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(workspace_id,version), UNIQUE(id,workspace_id)
);

CREATE TABLE investor_reference_plans (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=262144),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  FOREIGN KEY(profile_id,workspace_id) REFERENCES investor_profiles(id,workspace_id),
  UNIQUE(id,workspace_id)
);

CREATE TABLE investor_observations (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  candidate_plan_id TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('observe','decision_required','insufficient_evidence')),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=262144),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  input_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(profile_id,workspace_id) REFERENCES investor_profiles(id,workspace_id),
  FOREIGN KEY(candidate_plan_id,workspace_id) REFERENCES investor_reference_plans(id,workspace_id),
  UNIQUE(id,workspace_id),
  CHECK(json_extract(document_json,'$.outcome') IS outcome),
  CHECK((outcome='insufficient_evidence' AND candidate_plan_id IS NULL)
    OR (outcome!='insufficient_evidence' AND candidate_plan_id IS NOT NULL))
);
CREATE INDEX investor_observation_history ON investor_observations(workspace_id,created_at DESC,id DESC);

CREATE TABLE investor_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('accept_idea','defer','reject')),
  note TEXT NOT NULL CHECK(length(note)<=2000),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(observation_id,workspace_id) REFERENCES investor_observations(id,workspace_id)
);
CREATE INDEX investor_decision_history ON investor_decisions(workspace_id,created_at DESC,id DESC);

CREATE TABLE investor_plan_selections (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(plan_id,workspace_id) REFERENCES investor_reference_plans(id,workspace_id)
);
CREATE INDEX investor_selection_history ON investor_plan_selections(workspace_id,created_at DESC,id DESC);

CREATE TABLE investor_commands (
  owner_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 160),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object'),
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,idempotency_key)
);

CREATE TRIGGER investor_workspace_no_delete BEFORE DELETE ON investor_workspaces BEGIN SELECT RAISE(ABORT,'investor workspace is persistent'); END;
CREATE TRIGGER investor_workspace_insert BEFORE INSERT ON investor_workspaces BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_workspaces WHERE id=NEW.id OR owner_id=NEW.owner_id)
    THEN RAISE(ABORT,'investor workspace cannot be replaced') END;
END;
CREATE TRIGGER investor_workspace_update BEFORE UPDATE ON investor_workspaces BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.created_at IS NOT OLD.created_at
    OR NEW.revision IS NOT OLD.revision+1 THEN RAISE(ABORT,'investor workspace update requires one revision') END;
END;
CREATE TRIGGER investor_profile_insert BEFORE INSERT ON investor_profiles BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_profiles WHERE id=NEW.id OR audit_id=NEW.audit_id)
    OR NEW.version IS NOT (SELECT COALESCE(MAX(version),0)+1 FROM investor_profiles WHERE workspace_id=NEW.workspace_id)
    OR NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    THEN RAISE(ABORT,'investor profile version or owner differs') END;
END;
CREATE TRIGGER investor_profile_no_update BEFORE UPDATE ON investor_profiles BEGIN SELECT RAISE(ABORT,'investor profile is immutable'); END;
CREATE TRIGGER investor_profile_no_delete BEFORE DELETE ON investor_profiles BEGIN SELECT RAISE(ABORT,'investor profile is immutable'); END;
CREATE TRIGGER investor_plan_insert BEFORE INSERT ON investor_reference_plans BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_reference_plans WHERE id=NEW.id)
    THEN RAISE(ABORT,'reference plan cannot be replaced') END;
END;
CREATE TRIGGER investor_plan_no_update BEFORE UPDATE ON investor_reference_plans BEGIN SELECT RAISE(ABORT,'reference plan is immutable'); END;
CREATE TRIGGER investor_plan_no_delete BEFORE DELETE ON investor_reference_plans BEGIN SELECT RAISE(ABORT,'reference plan is immutable'); END;
CREATE TRIGGER investor_observation_insert BEFORE INSERT ON investor_observations BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_observations WHERE id=NEW.id)
    THEN RAISE(ABORT,'investor observation cannot be replaced') END;
END;
CREATE TRIGGER investor_observation_no_update BEFORE UPDATE ON investor_observations BEGIN SELECT RAISE(ABORT,'investor observation is immutable'); END;
CREATE TRIGGER investor_observation_no_delete BEFORE DELETE ON investor_observations BEGIN SELECT RAISE(ABORT,'investor observation is immutable'); END;
CREATE TRIGGER investor_decision_insert BEFORE INSERT ON investor_decisions BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_decisions WHERE id=NEW.id OR audit_id=NEW.audit_id)
    OR NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    THEN RAISE(ABORT,'investor decision owner differs') END;
END;
CREATE TRIGGER investor_decision_no_update BEFORE UPDATE ON investor_decisions BEGIN SELECT RAISE(ABORT,'investor decision is immutable'); END;
CREATE TRIGGER investor_decision_no_delete BEFORE DELETE ON investor_decisions BEGIN SELECT RAISE(ABORT,'investor decision is immutable'); END;
CREATE TRIGGER investor_selection_insert BEFORE INSERT ON investor_plan_selections BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_plan_selections WHERE id=NEW.id OR audit_id=NEW.audit_id)
    OR NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    THEN RAISE(ABORT,'investor selection owner differs') END;
END;
CREATE TRIGGER investor_selection_no_update BEFORE UPDATE ON investor_plan_selections BEGIN SELECT RAISE(ABORT,'investor selection is immutable'); END;
CREATE TRIGGER investor_selection_no_delete BEFORE DELETE ON investor_plan_selections BEGIN SELECT RAISE(ABORT,'investor selection is immutable'); END;
CREATE TRIGGER investor_command_insert BEFORE INSERT ON investor_commands BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_commands WHERE owner_id=NEW.owner_id AND idempotency_key=NEW.idempotency_key)
    THEN RAISE(ABORT,'investor command cannot be replaced') END;
END;
CREATE TRIGGER investor_command_no_update BEFORE UPDATE ON investor_commands BEGIN SELECT RAISE(ABORT,'investor command is immutable'); END;
CREATE TRIGGER investor_command_no_delete BEFORE DELETE ON investor_commands BEGIN SELECT RAISE(ABORT,'investor command is immutable'); END;
