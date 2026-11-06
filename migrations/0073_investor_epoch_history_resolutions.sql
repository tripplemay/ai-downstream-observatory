CREATE TABLE investor_epoch_history_resolutions (
 id TEXT PRIMARY KEY NOT NULL,workspace_id TEXT NOT NULL,model_id TEXT NOT NULL,slot_id TEXT NOT NULL UNIQUE,
 attempt_id TEXT NOT NULL UNIQUE REFERENCES investor_epoch_history_attempts(id),batch_id TEXT NOT NULL,
 expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 160),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
 document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=16384),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),actor_id TEXT NOT NULL,created_at TEXT NOT NULL,
 audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),UNIQUE(workspace_id,idempotency_key),UNIQUE(id,workspace_id,model_id),
 FOREIGN KEY(slot_id,workspace_id,model_id) REFERENCES investor_epoch_history_slots(id,workspace_id,model_id),
 FOREIGN KEY(batch_id,workspace_id,model_id) REFERENCES investor_epoch_history_requests(id,workspace_id,model_id),
 CHECK(json_extract(document_json,'$.schema_version') IS 'investor-epoch-history-resolution-v1'),
 CHECK(json_extract(document_json,'$.resolution_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id AND json_extract(document_json,'$.model_id') IS model_id
  AND json_extract(document_json,'$.actor_id') IS actor_id AND json_extract(document_json,'$.request_hash') IS request_hash AND json_extract(document_json,'$.created_at') IS created_at),
 CHECK(json_extract(document_json,'$.body.schema_version') IS 'investor-epoch-history-resolution-submit-v1' AND json_extract(document_json,'$.body.action') IS 'acknowledge_unknown'),
 CHECK(json_extract(document_json,'$.body.model_id') IS model_id AND json_extract(document_json,'$.body.expected_revision') IS expected_revision
  AND json_extract(document_json,'$.body.idempotency_key') IS idempotency_key AND json_extract(document_json,'$.body.slot.id') IS slot_id
  AND json_extract(document_json,'$.body.attempt.id') IS attempt_id AND json_extract(document_json,'$.body.batch.id') IS batch_id),
 CHECK(json_extract(document_json,'$.body.reviewed_at')<=created_at AND created_at<json_extract(document_json,'$.body.valid_until')
  AND julianday(json_extract(document_json,'$.body.valid_until'))-julianday(json_extract(document_json,'$.body.reviewed_at')) BETWEEN 0.000000001 AND 0.003472223),
 CHECK(json_type(document_json,'$.body.acknowledgements.outcome_stays_unknown') IS 'true' AND json_type(document_json,'$.body.acknowledgements.may_have_consumed_quota') IS 'true'
  AND json_type(document_json,'$.body.acknowledgements.separate_future_confirmation') IS 'true'),
 CHECK(json_type(document_json,'$.old_outcome_known') IS 'false' AND json_type(document_json,'$.new_download_authorized') IS 'false'
  AND json_type(document_json,'$.source_eligibility_restored') IS 'false' AND json_extract(document_json,'$.provider_calls') IS 0
  AND json_type(document_json,'$.monitoring_resumed') IS 'false' AND json_type(document_json,'$.trading_permission') IS 'false')
);
CREATE TRIGGER investor_epoch_history_resolution_insert BEFORE INSERT ON investor_epoch_history_resolutions BEGIN
 SELECT CASE WHEN NEW.actor_id IS NOT (SELECT owner_id FROM investor_workspaces WHERE id=NEW.workspace_id)
  OR NEW.expected_revision IS NOT (SELECT revision FROM investor_workspaces WHERE id=NEW.workspace_id)
  OR EXISTS(SELECT 1 FROM investor_epoch_history_intents WHERE workspace_id=NEW.workspace_id AND idempotency_key=NEW.idempotency_key)
  OR EXISTS(SELECT 1 FROM investor_epoch_history_requests WHERE workspace_id=NEW.workspace_id AND idempotency_key=NEW.idempotency_key)
  OR NOT EXISTS(SELECT 1 FROM investor_epoch_history_slots s JOIN investor_epoch_history_requests r ON r.id=s.request_id
   JOIN investor_epoch_history_attempts a ON a.slot_id=s.id JOIN job_runs j ON j.id=a.job_id
   JOIN job_attempts t ON t.job_id=j.id AND t.attempt=1
   WHERE s.id=NEW.slot_id AND s.request_id=NEW.batch_id AND s.workspace_id=NEW.workspace_id AND s.model_id=NEW.model_id AND s.actor_id=NEW.actor_id
    AND a.id=NEW.attempt_id AND a.actor_id=NEW.actor_id AND a.fencing_token=t.fencing_token AND a.content_hash IS json_extract(NEW.document_json,'$.body.attempt.content_hash')
    AND s.content_hash IS json_extract(NEW.document_json,'$.body.slot.content_hash') AND r.content_hash IS json_extract(NEW.document_json,'$.body.batch.content_hash')
    AND j.job_type='investor_epoch_history' AND j.scope=s.workspace_id AND j.period=s.id AND j.input_version=s.content_hash AND j.command_request_id IS NULL
    AND j.max_attempts=1 AND j.attempt_count=1 AND j.status IN ('failed','skipped','cancelled') AND j.lease_owner IS NULL AND j.lease_until IS NULL
    AND ((t.status=j.status AND t.fencing_token=j.fencing_token) OR (j.status='failed' AND t.status='lease_expired' AND t.fencing_token+1=j.fencing_token
      AND json_extract(t.error_json,'$.code') IS 'LEASE_EXPIRED' AND json_extract(j.result_json,'$.code') IS 'LEASE_EXPIRED'))
    AND t.finished_at=j.updated_at AND t.finished_at<=NEW.created_at
    AND julianday(r.valid_until)+30.0/86400<=julianday(NEW.created_at)
    AND NOT EXISTS(SELECT 1 FROM investor_epoch_history_runs u WHERE u.slot_id=s.id AND u.status!='transport_unknown')
    AND r.authorized_calls=(SELECT count(*) FROM investor_epoch_history_slots q JOIN job_runs b ON b.period=q.id AND b.scope=q.workspace_id AND b.input_version=q.content_hash
       WHERE q.request_id=r.id AND b.job_type='investor_epoch_history' AND b.status IN ('succeeded','failed','skipped','cancelled') AND b.lease_owner IS NULL AND b.lease_until IS NULL
        AND julianday(b.updated_at)+30.0/86400<=julianday(NEW.created_at)))
  OR NOT EXISTS(SELECT 1 FROM audit_events WHERE id=NEW.audit_id AND actor_id=NEW.actor_id AND action='investor_acknowledge_history_unknown'
   AND object_type='investor_history_resolution' AND object_id=NEW.id AND created_at=NEW.created_at AND json_extract(payload_json,'$.content_hash') IS NEW.content_hash)
  THEN RAISE(ABORT,'history resolution binding differs') END;
END;
CREATE TRIGGER investor_epoch_history_resolution_update BEFORE UPDATE ON investor_epoch_history_resolutions BEGIN SELECT RAISE(ABORT,'history resolution immutable'); END;
CREATE TRIGGER investor_epoch_history_resolution_delete BEFORE DELETE ON investor_epoch_history_resolutions BEGIN SELECT RAISE(ABORT,'history resolution immutable'); END;
