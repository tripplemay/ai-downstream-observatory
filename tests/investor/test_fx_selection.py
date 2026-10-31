"""Fictional reviewed FX series, never a provider call or investment approval."""

from copy import deepcopy
import unittest
from unittest.mock import patch

from worker.investor.fx_selection import select_current_fx
from worker.orchestration.db import WorkbenchError


NOW = "2026-01-03T12:00:03.000Z"
SERIES = {"authority_id": "fictional-reference-cny-series", "revision_policy": "append_only_no_restatements"}


def reviewed(identifier, dates=("2026-01-03",), *, series=SERIES, known=NOW, currency="USD", value="7.1"):
    facts = {"currency": currency, "unit": "CNY_per_unit_currency", "rows": [
        {"observed_at": day + "T10:00:00Z", "assumed_available_at": day + "T10:01:00Z", "value": value} for day in dates]}
    if series is not None:
        facts["monitor_series"] = deepcopy(series)
    return {"review": {"id": identifier, "created_at": known, "valid_until": "2027-01-01T00:00:00.000Z"}, "facts": facts}


class CurrentFxSelectionTests(unittest.TestCase):
    def choose(self, reviews, **kwargs):
        return select_current_fx(reviews, {"USD"}, at=NOW, max_age_seconds=172800, **kwargs)

    def test_legacy_unique_current_source_survives_unrelated_stale_history(self):
        old = reviewed("old", ("2025-12-29",), series=None)
        current = reviewed("current", series=None)
        before = deepcopy([old, current])
        self.assertEqual(self.choose([old, current]), {"USD": "current"})
        self.assertEqual([old, current], before)

    def test_unlabelled_duplicates_and_distinct_authorities_stay_ambiguous_even_if_equal(self):
        for series in (None, {**SERIES, "authority_id": "fictional-different-authority"}):
            with self.subTest(series=series), self.assertRaisesRegex(WorkbenchError, "AUTHORITY_AMBIGUOUS"):
                self.choose([reviewed("a"), reviewed("b", series=series)])

    def test_same_explicit_series_selects_latest_observation_not_latest_review(self):
        older_tail = reviewed("late-backfill", ("2026-01-01", "2026-01-02"), known=NOW)
        new_tail = reviewed("new-observation", ("2026-01-01", "2026-01-02", "2026-01-03"), known="2026-01-03T11:00:00Z")
        self.assertEqual(self.choose([older_tail, new_tail]), {"USD": "new-observation"})
        self.assertEqual(self.choose([new_tail, older_tail]), {"USD": "new-observation"})

    def test_same_tail_prefers_concordant_wider_history_then_stable_identity(self):
        narrow = reviewed("a", known=NOW)
        wider = reviewed("z", ("2026-01-02", "2026-01-03"), known="2026-01-03T11:00:00Z")
        self.assertEqual(self.choose([narrow, wider]), {"USD": "z"})
        duplicate = deepcopy(wider); duplicate["review"]["id"] = "b"
        self.assertEqual(self.choose([wider, duplicate]), {"USD": "b"})

    def test_overlap_amount_or_availability_correction_requires_explicit_restatement(self):
        for key, value in (("value", "7.2"), ("assumed_available_at", "2026-01-02T10:02:00Z")):
            current = reviewed("current", ("2026-01-02", "2026-01-03"))
            current["facts"]["rows"][0][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(WorkbenchError, "RESTATEMENT_REQUIRED"):
                self.choose([reviewed("prior", ("2026-01-02",)), current])

    def test_corrections_in_stale_same_series_history_are_not_silently_discarded(self):
        old = reviewed("old", ("2025-12-29",))
        current = reviewed("current", ("2025-12-29", "2026-01-03"))
        current["facts"]["rows"][0]["value"] = "7.2"
        with self.assertRaisesRegex(WorkbenchError, "RESTATEMENT_REQUIRED"):
            self.choose([old, current])

    def test_numerically_equal_decimals_and_equivalent_instants_are_concordant(self):
        a, b = reviewed("a"), reviewed("b", value="7.100")
        b["facts"]["rows"][0]["observed_at"] = "2026-01-03T10:00:00.000Z"
        b["facts"]["rows"][0]["assumed_available_at"] = "2026-01-03T10:01:00.000Z"
        self.assertEqual(self.choose([b, a]), {"USD": "a"})

    def test_stale_equality_boundary_is_not_current_and_budget_is_not_widened(self):
        row = reviewed("boundary", ("2026-01-01",), known="2026-01-01T11:00:00Z")
        with self.assertRaisesRegex(WorkbenchError, "NOT_CURRENT"):
            select_current_fx([row], {"USD"}, at="2026-01-03T10:00:00Z", max_age_seconds=172800)
        self.assertEqual(select_current_fx([row], {"USD"}, at="2026-01-03T09:59:59Z", max_age_seconds=172800), {"USD": "boundary"})

    def test_future_observation_or_availability_is_invalid_even_beside_fresh_source(self):
        for row in (reviewed("future", ("2026-01-04",)), reviewed("unavailable"), reviewed("future-review", known="2026-01-04T12:00:03Z")):
            if row["review"]["id"] == "unavailable":
                row["facts"]["rows"][0]["assumed_available_at"] = "2026-01-03T12:01:00Z"
            with self.subTest(id=row["review"]["id"]), self.assertRaises(WorkbenchError):
                self.choose([reviewed("current"), row])

    def test_expired_duplicate_ids_unknown_revision_and_bad_budget_reject(self):
        expired = reviewed("expired"); expired["review"]["valid_until"] = NOW
        unknown = reviewed("unknown"); unknown["facts"]["monitor_series"]["revision_policy"] = "pick_newest"
        for rows in ([expired], [reviewed("same"), reviewed("same")], [unknown]):
            with self.assertRaises(WorkbenchError): self.choose(rows)
        for seconds in (True, 0, 604801, 86400.0):
            with self.assertRaises(WorkbenchError):
                select_current_fx([reviewed("a")], {"USD"}, at=NOW, max_age_seconds=seconds)

    def test_currency_scope_and_bounded_work_do_not_merge_different_series(self):
        self.assertEqual(select_current_fx([reviewed("usd"), reviewed("hkd", currency="HKD")], {"USD", "HKD"},
            at=NOW, max_age_seconds=172800), {"HKD": "hkd", "USD": "usd"})
        self.assertEqual(select_current_fx([], set(), at=NOW, max_age_seconds=1), {})
        with patch("worker.investor.fx_selection.MAX_ROWS", 1), self.assertRaisesRegex(WorkbenchError, "SOURCE_LIMIT"):
            self.choose([reviewed("two", ("2026-01-02", "2026-01-03"))])
        with self.assertRaisesRegex(WorkbenchError, "SOURCE_LIMIT"):
            self.choose([reviewed(str(n)) for n in range(129)])


if __name__ == "__main__":
    unittest.main()
