CREATE TABLE investor_funding_plans (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version>0),
  profile_hash TEXT NOT NULL CHECK(length(profile_hash)=64 AND profile_hash NOT GLOB '*[^a-f0-9]*'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=8192),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(profile_id,workspace_id) REFERENCES investor_profiles(id,workspace_id),
  UNIQUE(workspace_id,version), UNIQUE(id,workspace_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-funding-plan-v1'),
  CHECK(json_extract(document_json,'$.actual_arrivals_confirmed') IS 0),
  CHECK(json_extract(document_json,'$.execution_authorized') IS 0),
  CHECK(json_extract(document_json,'$.live_advice_eligible') IS 0)
);
CREATE TRIGGER investor_funding_plan_insert BEFORE INSERT ON investor_funding_plans BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_funding_plans WHERE id=NEW.id OR audit_id=NEW.audit_id)
    OR NEW.version IS NOT (SELECT COALESCE(MAX(version),0)+1 FROM investor_funding_plans WHERE workspace_id=NEW.workspace_id)
    OR NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
    OR NEW.profile_id IS NOT (SELECT id FROM investor_profiles WHERE workspace_id=NEW.workspace_id ORDER BY version DESC LIMIT 1)
    OR NEW.profile_hash IS NOT (SELECT content_hash FROM investor_profiles WHERE id=NEW.profile_id AND workspace_id=NEW.workspace_id)
    THEN RAISE(ABORT,'investor funding plan version, profile or owner differs') END;
END;
CREATE TRIGGER investor_funding_plan_no_update BEFORE UPDATE ON investor_funding_plans BEGIN SELECT RAISE(ABORT,'investor funding plan is immutable'); END;
CREATE TRIGGER investor_funding_plan_no_delete BEFORE DELETE ON investor_funding_plans BEGIN SELECT RAISE(ABORT,'investor funding plan is immutable'); END;
