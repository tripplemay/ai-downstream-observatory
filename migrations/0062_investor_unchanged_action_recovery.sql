-- Versioned unchanged-source recovery; original rows, rowids and nonempty protocols remain intact.
PRAGMA legacy_alter_table=ON;
CREATE TABLE investor_action_review_confirmations_rebuild (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id), preview_id TEXT NOT NULL UNIQUE,
  previous_authority_id TEXT NOT NULL UNIQUE, new_authority_id TEXT NOT NULL UNIQUE, new_review_id TEXT NOT NULL UNIQUE,
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision>0), idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=1048576),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(preview_id,workspace_id) REFERENCES investor_action_review_previews(id,workspace_id),
  FOREIGN KEY(previous_authority_id,workspace_id) REFERENCES investor_action_authorities(id,workspace_id),
  FOREIGN KEY(new_authority_id,workspace_id) REFERENCES investor_action_authorities(id,workspace_id),
  FOREIGN KEY(new_review_id,workspace_id) REFERENCES investor_data_reviews(id,workspace_id),
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,idempotency_key), CHECK(previous_authority_id!=new_authority_id),
  CHECK(json_extract(document_json,'$.schema_version') IN ('investor-action-review-confirmation-v1','investor-unchanged-action-recovery-confirmation-v1')),
  CHECK(json_extract(document_json,'$.schema_version')!='investor-unchanged-action-recovery-confirmation-v1' OR
    (json_extract(document_json,'$.request.schema_version') IS 'investor-unchanged-action-recovery-submit-v1'
      AND json_extract(document_json,'$.append_proof.status') IS 'unchanged_recovery_prepared_only'
      AND json_extract(document_json,'$.append_proof.added_event_count') IS 0
      AND json_extract(document_json,'$.append_proof.failed_publication_id') IS json_extract(document_json,'$.request.failed_publication_id')
      AND json_extract(document_json,'$.append_proof.failed_publication_hash') IS json_extract(document_json,'$.request.failed_publication_hash'))),
  CHECK(json_extract(document_json,'$.confirmation_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id
    AND json_extract(document_json,'$.preview_id') IS preview_id AND json_extract(document_json,'$.previous_authority_id') IS previous_authority_id
    AND json_extract(document_json,'$.new_authority_id') IS new_authority_id AND json_extract(document_json,'$.new_review_id') IS new_review_id
    AND json_extract(document_json,'$.workspace_revision') IS workspace_revision AND json_extract(document_json,'$.request_hash') IS request_hash
    AND json_extract(document_json,'$.request.preview_id') IS preview_id AND json_extract(document_json,'$.request.idempotency_key') IS idempotency_key
    AND json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_type(document_json,'$.monitor_data_readmission_required') IS 'true' AND json_type(document_json,'$.quarantine_cleared') IS 'false'
    AND json_type(document_json,'$.research_admitted') IS 'false' AND json_type(document_json,'$.trading_permission') IS 'false'
    AND json_type(document_json,'$.raw_ai_sharing') IS 'false' AND json_extract(document_json,'$.provider_calls') IS 0)
);
INSERT INTO investor_action_review_confirmations_rebuild(rowid,id,workspace_id,preview_id,previous_authority_id,new_authority_id,new_review_id,workspace_revision,idempotency_key,request_hash,document_json,content_hash,actor_id,created_at,audit_id) SELECT rowid,id,workspace_id,preview_id,previous_authority_id,new_authority_id,new_review_id,workspace_revision,idempotency_key,request_hash,document_json,content_hash,actor_id,created_at,audit_id FROM investor_action_review_confirmations;
DROP TABLE investor_action_review_confirmations;
ALTER TABLE investor_action_review_confirmations_rebuild RENAME TO investor_action_review_confirmations;
CREATE TRIGGER investor_action_review_confirmation_insert BEFORE INSERT ON investor_action_review_confirmations BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_action_review_confirmations WHERE id=NEW.id OR preview_id=NEW.preview_id
      OR previous_authority_id=NEW.previous_authority_id OR new_authority_id=NEW.new_authority_id OR new_review_id=NEW.new_review_id
      OR (workspace_id=NEW.workspace_id AND idempotency_key=NEW.idempotency_key))
    OR NOT EXISTS(SELECT 1 FROM investor_workspaces w JOIN investor_action_review_previews v ON v.workspace_id=w.id
      JOIN investor_action_authorities old ON old.id=v.authority_id JOIN investor_action_authorities next ON next.workspace_id=w.id
      JOIN investor_data_reviews r ON r.id=next.base_review_id AND r.workspace_id=w.id JOIN investor_action_controls retired ON retired.authority_id=old.id
      JOIN investor_action_controls c ON c.authority_id=next.id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE w.id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND v.id=NEW.preview_id AND v.workspace_revision=w.revision
      AND NEW.workspace_revision=w.revision+1 AND json_extract(NEW.document_json,'$.request.expected_revision') IS w.revision
      AND v.created_at<=NEW.created_at AND NEW.created_at<v.valid_until AND old.id=NEW.previous_authority_id
      AND next.id=NEW.new_authority_id AND r.id=NEW.new_review_id AND r.decision='approved' AND r.created_at=NEW.created_at
      AND old.listing_id=next.listing_id AND old.listing_review_id=next.listing_review_id AND next.created_at=NEW.created_at
      AND json_extract(NEW.document_json,'$.previous_authority_hash') IS old.content_hash AND json_extract(NEW.document_json,'$.new_authority_hash') IS next.content_hash
      AND json_extract(NEW.document_json,'$.new_review_hash') IS r.content_hash AND json_extract(NEW.document_json,'$.draft_basis_hash') IS json_extract(v.document_json,'$.draft_basis_hash')
      AND retired.id=json_extract(NEW.document_json,'$.retired_control_id') AND retired.enabled=0
      AND retired.content_hash=json_extract(NEW.document_json,'$.retired_control_hash')
      AND retired.version=(SELECT max(version) FROM investor_action_controls WHERE authority_id=old.id)
      AND c.id=json_extract(NEW.document_json,'$.new_control_id') AND c.content_hash=json_extract(NEW.document_json,'$.new_control_hash')
      AND c.version=(SELECT max(version) FROM investor_action_controls WHERE authority_id=next.id)
      AND c.enabled IS json_extract(NEW.document_json,'$.request.enable_rule') AND c.version=CASE WHEN c.enabled=1 THEN 2 ELSE 1 END
      AND a.actor_id=NEW.actor_id AND a.action='investor_confirm_action_review' AND a.object_type='investor_action_review_confirmation'
      AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'action review confirmation binding differs') END;
