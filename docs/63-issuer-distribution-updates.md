# Exact issuer distributions: current-data pipeline increment

This increment contributes to [v2 continuous monitoring](09-product-v2-portfolio-first.md).
It is an intermediate provider draft, not a completed updater, approved source,
complete corporate-action archive or investment/production acceptance.

## Issuer response, not an AI reconstruction

`worker/market/providers/vanguard_distributions.py` reads the issuer's observed
distribution-list format using a requested fund ID and a closed boolean query
flag. JSON numeric amounts are parsed directly into Decimal, with the existing
38-digit/18-decimal fact limits. They never pass through binary floating point,
reinvestment prices or yield fields. The parser performs no network/DB calls.

The known income/capital-gain component codes remain separate even on the same
ex date. A derived natural key binds requested fund, component and ex/record/pay
dates, not amount. An amount correction therefore retains its identity; duplicate
components, including conflicting amounts, fail instead of becoming two payouts.
No source-provided event identifier is invented. All archive rows are validated
before window filtering, including records outside the requested interval.

Inputs are bounded by bytes, records, numeric token length and date window.
Duplicate JSON keys, unsupported component codes, malformed dates/order and
invalid amounts are rejected without rounding or skipping. The window ends no
later than the actual retrieval date in New York. Reported payment dates may be
later than the selected ex-date window; dates are not silently converted to UTC.

## Facts deliberately not supplied

The payload lacks a fund-identity assertion, currency, an explicit amount-basis
field, publication instant, tax and split coverage. The draft preserves those
gaps rather than claiming per-unit amounts or net dividends. Its fixed request
URL and checksum do not themselves prove network origin or supplier permission.
Empty selected windows do not certify that no distribution/action occurred.

Records contain only reported distribution amount, component and dates plus a
derived key. Reinvestment price/yield are not copied into financial output.
`owner_reviewed`, `corporate_actions_complete` and `research_admitted` remain
false. No automatic source approval, tax assumption, trading operation, changed
historical review, new research trial or holdout replay is introduced.

## Required continuation

1. Bind a bounded official download and immutable raw receipt to an explicit
   approved fund identity, currency, amount basis and usage authority.
2. Establish current distribution and split coverage with declared assumptions;
   payload count and optional provider descriptions are not completeness proof.
3. Publish reviewed current-source snapshots without replacing frozen research
   inputs. Bind FX selection to a coherent current authority, not arbitrary
   newest-review selection or currency-only ambiguity.
4. Wire scheduled updates, independent validation and actual monitor admission;
   handle corrections, expiry and restatement without resetting model history.
5. Validate real source-to-homepage normal/funding/stale flows, consent-limited
   AI, accounts and all remaining engineering/production gates.

The fictional parser tests verify their stated format/exactness boundaries only.
Private downloaded issuer responses and personal source bindings remain outside
the public repository. This module does not reduce the full v2 objective to a
parser or change the original research/live-advice distinction.
