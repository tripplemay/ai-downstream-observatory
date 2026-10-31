CREATE TABLE investor_calendar_continuations (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES investor_workspaces(id),
  source_id TEXT NOT NULL,
  previous_review_id TEXT NOT NULL,
  new_review_id TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=8192),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  audit_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
  FOREIGN KEY(source_id,workspace_id) REFERENCES investor_data_sources(id,workspace_id),
  FOREIGN KEY(previous_review_id,workspace_id) REFERENCES investor_data_reviews(id,workspace_id),
  FOREIGN KEY(new_review_id,workspace_id) REFERENCES investor_data_reviews(id,workspace_id),
  UNIQUE(workspace_id,previous_review_id), UNIQUE(workspace_id,new_review_id),
  CHECK(previous_review_id!=new_review_id),
  CHECK(json_extract(document_json,'$.schema_version') IS 'investor-calendar-continuation-v1'),
  CHECK(json_extract(document_json,'$.workspace_id') IS workspace_id AND json_extract(document_json,'$.source_id') IS source_id),
  CHECK(json_extract(document_json,'$.previous_review_id') IS previous_review_id AND json_extract(document_json,'$.new_review_id') IS new_review_id),
  CHECK(json_extract(document_json,'$.created_at') IS created_at),
  CHECK(json_extract(document_json,'$.approval_basis') IS 'owner_reviewed_unchanged_calendar_prefix'),
  CHECK(json_extract(document_json,'$.scope') IS 'historical_prefix_only_not_source_renewal'),
  CHECK(json_type(document_json,'$.collection_permission') IS 'false' AND json_type(document_json,'$.trading_permission') IS 'false')
);
CREATE TRIGGER investor_calendar_continuation_insert BEFORE INSERT ON investor_calendar_continuations BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM investor_data_sources source
      JOIN investor_data_reviews previous ON previous.source_id=source.id AND previous.workspace_id=source.workspace_id
      JOIN investor_data_reviews next ON next.source_id=source.id AND next.workspace_id=source.workspace_id
      JOIN investor_workspaces workspace ON workspace.id=source.workspace_id JOIN audit_events audit ON audit.id=NEW.audit_id
    WHERE source.id=NEW.source_id AND source.workspace_id=NEW.workspace_id AND source.kind='calendar'
      AND previous.id=NEW.previous_review_id AND next.id=NEW.new_review_id
      AND previous.decision='approved' AND next.decision='approved' AND next.version=previous.version+1
      AND next.id=(SELECT id FROM investor_data_reviews WHERE source_id=source.id ORDER BY version DESC LIMIT 1)
      AND previous.created_at<=NEW.created_at AND next.created_at=NEW.created_at
      AND previous.valid_until>NEW.created_at AND next.valid_until>NEW.created_at
      AND source.actor_id=NEW.actor_id AND previous.actor_id=NEW.actor_id AND next.actor_id=NEW.actor_id AND workspace.owner_id=NEW.actor_id
      AND json_extract(NEW.document_json,'$.source_hash') IS source.content_hash
      AND json_extract(NEW.document_json,'$.previous_review_hash') IS previous.content_hash
      AND json_extract(NEW.document_json,'$.new_review_hash') IS next.content_hash
      AND audit.actor_id=NEW.actor_id AND audit.action='investor_continue_calendar_review'
      AND audit.object_type='investor_calendar_continuation' AND audit.object_id=NEW.id AND audit.created_at=NEW.created_at
      AND json_extract(audit.payload_json,'$.content_hash') IS NEW.content_hash
  ) THEN RAISE(ABORT,'calendar continuation binding differs') END;
END;
CREATE TRIGGER investor_calendar_continuation_update BEFORE UPDATE ON investor_calendar_continuations BEGIN SELECT RAISE(ABORT,'calendar continuation immutable'); END;
CREATE TRIGGER investor_calendar_continuation_delete BEFORE DELETE ON investor_calendar_continuations BEGIN SELECT RAISE(ABORT,'calendar continuation immutable'); END;
