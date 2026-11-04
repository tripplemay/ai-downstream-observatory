"""Scoped pure-shape de-duplication for explicitly offline fixtures only.

Never cache sources, permissions, raw-byte replay, dataset semantics or math.
Production validators and their own memoization limits remain unchanged.
"""

from contextlib import contextmanager
from contextvars import ContextVar
from hashlib import sha256
import json
import math
import sys
from threading import get_ident
from time import perf_counter
from urllib.parse import urljoin
from unittest.mock import patch

from worker.market import contracts
from worker.research import snapshot


SCHEMA = "research-dataset.schema.json"
MAX_ENTRIES = 8
MAX_BYTES = 8388608
MAX_NODES = 100000
_ACTIVE = ContextVar("offline_fixture_dataset_shapes", default=None)


def _document_key(value):
    pending, seen, count = [value], set(), 0
    while pending:
        item = pending.pop(); kind = type(item); count += 1
        if count > MAX_NODES: return None
        if kind in (dict, list):
            if id(item) in seen: return None
            seen.add(id(item))
        if kind is dict:
            if any(type(key) is not str for key in item): return None
            pending.extend(item.values())
        elif kind is list: pending.extend(item)
        elif kind is float:
            if not math.isfinite(item): return None
        elif kind not in (str, int, bool, type(None)): return None
    try: encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
    except (ValueError, TypeError, OverflowError, RecursionError, UnicodeError): return None
    # Small values already use the original production shape cache.
    if not 65536 < len(encoded) <= MAX_BYTES: return None
    return sha256(encoded).digest()


def _schema_key():
    schemas, registry, checker = contracts._schemas()
    by_uri = {value["$id"]: name for name, value in schemas.items()}
    pending, selected = [SCHEMA], {}
    while pending:
        name = pending.pop()
        if name in selected: continue
        if name not in schemas or len(selected) >= 8: return None
        document = schemas[name]; selected[name] = document
        nodes = [document]
        while nodes:
            value = nodes.pop()
            if type(value) is dict:
                if "$dynamicRef" in value: return None
                reference = value.get("$ref")
                if type(reference) is str and not reference.startswith("#"):
                    uri = urljoin(document["$id"], reference).split("#")[0]
                    if uri not in by_uri: return None
                    pending.append(by_uri[uri])
                nodes.extend(value.values())
            elif type(value) is list: nodes.extend(value)
    encoded = json.dumps(selected, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
    formats = tuple((name, callback, raises if type(raises) is tuple else (raises,)) for name, (callback, raises) in sorted(checker.checkers.items()))
    hash(formats)
    return registry, checker, sha256(encoded).digest(), formats


@contextmanager
def fixture_dataset_shapes():
    active = _ACTIVE.get()
    if active is not None:
        yield active["metrics"]
        return
    original = snapshot.validate_contract
    metrics = {"checks": 0, "validated": 0, "hits": 0, "uncacheable": 0, "entries": 0,
               "key_ms": 0.0, "validation_ms": 0.0, "elapsed_ms": 0.0}
    # Do not replace another test's wrapper or share a scope across threads.
    if original is not contracts.validate_contract:
        yield metrics
        return
    state = {"metrics": metrics, "keys": set(), "registry": None, "checker": None, "thread": get_ident()}
    started = perf_counter(); token = _ACTIVE.set(state)

    def timing(phase):
        metrics["elapsed_ms"] = (perf_counter() - started) * 1000
        try:
            print("FICTIONAL_SHAPE_TIMING " + json.dumps({"phase": phase, **metrics}, sort_keys=True), file=sys.stderr, flush=True)
        except (OSError, ValueError):
            pass  # Diagnostics must not replace a fixture's original failure.

    timing("start")

    def checked(value, name="market-batch.schema.json", fragment=None):
        if name != SCHEMA or fragment is not None or _ACTIVE.get() is not state or get_ident() != state["thread"]:
            return original(value, name, fragment)
        metrics["checks"] += 1; key_started = perf_counter()
        document_key = _document_key(value); key = None
        if document_key is not None:
            try: schema = _schema_key()
            except (ValueError, TypeError, KeyError, RecursionError, UnicodeError): schema = None
            if schema is not None:
                registry, checker, digest, formats = schema
                if registry is not state["registry"] or checker is not state["checker"]:
                    state["keys"].clear(); metrics["entries"] = 0
                    state["registry"], state["checker"] = registry, checker
                key = document_key, digest, formats
        metrics["key_ms"] += (perf_counter() - key_started) * 1000
        if key is not None and key in state["keys"]:
            metrics["hits"] += 1
            if metrics["checks"] % 128 == 0: timing("progress")
            return None
        metrics["validated"] += 1
        if key is None: metrics["uncacheable"] += 1
        validation_started = perf_counter()
        try: result = original(value, name, fragment)
        finally:
            metrics["validation_ms"] += (perf_counter() - validation_started) * 1000
            if metrics["checks"] % 128 == 0: timing("progress")
        if result is None and key is not None and len(state["keys"]) < MAX_ENTRIES:
            # Even test-provided format callbacks must not mutate a memoized input.
            try: following = _schema_key()
            except (ValueError, TypeError, KeyError, RecursionError, UnicodeError): following = None
            if following is not None and following[0] is state["registry"] and following[1] is state["checker"]:
                confirmed = _document_key(value), following[2], following[3]
                if confirmed == key:
                    state["keys"].add(key); metrics["entries"] = len(state["keys"])
        return result

    try:
        with patch.object(snapshot, "validate_contract", checked): yield metrics
    finally:
        state["keys"].clear(); _ACTIVE.reset(token)
        timing("end")
