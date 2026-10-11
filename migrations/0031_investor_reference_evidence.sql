CREATE UNIQUE INDEX investor_research_run_scope ON investor_research_runs(id,workspace_id);
CREATE TABLE investor_reference_evidence (
  plan_id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL UNIQUE,
  evidence_input_id TEXT NOT NULL,
  result_hash TEXT NOT NULL CHECK(length(result_hash)=64 AND result_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  FOREIGN KEY(plan_id,workspace_id) REFERENCES investor_reference_plans(id,workspace_id),
  FOREIGN KEY(request_id,workspace_id) REFERENCES investor_research_requests(id,workspace_id),
  FOREIGN KEY(run_id,workspace_id) REFERENCES investor_research_runs(id,workspace_id),
  FOREIGN KEY(evidence_input_id,workspace_id) REFERENCES investor_evidence_inputs(id,workspace_id)
);
CREATE INDEX investor_reference_evidence_history ON investor_reference_evidence(workspace_id,created_at DESC);
CREATE TRIGGER investor_reference_evidence_insert BEFORE INSERT ON investor_reference_evidence BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_reference_evidence WHERE plan_id=NEW.plan_id OR request_id=NEW.request_id OR run_id=NEW.run_id)
    OR NOT EXISTS(SELECT 1 FROM investor_reference_plans p
      JOIN investor_research_requests r ON r.id=NEW.request_id AND r.workspace_id=p.workspace_id AND r.profile_id=p.profile_id
      JOIN investor_research_runs u ON u.id=NEW.run_id AND u.request_id=r.id AND u.workspace_id=r.workspace_id
      JOIN investor_evidence_inputs e ON e.id=NEW.evidence_input_id AND e.workspace_id=r.workspace_id AND r.evidence_input_id=e.id
      WHERE p.id=NEW.plan_id AND p.workspace_id=NEW.workspace_id
        AND p.created_at=NEW.created_at AND u.created_at=NEW.created_at AND u.status='calculated'
        AND json_extract(p.document_json,'$.data_mode')='reconstructed'
        AND json_extract(p.document_json,'$.reference_evidence.request_id')=r.id
        AND json_extract(p.document_json,'$.reference_evidence.run_id')=u.id
        AND json_extract(p.document_json,'$.reference_evidence.source_input_id')=e.id
        AND json_extract(p.document_json,'$.reference_evidence.result_hash')=NEW.result_hash
        AND json_extract(u.document_json,'$.result.status')='reference_ready'
        AND json_extract(u.document_json,'$.result.result_hash')=NEW.result_hash)
    THEN RAISE(ABORT,'reference plan evidence binding differs') END;
END;
CREATE TRIGGER investor_reference_evidence_no_update BEFORE UPDATE ON investor_reference_evidence BEGIN SELECT RAISE(ABORT,'reference evidence is immutable'); END;
CREATE TRIGGER investor_reference_evidence_no_delete BEFORE DELETE ON investor_reference_evidence BEGIN SELECT RAISE(ABORT,'reference evidence is immutable'); END;
