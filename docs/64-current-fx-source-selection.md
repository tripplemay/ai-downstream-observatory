# Current FX review selection

This increment connects retained owner-reviewed FX observations to the first
monitor-input planner. It does not download/approve a source, grant supplier
rights, alter historical research, create a new strategy trial or enable trades.

## Why currency alone is not an authority

The old planner required exactly one approved review per currency. Keeping an
older historical review alongside a current review therefore blocked the first
monitor input even when the older observations had already exceeded the frozen
FX age ceiling. Selecting the most recently reviewed document would instead
allow a late backfill or unrelated supplier to silently replace a current rate.

`worker/investor/fx_selection.py` now:

1. Consumes resolved current reviews; identity, ownership, audit and retention
   verification stay in the existing resolver. A review date is not a quote date.
2. Requires valid dated facts known by the assessment time. Future observations
   or availability assumptions fail, rather than being silently skipped.
3. Applies the existing frozen FX age ceiling without increasing it. Equality at
   the expiry boundary is stale. A stale historical review is not withdrawn,
   overwritten or automatically reapproved just to obtain a unique current input.
4. Accepts a uniquely current legacy review without inventing lineage metadata.
   Multiple current reviews remain ambiguous unless the owner explicitly reviewed
   the same `monitor_series` declaration on all of them.
5. For that explicitly declared append-only series, checks overlapping amounts
   and assumed availability times, including retained stale same-series history.
   A correction produces `INVESTOR_MONITOR_FX_RESTATEMENT_REQUIRED`, not a silent
   rewrite. Numerically equal decimal spellings remain equal.
6. Chooses the greatest observation tail within a concordant series. Review
   creation time does not outrank a newer observation. Concordant duplicate tails
   prefer wider retained history and then stable receipt identity.

The optional closed FX-facts declaration is:

```json
{
  "monitor_series": {
    "authority_id": "fictional-reviewed-reference-series",
    "revision_policy": "append_only_no_restatements"
  }
}
```

This is an owner-reviewed assertion, not provider certification. Code must not
infer it from a domain, title, equal rates or an apparent supplier label. Distinct
current authority IDs and unlabelled duplicate reviews remain ambiguous. The
currency and `CNY_per_unit_currency` unit still scope each series independently;
the declaration does not certify that different currencies share one publication.

## Boundaries and continuation

The first-input planner selects each required currency once at the same assessment
time and binds its exact review ID/hash into the existing immutable snapshot.
Its quality-policy identifier advances to `investor-monitor-bootstrap-quality-v2`;
old saved input documents remain unchanged and replayable. Strategy tolerances,
risk, costs, funding intent, quote/FX age ceilings and weights are not retuned.
The final write transaction rechecks current selection before admission: a new
ambiguous authority, changed same-series tail or crossed expiry cannot commit an
old plan. This is a source fence, not an economic replan. CNY-only targets do not
require an unrelated FX authority.

Work is bounded by 128 resolved reviews and 100000 compared rows. Limits fail
closed; they are not a claim of ten-year rolling-source capacity. The scheduled
producer still needs explicit long-lived authority/head and retention governance,
and the later callback-feed admission must carry that lineage forward. This
increment does not silently refresh later feed windows or reset a saved model.

Issuer identity/amount basis, complete distribution/split coverage, actual current
FX capture/admission, independent monitor publication and normal/funding/stale
production journeys remain separate requirements of the full v2 product.

Fictional tests exercise pure selection, strict contracts, the real retained
review/price-receipt planner and snapshot replay. Model/research context in the
FX-specific planner fixture is explicitly stubbed; existing full saved-model/core
regressions provide separate coverage. Neither proves investment suitability or
real-source production monitoring.
