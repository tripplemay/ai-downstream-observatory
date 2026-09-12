"""Immutable market originals and complete, versioned publication snapshots."""

import json
from zoneinfo import ZoneInfo

from worker.orchestration.db import (
    WorkbenchError, canonical_json, content_hash, instant, stamp, transaction,
)
from .contracts import observation_semantics, validate_contract


OBSERVATION_COLUMNS = (
    "id", "batch_id", "source_id", "listing_id", "series_key", "metric", "value", "unit",
    "observed_at", "published_at", "ingested_at", "source_timezone", "time_precision", "price_basis",
    "revision_id", "raw_hash", "parser_version", "provenance",
)
IDENTITY_COLUMNS = ("source_id", "series_key", "metric", "observed_at", "price_basis", "revision_id")


def _batch(connection, batch_id):
    row = connection.execute("SELECT * FROM market_batches WHERE id=?", (batch_id,)).fetchone()
    if row is None:
        raise WorkbenchError("BATCH_NOT_FOUND")
    result = dict(row)
    result["validation"] = json.loads(result.pop("validation_json"))
    return result


def stage_batch(connection, plan, now=None):
    validate_contract(plan, fragment="properties/batch")
    plan = dict(plan)
    for key in ("expected_pages", "expected_rows", "expected_publication_revision"):
        plan[key] = int(plan[key])
    with transaction(connection):
        existing = connection.execute("SELECT id FROM market_batches WHERE id=?", (plan["id"],)).fetchone()
        if existing:
            result = _batch(connection, plan["id"])
            if result["validation"]["plan"] != plan:
                raise WorkbenchError("BATCH_IDEMPOTENCY_CONFLICT")
            return result
        connection.execute("""INSERT INTO market_batches
            (id,source_id,batch_type,scope,status,expected_pages,validation_json,started_at)
            VALUES(?,?,?,?,'staging',?,?,?)""",
                           (plan["id"], plan["source_id"], plan["batch_type"], plan["scope"],
                            plan["expected_pages"], canonical_json({"plan": plan}), stamp(now)))
        return _batch(connection, plan["id"])


def stage_page(connection, batch_id, page_number, observations, now=None):
    validate_contract({"page_number": page_number, "observations": observations}, fragment="properties/pages/items")
    page_number = int(page_number)
    received = stamp(now)
    body, digest = canonical_json(observations), content_hash(observations)
    with transaction(connection):
        batch = _batch(connection, batch_id)
        existing = connection.execute("SELECT * FROM market_batch_pages WHERE batch_id=? AND page_number=?",
                                      (batch_id, page_number)).fetchone()
        if existing:
            if existing["payload_hash"] != digest:
                raise WorkbenchError("PAGE_IDEMPOTENCY_CONFLICT")
            return dict(existing)
        if batch["status"] != "staging":
            raise WorkbenchError("BATCH_NOT_STAGING")
        if page_number > batch["expected_pages"]:
            raise WorkbenchError("PAGE_OUTSIDE_EXPECTED_RANGE")
        for observation in observations:
            observation_semantics(observation, batch["validation"]["plan"])
        connection.execute("""INSERT INTO market_batch_pages
            (batch_id,page_number,payload_hash,observations_json,received_at) VALUES(?,?,?,?,?)""",
                           (batch_id, page_number, digest, body, received))
        count = connection.execute("SELECT COUNT(*) FROM market_batch_pages WHERE batch_id=?", (batch_id,)).fetchone()[0]
        connection.execute("UPDATE market_batches SET received_pages=? WHERE id=?", (count, batch_id))
        return dict(connection.execute("SELECT * FROM market_batch_pages WHERE batch_id=? AND page_number=?",
                                       (batch_id, page_number)).fetchone())


def _normalized_observation(connection, raw, plan, received):
    observation_semantics(raw, plan)
    row = {name: raw.get(name) for name in OBSERVATION_COLUMNS}
    row["ingested_at"] = received
    if row["time_precision"] == "second":
        row["observed_at"] = stamp(row["observed_at"])
        if instant(row["observed_at"]) > instant(received):
            raise WorkbenchError("OBSERVED_AFTER_INGESTION")
    elif row["observed_at"] > instant(received).astimezone(ZoneInfo(row["source_timezone"])).date().isoformat():
        raise WorkbenchError("OBSERVED_AFTER_INGESTION")
    if row["published_at"] is not None:
        row["published_at"] = stamp(row["published_at"])
        if instant(row["published_at"]) > instant(received):
            raise WorkbenchError("PUBLISHED_AFTER_INGESTION")
        if row["time_precision"] == "second" and instant(row["published_at"]) < instant(row["observed_at"]):
            raise WorkbenchError("PUBLISHED_BEFORE_OBSERVATION")
    if row["listing_id"] is not None:
        listing = connection.execute("SELECT currency FROM listings WHERE id=?", (row["listing_id"],)).fetchone()
        if listing is None:
            raise WorkbenchError("UNKNOWN_LISTING:" + row["listing_id"])
        if row["metric"] == "close" and row["unit"] != listing["currency"]:
            raise WorkbenchError("PRICE_CURRENCY_MISMATCH:" + row["listing_id"])
    return row


def _stable_fields(row):
    return {key: row[key] for key in OBSERVATION_COLUMNS if key not in ("id", "batch_id", "ingested_at")}


