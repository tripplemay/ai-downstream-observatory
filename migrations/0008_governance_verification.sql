CREATE TABLE governance_verification_runs (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id),
  gate TEXT NOT NULL CHECK(gate IN ('G-03','G-04')),
  policy_hash TEXT NOT NULL,
  strategy_hash TEXT NOT NULL,
  suite_version TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  source_manifest_json TEXT NOT NULL,
  source_manifest_hash TEXT NOT NULL,
  execution_manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  metrics_json TEXT,
  research_run_id TEXT REFERENCES research_runs(id),
  provenance TEXT NOT NULL CHECK(provenance IN ('authoritative','synthetic','reconstructed')),
  status TEXT NOT NULL CHECK(status IN ('pass','blocked','failed')),
  executed_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX governance_verification_scope ON governance_verification_runs(portfolio_id,gate,source_manifest_hash);
CREATE TRIGGER governance_verification_job BEFORE INSERT ON governance_verification_runs
  WHEN NOT EXISTS (
    SELECT 1 FROM job_runs j JOIN command_requests c ON c.id=j.command_request_id
    WHERE j.id=NEW.job_id AND j.job_type='governance_verification' AND j.status='succeeded'
      AND c.command_type='governance_verification' AND c.portfolio_id=NEW.portfolio_id
      AND c.actor_id='system:governance-verifier'
      AND json_extract(j.result_json,'$.manifest_hash')=NEW.manifest_hash)
  BEGIN SELECT RAISE(ABORT, 'governance verification requires trusted completed job'); END;
CREATE TRIGGER governance_verification_no_update BEFORE UPDATE ON governance_verification_runs BEGIN SELECT RAISE(ABORT, 'governance verification is append-only'); END;
CREATE TRIGGER governance_verification_no_delete BEFORE DELETE ON governance_verification_runs BEGIN SELECT RAISE(ABORT, 'governance verification is append-only'); END;
