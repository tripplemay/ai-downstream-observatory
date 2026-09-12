CREATE TABLE catalog_heads (
  portfolio_id TEXT PRIMARY KEY REFERENCES portfolios(id),
  revision INTEGER NOT NULL CHECK(revision >= 0 AND revision <= 9007199254740991),
  updated_at TEXT NOT NULL
);

CREATE TABLE catalog_entries (
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  listing_id TEXT NOT NULL REFERENCES listings(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(portfolio_id, listing_id)
);

CREATE TABLE catalog_sources (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
  reference TEXT NOT NULL CHECK(length(trim(reference)) BETWEEN 1 AND 2000),
  media_type TEXT NOT NULL DEFAULT 'application/json' CHECK(media_type='application/json'),
  content_text TEXT NOT NULL CHECK(json_valid(content_text) AND json_type(content_text)='object'
    AND length(CAST(content_text AS BLOB)) <= 1048576),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  known_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE(id, portfolio_id)
);
CREATE INDEX catalog_sources_scope ON catalog_sources(portfolio_id, known_at, id);

CREATE TABLE etf_profile_versions (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0 AND version <= 9007199254740991),
  source_id TEXT NOT NULL,
  as_of TEXT NOT NULL,
  known_at TEXT NOT NULL,
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json) AND json_type(profile_json)='object'),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  created_by TEXT NOT NULL,
  UNIQUE(portfolio_id, listing_id, version),
  UNIQUE(id, portfolio_id, listing_id),
  FOREIGN KEY(source_id, portfolio_id) REFERENCES catalog_sources(id, portfolio_id),
  FOREIGN KEY(portfolio_id, listing_id) REFERENCES catalog_entries(portfolio_id, listing_id)
);

CREATE TABLE etf_holdings_versions (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0 AND version <= 9007199254740991),
  source_id TEXT NOT NULL,
  as_of TEXT NOT NULL,
  known_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  created_by TEXT NOT NULL,
  UNIQUE(portfolio_id, listing_id, version),
  UNIQUE(id, portfolio_id, listing_id),
  FOREIGN KEY(source_id, portfolio_id) REFERENCES catalog_sources(id, portfolio_id),
  FOREIGN KEY(portfolio_id, listing_id) REFERENCES catalog_entries(portfolio_id, listing_id),
  CHECK(json_extract(snapshot_json,'$.schema_version') IS 'holdings-disclosure-v1'
    AND json_extract(snapshot_json,'$.snapshot_id') IS id
    AND json_extract(snapshot_json,'$.portfolio_id') IS portfolio_id
    AND json_extract(snapshot_json,'$.listing_id') IS listing_id
    AND json_type(snapshot_json,'$.version') IS 'integer'
    AND json_extract(snapshot_json,'$.version') IS version
    AND json_extract(snapshot_json,'$.as_of') IS as_of
    AND json_extract(snapshot_json,'$.known_at') IS known_at
    AND json_extract(snapshot_json,'$.content_hash') IS content_hash)
);

CREATE TRIGGER catalog_head_revision BEFORE UPDATE ON catalog_heads
WHEN NEW.portfolio_id != OLD.portfolio_id OR NEW.revision != OLD.revision+1
BEGIN SELECT RAISE(ABORT,'catalog head revision must advance once'); END;
CREATE TRIGGER catalog_head_no_delete BEFORE DELETE ON catalog_heads BEGIN SELECT RAISE(ABORT,'catalog heads cannot be deleted'); END;
CREATE TRIGGER catalog_entry_no_update BEFORE UPDATE ON catalog_entries BEGIN SELECT RAISE(ABORT,'catalog entries are append-only'); END;
CREATE TRIGGER catalog_entry_no_delete BEFORE DELETE ON catalog_entries BEGIN SELECT RAISE(ABORT,'catalog entries are append-only'); END;
CREATE TRIGGER catalog_source_no_update BEFORE UPDATE ON catalog_sources BEGIN SELECT RAISE(ABORT,'catalog sources are append-only'); END;
CREATE TRIGGER catalog_source_no_delete BEFORE DELETE ON catalog_sources BEGIN SELECT RAISE(ABORT,'catalog sources are append-only'); END;
CREATE TRIGGER etf_profile_no_update BEFORE UPDATE ON etf_profile_versions BEGIN SELECT RAISE(ABORT,'ETF profiles are append-only'); END;
CREATE TRIGGER etf_profile_no_delete BEFORE DELETE ON etf_profile_versions BEGIN SELECT RAISE(ABORT,'ETF profiles are append-only'); END;
CREATE TRIGGER etf_holdings_no_update BEFORE UPDATE ON etf_holdings_versions BEGIN SELECT RAISE(ABORT,'ETF holdings are append-only'); END;
CREATE TRIGGER etf_holdings_no_delete BEFORE DELETE ON etf_holdings_versions BEGIN SELECT RAISE(ABORT,'ETF holdings are append-only'); END;