END;
CREATE TRIGGER investor_action_review_confirmation_update BEFORE UPDATE ON investor_action_review_confirmations BEGIN SELECT RAISE(ABORT,'action review confirmation immutable'); END;
CREATE TRIGGER investor_action_review_confirmation_delete BEFORE DELETE ON investor_action_review_confirmations BEGIN SELECT RAISE(ABORT,'action review confirmation immutable'); END;
CREATE TABLE investor_action_review_job_requests_rebuild (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id),
  kind TEXT NOT NULL CHECK(kind IN ('preview','confirmation')), authority_id TEXT NOT NULL, preview_id TEXT,
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=0), idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=1048576),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(created_at<valid_until),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(authority_id,workspace_id) REFERENCES investor_action_authorities(id,workspace_id),
  FOREIGN KEY(preview_id,workspace_id) REFERENCES investor_action_review_previews(id,workspace_id),
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,idempotency_key),
  CHECK((kind='preview' AND preview_id IS NULL) OR (kind='confirmation' AND preview_id IS NOT NULL)),
  CHECK(json_extract(document_json,'$.schema_version')!='investor-action-review-job-request-v2' OR
    (kind='confirmation' AND json_extract(document_json,'$.body.schema_version') IS 'investor-unchanged-action-recovery-submit-v1')),
  CHECK(json_extract(document_json,'$.schema_version') IN ('investor-action-review-job-request-v1','investor-action-review-job-request-v2')
    AND json_extract(document_json,'$.request_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id
    AND json_extract(document_json,'$.kind') IS kind AND json_extract(document_json,'$.request_hash') IS request_hash
    AND json_extract(document_json,'$.body.expected_revision') IS expected_revision AND json_extract(document_json,'$.body.idempotency_key') IS idempotency_key
    AND json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until),
  CHECK((kind='preview' AND json_extract(document_json,'$.body.authority_id') IS authority_id)
    OR (kind='confirmation' AND json_extract(document_json,'$.body.preview_id') IS preview_id))
);
INSERT INTO investor_action_review_job_requests_rebuild(rowid,id,workspace_id,kind,authority_id,preview_id,expected_revision,idempotency_key,request_hash,document_json,content_hash,actor_id,created_at,valid_until,audit_id) SELECT rowid,id,workspace_id,kind,authority_id,preview_id,expected_revision,idempotency_key,request_hash,document_json,content_hash,actor_id,created_at,valid_until,audit_id FROM investor_action_review_job_requests;
DROP TABLE investor_action_review_job_requests;
ALTER TABLE investor_action_review_job_requests_rebuild RENAME TO investor_action_review_job_requests;
CREATE TRIGGER investor_action_review_job_request_insert BEFORE INSERT ON investor_action_review_job_requests BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM investor_workspaces w JOIN investor_action_authorities p ON p.workspace_id=w.id
    JOIN audit_events a ON a.id=NEW.audit_id WHERE w.id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND w.revision=NEW.expected_revision
    AND p.id=NEW.authority_id AND p.actor_id=NEW.actor_id AND p.created_at<=NEW.created_at
    AND NOT EXISTS(SELECT 1 FROM investor_action_review_confirmations WHERE previous_authority_id=p.id)
    AND a.actor_id=NEW.actor_id AND a.action='investor_enqueue_action_review' AND a.object_type='investor_action_review_job_request'
    AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'action review job request binding differs') END;
  SELECT CASE WHEN NEW.kind='confirmation' AND NOT EXISTS(SELECT 1 FROM investor_action_review_previews v
    WHERE v.id=NEW.preview_id AND v.workspace_id=NEW.workspace_id AND v.authority_id=NEW.authority_id AND v.actor_id=NEW.actor_id
    AND v.workspace_revision=NEW.expected_revision AND v.created_at<=NEW.created_at AND NEW.valid_until<=v.valid_until
    AND NOT EXISTS(SELECT 1 FROM investor_action_review_confirmations WHERE preview_id=v.id))
    THEN RAISE(ABORT,'action review job preview binding differs') END;
END;
CREATE TRIGGER investor_action_review_job_request_update BEFORE UPDATE ON investor_action_review_job_requests BEGIN SELECT RAISE(ABORT,'action review job request immutable'); END;
CREATE TRIGGER investor_action_review_job_request_delete BEFORE DELETE ON investor_action_review_job_requests BEGIN SELECT RAISE(ABORT,'action review job request immutable'); END;
PRAGMA legacy_alter_table=OFF;