def validate_batch(connection, batch_id, now=None):
    with transaction(connection):
        batch = _batch(connection, batch_id)
        if batch["status"] != "staging":
            return batch
        pages = connection.execute("SELECT * FROM market_batch_pages WHERE batch_id=? ORDER BY page_number", (batch_id,)).fetchall()
        plan, issues, rows, seen = batch["validation"]["plan"], [], [], set()
        if [page["page_number"] for page in pages] != list(range(1, plan["expected_pages"] + 1)):
            issues.append("INCOMPLETE_PAGES")
        for page in pages:
            for raw in json.loads(page["observations_json"]):
                try:
                    row = _normalized_observation(connection, raw, plan, page["received_at"])
                    identity = tuple(row[key] for key in IDENTITY_COLUMNS)
                    if identity in seen:
                        raise WorkbenchError("DUPLICATE_OBSERVATION_IN_BATCH")
                    seen.add(identity)
                    rows.append(row)
                except (ValueError, TypeError) as exc:
                    issues.append(str(exc))
        if len(rows) != plan["expected_rows"]:
            issues.append("ROW_COUNT_MISMATCH")
        if not rows:
            issues.append("EMPTY_BATCH")
        existing_ids = set()
        for row in rows:
            old = connection.execute("SELECT * FROM market_observations WHERE " + " AND ".join(key + "=?" for key in IDENTITY_COLUMNS),
                                     tuple(row[key] for key in IDENTITY_COLUMNS)).fetchone()
            if old is not None:
                if _stable_fields(old) != _stable_fields(row):
                    issues.append("OBSERVATION_REVISION_CONFLICT")
                row["id"] = old["id"]
                existing_ids.add(old["id"])
            elif connection.execute("SELECT 1 FROM market_observations WHERE id=?", (row["id"],)).fetchone():
                issues.append("OBSERVATION_ID_CONFLICT")
        if len({row["id"] for row in rows}) != len(rows):
            issues.append("DUPLICATE_OBSERVATION_ID")
        if issues:
            status = "partial" if set(issues) <= {"INCOMPLETE_PAGES", "ROW_COUNT_MISMATCH", "EMPTY_BATCH"} else "failed"
            connection.execute("UPDATE market_batches SET status=?,row_count=?,validation_json=?,completed_at=? WHERE id=?",
                               (status, len(rows), canonical_json({"plan": plan, "issues": sorted(set(issues))}), stamp(now), batch_id))
            return _batch(connection, batch_id)
        for row in rows:
            if row["id"] not in existing_ids:
                connection.execute("INSERT INTO market_observations(" + ",".join(OBSERVATION_COLUMNS) + ") VALUES(" + ",".join("?" for _ in OBSERVATION_COLUMNS) + ")",
                                   tuple(row[key] for key in OBSERVATION_COLUMNS))
            connection.execute("INSERT INTO market_batch_members(batch_id,observation_id) VALUES(?,?)", (batch_id, row["id"]))
        manifest = {"schema_version": "market-publication-v1", "plan": plan,
                    "pages": [{"page_number": page["page_number"], "payload_hash": page["payload_hash"], "received_at": page["received_at"]} for page in pages],
                    "observation_ids": sorted(row["id"] for row in rows)}
        connection.execute("UPDATE market_batches SET status='validated',row_count=?,manifest_hash=?,validation_json=? WHERE id=?",
                           (len(rows), content_hash(manifest), canonical_json({"plan": plan, "issues": [], "manifest": manifest}), batch_id))
        return _batch(connection, batch_id)


def publish_batch(connection, batch_id, expected_revision=None, now=None):
    current = stamp(now)
    with transaction(connection):
        batch = _batch(connection, batch_id)
        published = connection.execute("SELECT * FROM market_publication_events WHERE batch_id=?", (batch_id,)).fetchone()
        if batch["status"] == "published" and published:
            return dict(published)
        if batch["status"] != "validated":
            raise WorkbenchError("BATCH_NOT_VALIDATED")
        if current < batch["started_at"]:
            raise WorkbenchError("PUBLICATION_BEFORE_BATCH_START")
        latest_receipt = connection.execute("SELECT MAX(received_at) FROM market_batch_pages WHERE batch_id=?", (batch_id,)).fetchone()[0]
        if latest_receipt and current < latest_receipt:
            raise WorkbenchError("PUBLICATION_BEFORE_INGESTION")
        head = connection.execute("SELECT * FROM market_publications WHERE scope=?", (batch["scope"],)).fetchone()
        revision = head["revision"] if head else 0
        expected = batch["validation"]["plan"]["expected_publication_revision"] if expected_revision is None else expected_revision
        if expected != batch["validation"]["plan"]["expected_publication_revision"] or revision != expected:
            raise WorkbenchError("STALE_PUBLICATION_REVISION")
        if head and current < head["published_at"]:
            raise WorkbenchError("PUBLICATION_TIME_REGRESSION")
        values = (batch["scope"], revision + 1, batch_id, batch["manifest_hash"], current)
        connection.execute("INSERT INTO market_publication_events(scope,revision,batch_id,manifest_hash,published_at) VALUES(?,?,?,?,?)", values)
        connection.execute("""INSERT INTO market_publications(scope,revision,batch_id,manifest_hash,published_at)
            VALUES(?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,
            batch_id=excluded.batch_id,manifest_hash=excluded.manifest_hash,published_at=excluded.published_at""", values)
        connection.execute("UPDATE market_batches SET status='published',completed_at=? WHERE id=?", (current, batch_id))
        return dict(connection.execute("SELECT * FROM market_publication_events WHERE scope=? AND revision=?", (batch["scope"], revision + 1)).fetchone())


def ingest_document(connection, document, publish=False, now=None):
    validate_contract(document)
    stage_batch(connection, document["batch"], now)
    for page in document["pages"]:
        stage_page(connection, document["batch"]["id"], page["page_number"], page["observations"], now)
    result = validate_batch(connection, document["batch"]["id"], now)
    if publish and result["status"] in ("validated", "published"):
        publish_batch(connection, result["id"], now=now)
        result = _batch(connection, result["id"])
    return result
