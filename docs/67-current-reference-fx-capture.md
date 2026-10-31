# Current reference-FX capture

`worker/market/providers/ecb_current.py` adds a bounded current-FX receiver for
the fixed ECB 90-day XML feed. It returns original response bytes, a checked
transport receipt and an **unapproved** review draft. It does not access the
workbench database, account, credentials, AI gateway or trading interfaces.

## Source and meaning

The [ECB reference-rate page](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)
publishes dated reference rates and links its daily and historical XML feeds.
These are informational reference rates, not executable currency quotes. The
[ECB disclaimer](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html)
describes reuse conditions; downstream use must retain attribution and identify
cross-conversion rather than implying ECB supplies a direct executable CNY pair.
This engineering source description is not certification of a user's license.

The receiver supports the existing USD/HKD research currency legs. It preserves
the original XML hash and both EUR-leg arithmetic through the existing parser;
CNY-per-unit conversion uses exact rational arithmetic and half-even rounding at
18 decimal places. Missing dates or legs are never filled. The 90-day feed is
not relabelled as the full-history feed or a point-in-time archive.

Observation timestamps retain the historical reconstruction convention: local
midnight in Europe/Berlin is a **date anchor**, not a quote or publication time.
Assumed availability is the following calendar day's local midnight, with DST
handled by calendar dates rather than adding 24 hours. An intraday download can
therefore contain a record whose conservative availability is still pending.
The draft keeps that record, marks the entire draft pending and exposes
`not_before`; it does not trim or retime it to manufacture eligibility.

Availability is not freshness. Even an available draft remains
`freshness_status=not_assessed`, `owner_reviewed=false` and
`production_admitted=false`. The saved plan's frozen age ceiling must be checked
separately. Neither capture nor retrieval extends it.

## Process and transport boundary

- Only the fixed 90-day ECB HTTPS URL is reachable through this receiver. No
  caller-supplied URL, endpoint, headers, job clock, authority or age override.
- A private temporary HOME and a closed environment prevent inherited broker
  credentials, proxy settings and database paths. The child receives only its
  bounded timeout, never the requested portfolio or account.
- The existing verified-TLS/public-address transport rejects redirects,
  ambiguous framing, wrong MIME/encoding, oversized and incomplete responses.
  A parent deadline and kernel timer additionally bound DNS, headers and child
  shutdown. The receiver makes one HTTP invocation and has no application retry.
- The parent independently validates the closed receipt, fixed source URL,
  collection clocks, size, base64 and raw SHA-256, then reparses the XML. Only
  closed error categories cross the child boundary, not provider diagnostics.

## Integration status

The later [standing-rule feed](68-managed-reference-fx-feed.md) adds the separate
durable producer/head integration described as outstanding below. This receiver's
pure return value remains unapproved; it does not itself acquire that authority.

The pure draft deliberately does not invent `monitor_series`. Explicit owner
authority, supplier-use/retention binding, source review and overlap checks are
still required before using it in the [current-FX selector](64-current-fx-source-selection.md).
The separate [monitor refresh](66-current-fx-monitor-refresh.md) can consume an
eligible reviewed source; a successful network capture alone cannot activate it.

A scheduled producer still needs a durable pre-I/O claim, controls/lease, a
long-lived authority/head and bounded retention. This receiver is **not** wired
into default background collection and is not a replacement for that work.
Do not call it from an unbounded scheduler or replay an uncertain request.
No new migration, source review, study, model save, financial fact or backup is
created by this increment. Complete corporate actions and independent real
source-to-homepage normal/funding/stale acceptance remain separate release work.

Tests use fictional XML, transport doubles and actual network-free child
processes, including a stuck-child kernel deadline. Private live evidence, when
collected, is kept outside the public source/test corpus and is not described as
investment or full-product acceptance.
