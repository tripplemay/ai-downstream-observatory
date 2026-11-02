CREATE TABLE investor_correction_consent_requests (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id), model_id TEXT NOT NULL,
  impact_request_id TEXT NOT NULL, expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision>=0),
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(CAST(document_json AS BLOB))<=32768),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64), actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
  valid_until TEXT NOT NULL CHECK(created_at<valid_until), audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,idempotency_key),
  FOREIGN KEY(model_id,workspace_id) REFERENCES investor_models(id,workspace_id),
  FOREIGN KEY(impact_request_id,workspace_id) REFERENCES investor_correction_impact_requests(id,workspace_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-correction-consent-request-v1'
    AND json_extract(document_json,'$.request_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id
    AND json_extract(document_json,'$.model_id') IS model_id AND json_extract(document_json,'$.request_hash') IS request_hash
    AND json_extract(document_json,'$.body.impact_request_id') IS impact_request_id
    AND json_extract(document_json,'$.body.expected_revision') IS expected_revision AND json_extract(document_json,'$.body.idempotency_key') IS idempotency_key
    AND json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until)
);
CREATE TABLE investor_correction_consents (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, model_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
  impact_request_id TEXT NOT NULL UNIQUE, impact_result_id TEXT NOT NULL, original_head_id TEXT NOT NULL,
  workspace_revision INTEGER NOT NULL CHECK(typeof(workspace_revision)='integer' AND workspace_revision>0),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(CAST(document_json AS BLOB))<=8388608),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64), actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
  valid_until TEXT NOT NULL CHECK(created_at<valid_until), audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(id,workspace_id), FOREIGN KEY(request_id,workspace_id) REFERENCES investor_correction_consent_requests(id,workspace_id),
  FOREIGN KEY(model_id,workspace_id) REFERENCES investor_models(id,workspace_id),
  FOREIGN KEY(original_head_id,workspace_id,model_id) REFERENCES investor_evidence_model_checkpoints(id,workspace_id,model_id),
  FOREIGN KEY(impact_result_id) REFERENCES investor_correction_impact_results(id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-correction-consent-confirmation-v1'
    AND json_extract(document_json,'$.confirmation_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id
    AND json_extract(document_json,'$.model_id') IS model_id AND json_extract(document_json,'$.request_id') IS request_id
    AND json_extract(document_json,'$.impact_request_id') IS impact_request_id AND json_extract(document_json,'$.impact_result_id') IS impact_result_id
    AND json_extract(document_json,'$.baseline.original_history.head_checkpoint_id') IS original_head_id
    AND json_extract(document_json,'$.workspace_revision') IS workspace_revision
    AND json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until),
  CHECK(json_type(document_json,'$.economic_correction_approved') IS 'true'
    AND json_type(document_json,'$.monitor_data_readmission_required') IS 'true'
    AND json_type(document_json,'$.checkpoint_created') IS 'false' AND json_type(document_json,'$.state_published') IS 'false'
    AND json_type(document_json,'$.monitoring_resumed') IS 'false' AND json_type(document_json,'$.historical_observations_rewritten') IS 'false'
    AND json_type(document_json,'$.historical_strategy_results_recomputed') IS 'false'
    AND json_type(document_json,'$.trading_permission') IS 'false' AND json_type(document_json,'$.raw_ai_sharing') IS 'false'
    AND json_extract(document_json,'$.provider_calls') IS 0)
);
CREATE TABLE investor_correction_consent_results (
  id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id), fencing_token INTEGER NOT NULL CHECK(fencing_token>0),
  outcome TEXT NOT NULL CHECK(outcome IN ('confirmed','rejected')), code TEXT NOT NULL,
  confirmation_id TEXT REFERENCES investor_correction_consents(id),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(CAST(document_json AS BLOB))<=32768),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64), actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(request_id,workspace_id) REFERENCES investor_correction_consent_requests(id,workspace_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-correction-consent-result-v1'
    AND json_extract(document_json,'$.result_id') IS id AND json_extract(document_json,'$.request_id') IS request_id
    AND json_extract(document_json,'$.workspace_id') IS workspace_id AND json_extract(document_json,'$.job_id') IS job_id
    AND json_extract(document_json,'$.fencing_token') IS fencing_token AND json_extract(document_json,'$.outcome') IS outcome
    AND json_extract(document_json,'$.code') IS code AND json_extract(document_json,'$.confirmation_id') IS confirmation_id
    AND json_extract(document_json,'$.created_at') IS created_at),
  CHECK((outcome='confirmed' AND confirmation_id IS NOT NULL AND json_type(document_json,'$.confirmation_hash') IS 'text')
    OR (outcome='rejected' AND confirmation_id IS NULL AND json_type(document_json,'$.confirmation_hash') IS 'null'))
);
CREATE TRIGGER investor_correction_consent_request_insert BEFORE INSERT ON investor_correction_consent_requests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_correction_consent_requests WHERE id=NEW.id OR (workspace_id=NEW.workspace_id AND idempotency_key=NEW.idempotency_key))
    OR NOT EXISTS(SELECT 1 FROM investor_workspaces w JOIN investor_correction_impact_requests r ON r.workspace_id=w.id
    JOIN investor_correction_impact_results u ON u.request_id=r.id JOIN audit_events a ON a.id=NEW.audit_id
    WHERE w.id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND w.revision=NEW.expected_revision
    AND r.id=NEW.impact_request_id AND r.model_id=NEW.model_id AND r.actor_id=NEW.actor_id AND u.actor_id=NEW.actor_id
    AND r.expected_revision=NEW.expected_revision AND u.outcome='preview_ready' AND u.created_at<=NEW.created_at
    AND u.content_hash IS json_extract(NEW.document_json,'$.body.expected_result_hash')
    AND NEW.valid_until<=json_extract(u.document_json,'$.impact.valid_until')
    AND a.actor_id=NEW.actor_id AND a.action='investor_enqueue_correction_consent' AND a.object_type='investor_correction_consent_request'
    AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'correction consent request binding differs') END;
