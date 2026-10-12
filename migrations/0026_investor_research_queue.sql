CREATE TABLE investor_research_inputs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id),
  source_qualification TEXT NOT NULL CHECK(source_qualification='synthetic_test_only'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object'
    AND length(CAST(document_json AS BLOB))<=16777216),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,content_hash)
);
CREATE INDEX investor_research_input_latest ON investor_research_inputs(workspace_id,created_at DESC);

CREATE TABLE investor_research_requests (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  input_id TEXT,
  input_version TEXT NOT NULL CHECK(length(input_version)=64 AND input_version NOT GLOB '*[^a-f0-9]*'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object'
    AND length(CAST(document_json AS BLOB))<=4096),
  created_at TEXT NOT NULL,
  FOREIGN KEY(profile_id,workspace_id) REFERENCES investor_profiles(id,workspace_id),
  FOREIGN KEY(input_id,workspace_id) REFERENCES investor_research_inputs(id,workspace_id),
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,profile_id,input_version)
);
CREATE INDEX investor_research_request_latest ON investor_research_requests(workspace_id,created_at DESC);

CREATE TABLE investor_research_runs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id),
  observation_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('blocked','calculated')),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object'
    AND length(CAST(document_json AS BLOB))<=1048576),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  FOREIGN KEY(request_id,workspace_id) REFERENCES investor_research_requests(id,workspace_id),
  FOREIGN KEY(observation_id,workspace_id) REFERENCES investor_observations(id,workspace_id),
  CHECK(json_extract(document_json,'$.status') IS status),
  CHECK(json_extract(document_json,'$.request_id') IS request_id),
  CHECK(json_extract(document_json,'$.created_at') IS created_at)
);

CREATE TRIGGER investor_research_input_insert BEFORE INSERT ON investor_research_inputs BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_research_inputs WHERE id=NEW.id OR
    (workspace_id=NEW.workspace_id AND content_hash=NEW.content_hash))
    THEN RAISE(ABORT,'research input cannot be replaced') END;
END;
CREATE TRIGGER investor_research_input_no_update BEFORE UPDATE ON investor_research_inputs BEGIN SELECT RAISE(ABORT,'research input is immutable'); END;
CREATE TRIGGER investor_research_input_no_delete BEFORE DELETE ON investor_research_inputs BEGIN SELECT RAISE(ABORT,'research input is immutable'); END;
CREATE TRIGGER investor_research_request_insert BEFORE INSERT ON investor_research_requests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_research_requests WHERE id=NEW.id OR
    (workspace_id=NEW.workspace_id AND profile_id=NEW.profile_id AND input_version=NEW.input_version))
    THEN RAISE(ABORT,'research request cannot be replaced') END;
END;
CREATE TRIGGER investor_research_request_no_update BEFORE UPDATE ON investor_research_requests BEGIN SELECT RAISE(ABORT,'research request is immutable'); END;
CREATE TRIGGER investor_research_request_no_delete BEFORE DELETE ON investor_research_requests BEGIN SELECT RAISE(ABORT,'research request is immutable'); END;
CREATE TRIGGER investor_research_run_insert BEFORE INSERT ON investor_research_runs BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_research_runs WHERE id=NEW.id OR request_id=NEW.request_id OR job_id=NEW.job_id OR observation_id=NEW.observation_id)
    OR NOT EXISTS(SELECT 1 FROM job_runs j JOIN investor_research_requests r ON r.id=NEW.request_id
      WHERE j.id=NEW.job_id AND j.job_type='investor_research' AND j.command_request_id IS NULL
      AND j.scope=NEW.workspace_id AND j.period=r.id AND j.input_version=r.input_version
      AND r.workspace_id=NEW.workspace_id AND j.status='running')
    OR NOT EXISTS(SELECT 1 FROM investor_observations o JOIN investor_research_requests r ON r.id=NEW.request_id
      WHERE o.id=NEW.observation_id AND o.workspace_id=NEW.workspace_id AND o.profile_id=r.profile_id
      AND o.input_version=r.input_version AND o.created_at=NEW.created_at)
    THEN RAISE(ABORT,'research run binding differs') END;
END;
CREATE TRIGGER investor_research_run_no_update BEFORE UPDATE ON investor_research_runs BEGIN SELECT RAISE(ABORT,'research run is immutable'); END;
CREATE TRIGGER investor_research_run_no_delete BEFORE DELETE ON investor_research_runs BEGIN SELECT RAISE(ABORT,'research run is immutable'); END;
