"""Reject sub-microsecond instants rather than truncate future information."""

import re

from worker.orchestration.db import WorkbenchError


TIME_FIELDS = {"observed_at", "ingested_at", "published_at", "close_at", "available_at", "settled_at", "tradable_from", "tradable_until", "at", "start", "end", "decision_times"}


def validate_time_precision(document, field=None):
    if isinstance(document, dict):
        for key, value in document.items():
            validate_time_precision(value, key)
    elif isinstance(document, list):
        for value in document:
            validate_time_precision(value, field)
    elif isinstance(document, str) and field in TIME_FIELDS and "T" in document:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", document):
            raise WorkbenchError("INVESTOR_RESEARCH_TIME_PRECISION_UNSUPPORTED")
