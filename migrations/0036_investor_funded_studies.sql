CREATE TABLE investor_funded_study_requests (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  funding_plan_id TEXT NOT NULL,
  evidence_input_id TEXT,
  input_version TEXT NOT NULL CHECK(length(input_version)=64 AND input_version NOT GLOB '*[^a-f0-9]*'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=8192),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(profile_id,workspace_id) REFERENCES investor_profiles(id,workspace_id),
  FOREIGN KEY(funding_plan_id,workspace_id) REFERENCES investor_funding_plans(id,workspace_id),
  FOREIGN KEY(evidence_input_id,workspace_id) REFERENCES investor_evidence_inputs(id,workspace_id),
  UNIQUE(id,workspace_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-funded-study-request-v1'),
  CHECK(json_extract(document_json,'$.workspace_id') IS workspace_id),
  CHECK(json_extract(document_json,'$.profile_id') IS profile_id),
  CHECK(json_extract(document_json,'$.funding_plan_id') IS funding_plan_id),
  CHECK(json_extract(document_json,'$.evidence_input_id') IS evidence_input_id),
  CHECK(json_extract(document_json,'$.comparison_declared_at') IS created_at),
  CHECK(json_extract(document_json,'$.economics_independently_replayed') IS 0),
  CHECK(json_extract(document_json,'$.parameters_independently_preregistered') IS 0),
  CHECK(json_extract(document_json,'$.actual_arrivals_confirmed') IS 0),
  CHECK(json_extract(document_json,'$.execution_authorized') IS 0),
  CHECK(json_extract(document_json,'$.live_advice_eligible') IS 0)
);
CREATE TRIGGER investor_funded_study_request_insert BEFORE INSERT ON investor_funded_study_requests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_funded_study_requests WHERE id=NEW.id OR audit_id=NEW.audit_id)
    OR NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NEW.profile_id IS NOT (SELECT id FROM investor_profiles WHERE workspace_id=NEW.workspace_id ORDER BY version DESC LIMIT 1)
    OR NEW.funding_plan_id IS NOT (SELECT id FROM investor_funding_plans WHERE workspace_id=NEW.workspace_id ORDER BY version DESC LIMIT 1)
    OR NEW.profile_id IS NOT (SELECT profile_id FROM investor_funding_plans WHERE id=NEW.funding_plan_id)
    THEN RAISE(ABORT,'investor funded study owner or current binding differs') END;
END;
CREATE TRIGGER investor_funded_study_request_no_update BEFORE UPDATE ON investor_funded_study_requests BEGIN SELECT RAISE(ABORT,'investor funded study request is immutable'); END;
CREATE TRIGGER investor_funded_study_request_no_delete BEFORE DELETE ON investor_funded_study_requests BEGIN SELECT RAISE(ABORT,'investor funded study request is immutable'); END;
CREATE TABLE investor_funded_study_runs (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id),
  status TEXT NOT NULL CHECK(status IN ('blocked','calculated_unverified','failed')),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=8192),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  FOREIGN KEY(request_id,workspace_id) REFERENCES investor_funded_study_requests(id,workspace_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-funded-study-run-v1'),
  CHECK(json_extract(document_json,'$.request_id') IS request_id),
  CHECK(json_extract(document_json,'$.status') IS status),
  CHECK(json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_extract(document_json,'$.economics_independently_replayed') IS 0),
  CHECK(json_extract(document_json,'$.parameters_independently_preregistered') IS 0),
  CHECK(json_extract(document_json,'$.actual_arrivals_confirmed') IS 0),
  CHECK(json_extract(document_json,'$.execution_authorized') IS 0),
  CHECK(json_extract(document_json,'$.live_advice_eligible') IS 0)
);
CREATE TRIGGER investor_funded_study_run_insert BEFORE INSERT ON investor_funded_study_runs BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_funded_study_runs WHERE id=NEW.id OR request_id=NEW.request_id OR job_id=NEW.job_id)
    OR NOT EXISTS(SELECT 1 FROM job_runs j JOIN investor_funded_study_requests r ON r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id
      WHERE j.id=NEW.job_id AND j.job_type='investor_funded_study' AND j.command_request_id IS NULL
        AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.input_version AND j.status='running'
        AND json_extract(NEW.document_json,'$.input_version') IS r.input_version AND NEW.created_at>=r.created_at)
    THEN RAISE(ABORT,'investor funded study job binding differs') END;
END;
CREATE TRIGGER investor_funded_study_run_no_update BEFORE UPDATE ON investor_funded_study_runs BEGIN SELECT RAISE(ABORT,'investor funded study run is immutable'); END;
CREATE TRIGGER investor_funded_study_run_no_delete BEFORE DELETE ON investor_funded_study_runs BEGIN SELECT RAISE(ABORT,'investor funded study run is immutable'); END;
