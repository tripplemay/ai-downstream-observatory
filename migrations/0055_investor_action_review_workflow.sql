CREATE TABLE investor_action_review_previews (
  id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id),
  authority_id TEXT NOT NULL, control_id TEXT NOT NULL, workspace_revision INTEGER NOT NULL CHECK(workspace_revision>0),
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=16384),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, valid_until TEXT NOT NULL CHECK(valid_until>created_at),
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(control_id,workspace_id,authority_id) REFERENCES investor_action_controls(id,workspace_id,authority_id),
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,idempotency_key),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-action-review-preview-v1'),
  CHECK(json_extract(document_json,'$.preview_id') IS id AND json_extract(document_json,'$.workspace_id') IS workspace_id
    AND json_extract(document_json,'$.authority_id') IS authority_id AND json_extract(document_json,'$.control_id') IS control_id
    AND json_extract(document_json,'$.workspace_revision') IS workspace_revision AND json_extract(document_json,'$.request_hash') IS request_hash
    AND json_extract(document_json,'$.created_at') IS created_at AND json_extract(document_json,'$.valid_until') IS valid_until),
  CHECK(json_type(document_json,'$.approval_performed') IS 'false' AND json_type(document_json,'$.research_admitted') IS 'false'
    AND json_type(document_json,'$.trading_permission') IS 'false' AND json_extract(document_json,'$.provider_calls') IS 0)
);
CREATE TABLE investor_action_review_confirmations (
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
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-action-review-confirmation-v1'),
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
CREATE TRIGGER investor_action_review_preview_insert BEFORE INSERT ON investor_action_review_previews BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM investor_action_review_previews WHERE id=NEW.id OR (workspace_id=NEW.workspace_id AND idempotency_key=NEW.idempotency_key))
    OR EXISTS(SELECT 1 FROM investor_action_review_confirmations WHERE previous_authority_id=NEW.authority_id)
    OR NOT EXISTS(SELECT 1 FROM investor_workspaces w JOIN investor_action_authorities p ON p.workspace_id=w.id
      JOIN investor_action_controls c ON c.authority_id=p.id JOIN audit_events a ON a.id=NEW.audit_id
      WHERE w.id=NEW.workspace_id AND w.owner_id=NEW.actor_id AND NEW.workspace_revision=w.revision+1
      AND p.id=NEW.authority_id AND c.id=NEW.control_id AND c.version=(SELECT max(version) FROM investor_action_controls WHERE authority_id=p.id)
      AND p.actor_id=NEW.actor_id AND json_extract(NEW.document_json,'$.authority_hash') IS p.content_hash
      AND json_extract(NEW.document_json,'$.control_hash') IS c.content_hash AND c.created_at<=NEW.created_at
      AND json_extract(NEW.document_json,'$.checked_at')<=NEW.created_at
      AND a.actor_id=NEW.actor_id AND a.action='investor_preview_action_review' AND a.object_type='investor_action_review_preview'
      AND a.object_id=NEW.id AND a.created_at=NEW.created_at AND json_extract(a.payload_json,'$.content_hash') IS NEW.content_hash)
    THEN RAISE(ABORT,'action review preview binding differs') END;
END;
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
CREATE TRIGGER investor_action_review_retired_control BEFORE INSERT ON investor_action_controls BEGIN
  SELECT CASE WHEN NEW.enabled=1 AND EXISTS(SELECT 1 FROM investor_action_review_confirmations WHERE previous_authority_id=NEW.authority_id)
    THEN RAISE(ABORT,'action review predecessor is retired') END;
END;
CREATE TRIGGER investor_action_review_preview_update BEFORE UPDATE ON investor_action_review_previews BEGIN SELECT RAISE(ABORT,'action review preview immutable'); END;
CREATE TRIGGER investor_action_review_preview_delete BEFORE DELETE ON investor_action_review_previews BEGIN SELECT RAISE(ABORT,'action review preview immutable'); END;
CREATE TRIGGER investor_action_review_confirmation_update BEFORE UPDATE ON investor_action_review_confirmations BEGIN SELECT RAISE(ABORT,'action review confirmation immutable'); END;
CREATE TRIGGER investor_action_review_confirmation_delete BEFORE DELETE ON investor_action_review_confirmations BEGIN SELECT RAISE(ABORT,'action review confirmation immutable'); END;
