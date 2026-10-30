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

## Fixed transport and isolated capture

`vanguard_transport.py` permits only the fixed issuer HTTPS host, a four-digit
fund ID and a boolean query flag. It checks all resolved addresses before
connecting to a numeric public address, verifies TLS host/certificate normally,
and rejects redirects, ambiguous framing, compression, unexpected MIME/charset,
empty/truncated/oversize bodies and elapsed body reads. It neither accepts
arbitrary URLs/headers/credentials nor follows redirects or retries a request.
Only bounded non-sensitive response metadata is retained with exact body hashes.

The low-level socket timeout alone does not bound DNS/header parsing.
`collect_vanguard_distribution_draft` in `vanguard_capture.py` therefore runs
the whole network operation under the existing kernel/parent process deadline.
Its private temporary HOME and explicit environment exclude credentials/proxies;
the child accepts only a closed request. The parent independently checks returned
request identity, fixed URL, clock interval, headers, bytes, base64 framing and
SHA-256 before replaying the body parser. A timeout/error is terminal for that
call, not an automatic resend. Temporary transport state is removed on failure.
Closed child exit categories preserve routing, forbidden/rate-limit and other
transport failures without exporting raw exception text or response bodies.

The result is an in-memory raw body, receipt and draft. No workspace database,
source review, queue, schedule, actual finance or AI gateway is modified. The
receipt is collector evidence, not an exchange signature or permission grant.

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

1. Persist the bounded capture/raw receipt under an explicit approved fund
   identity, currency, amount basis and usage authority, with owner/lease scope.
2. Establish current distribution and split coverage with declared assumptions;
   payload count and optional provider descriptions are not completeness proof.
3. Publish reviewed current-source snapshots without replacing frozen research
   inputs. Bind FX selection to a coherent current authority, not arbitrary
   newest-review selection or currency-only ambiguity.
   The bounded first-input selection increment is documented in
   [current FX review selection](64-current-fx-source-selection.md); it is not
   yet a scheduled source producer or continuous-feed authority registry.
4. Wire scheduled updates, independent validation and actual monitor admission;
   handle corrections, expiry and restatement without resetting model history.
5. Validate real source-to-homepage normal/funding/stale flows, consent-limited
   AI, accounts and all remaining engineering/production gates.

The fictional parser tests verify their stated format/exactness boundaries only.
Private downloaded issuer responses and personal source bindings remain outside
the public repository. This module does not reduce the full v2 objective to a
parser or change the original research/live-advice distinction.