END;
CREATE TRIGGER investor_correction_consent_insert BEFORE INSERT ON investor_correction_consents BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_correction_consents WHERE id=NEW.id OR request_id=NEW.request_id OR impact_request_id=NEW.impact_request_id)
    OR NOT EXISTS(SELECT 1 FROM investor_correction_consent_requests r JOIN investor_workspaces w ON w.id=r.workspace_id
    JOIN investor_correction_impact_results u ON u.request_id=r.impact_request_id
    JOIN investor_evidence_model_checkpoints h ON h.workspace_id=w.id AND h.model_id=r.model_id JOIN audit_events a ON a.id=NEW.audit_id
    WHERE r.id=NEW.request_id AND w.id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND r.actor_id=NEW.actor_id
    AND w.revision=r.expected_revision AND NEW.workspace_revision=w.revision+1 AND r.created_at<=NEW.created_at AND NEW.created_at<r.valid_until
    AND r.model_id=NEW.model_id AND r.impact_request_id=NEW.impact_request_id AND u.id=NEW.impact_result_id
    AND u.content_hash IS json_extract(NEW.document_json,'$.impact_result_hash') AND u.outcome='preview_ready'
    AND json_extract(NEW.document_json,'$.request_hash') IS r.request_hash
    AND h.id=NEW.original_head_id AND h.content_hash IS json_extract(NEW.document_json,'$.baseline.original_checkpoint_hash')
    AND h.sequence=(SELECT max(sequence) FROM investor_evidence_model_checkpoints WHERE workspace_id=w.id AND model_id=r.model_id)
    AND NEW.valid_until IS json_extract(NEW.document_json,'$.reviewed_source_valid_until')
    AND NEW.valid_until<=json_extract(NEW.document_json,'$.baseline.original_history.source_valid_until')
    AND a.actor_id=NEW.actor_id AND a.action='investor_confirm_correction' AND a.object_type='investor_correction_consent'
    AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'correction consent binding differs') END;
END;
CREATE TRIGGER investor_correction_consent_result_insert BEFORE INSERT ON investor_correction_consent_results BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_correction_consent_results WHERE id=NEW.id OR request_id=NEW.request_id OR job_id=NEW.job_id)
    OR NOT EXISTS(SELECT 1 FROM investor_correction_consent_requests r JOIN job_runs j ON j.id=NEW.job_id
    JOIN job_attempts t ON t.job_id=j.id AND t.attempt=1 JOIN audit_events a ON a.id=NEW.audit_id
    WHERE r.id=NEW.request_id AND r.workspace_id=NEW.workspace_id AND r.actor_id=NEW.actor_id
    AND json_extract(NEW.document_json,'$.request_hash') IS r.content_hash AND r.created_at<=NEW.created_at
    AND j.job_type='investor_correction_consent' AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
    AND j.command_request_id IS NULL AND j.status='running' AND j.attempt_count=1 AND j.max_attempts=1 AND j.fencing_token=NEW.fencing_token
    AND t.status='running' AND t.fencing_token=j.fencing_token AND t.started_at<=NEW.created_at AND NEW.created_at<j.lease_until
    AND a.actor_id=NEW.actor_id AND a.action='investor_finish_correction_consent' AND a.object_type='investor_correction_consent_result'
    AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash
    AND (NEW.outcome='rejected' OR EXISTS(SELECT 1 FROM investor_correction_consents c WHERE c.id=NEW.confirmation_id
      AND c.workspace_id=r.workspace_id AND c.request_id=r.id AND c.created_at=NEW.created_at
      AND c.content_hash IS json_extract(NEW.document_json,'$.confirmation_hash'))))
    THEN RAISE(ABORT,'correction consent result binding differs') END;
END;
CREATE TRIGGER investor_correction_consent_request_update BEFORE UPDATE ON investor_correction_consent_requests BEGIN SELECT RAISE(ABORT,'correction consent request immutable'); END;
CREATE TRIGGER investor_correction_consent_request_delete BEFORE DELETE ON investor_correction_consent_requests BEGIN SELECT RAISE(ABORT,'correction consent request immutable'); END;
CREATE TRIGGER investor_correction_consent_update BEFORE UPDATE ON investor_correction_consents BEGIN SELECT RAISE(ABORT,'correction consent immutable'); END;
CREATE TRIGGER investor_correction_consent_delete BEFORE DELETE ON investor_correction_consents BEGIN SELECT RAISE(ABORT,'correction consent immutable'); END;
CREATE TRIGGER investor_correction_consent_result_update BEFORE UPDATE ON investor_correction_consent_results BEGIN SELECT RAISE(ABORT,'correction consent result immutable'); END;
CREATE TRIGGER investor_correction_consent_result_delete BEFORE DELETE ON investor_correction_consent_results BEGIN SELECT RAISE(ABORT,'correction consent result immutable'); END;
