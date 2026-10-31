# Standing-rule reference-FX feed

This increment connects the [bounded ECB receiver](67-current-reference-fx-capture.md)
to the ordinary market-provider/core roles. It does not enable any real source by
default, save another model, revise investment parameters or authorize trades.
Migration 48 adds seven append-only/receipt-bound FX tables; it does not rewrite
existing research, financial facts, model definitions or source reviews.

## Explicit standing authority

An owner must explicitly register and enable a private standing declaration under
`investor-managed-fx.schema.json`. It includes currencies, validity, retention and
clause references, with no inferred supplier permission. Only USD/HKD reference
conversion from the fixed ECB 90-day feed and the four private uses are supported.
External-AI raw-data use, trading authority and arbitrary URLs are not accepted.

Registration is disabled by default. Only one unexpired authority may be enabled
per workspace. The declaration approves a **standing derivation/use rule**, not
every downloaded rate and not a provider certification. Each automatic source
publication explicitly records `human_review_performed=false`; capture receipts
remain `owner_reviewed=false` and `production_admitted=false`. Ordinary downstream
source/identity/calendar/actions/age/cost gates still apply.

Private operator commands in `worker.investor.data_pipeline` are:

- `register-fx-authority --file <private-policy.json>`
- `control-fx-authority --authority <id> --enable` (or `--disable`)
- `inspect-fx-request --feed-day <YYYY-MM-DD>`
- `check-fx-capture --capture <id>` and `check-fx-head --authority <id>`
- `purge-fx-capture --capture <id>` only after expiry/control invalidation

They require the existing explicit private database/workspace/actor scope and
private-file protections. Inspection prints hashes/status, not rate arrays or
credentials. There is no manual-fetch, retry, clock, endpoint or test override.

## Durable single attempt and separate publication

The market-provider role persists a request before I/O, at most once per workspace
and Europe/Berlin calendar day after 01:00. A new authority cannot reset that day.
Jobs have one attempt and a lease/fencing token; uncertain/crashed attempts are
not automatically replayed. Requests expire at the next local midnight or the
authority's expiry, whichever comes first. DST is handled by calendar dates.
Imminent confirmed-close watches reserve the provider queue ahead of FX work.

No database transaction is held during the isolated HTTPS call. Stop, read-only,
restore, current control and lease gates are checked before I/O and again before
commit. The parent replays the transport receipt and original XML. A successful
capture is still not a source publication. Core publishes only after the original
conservative `not_before`, without changing dates or the frozen FX-age ceiling.

Each published source has the authority ID as its explicit append-only series.
New heads require exact overlapping amounts and availability times, no tail
regression and an advancing tail. A repeated tail records `unchanged`, without
creating a new source review or extending freshness. Missing overlap or a
restatement quarantines the series, including its previous head. Quarantine
cannot automatically clear or be bypassed by re-enabling the same declaration.
Explicit withdrawal/expiry/corruption of the head stops future network requests;
core reports a bounded gap instead of silently reapproving the source.

New source selection sees only the accepted head, not every daily review. Exact
older bound references remain usable only while their original permission,
control, retention and bytes remain valid. New heads do not rewrite old inputs.
Malformed captures are isolated and reported once, not retried on each core tick.

## Independent reading and storage boundaries

Python and Node independently verify owner/audit/authority/control, request/job/
attempt/fence, capture/hash/transport and the original XML. Node uses bounded
namespace-aware XML parsing and exact BigInt rational half-even conversion, not
the Python draft as its oracle. It rebuilds the entire draft, source metadata and
FX facts before trusting the standing publication. Legacy manual sources keep
their existing qualification and validation.

Raw XML is deduplicated by workspace and SHA-256. Core shares the existing bounded
retention budget and deletes a raw BLOB only after every referencing capture is
purged. Immutable receipts, audit history and derived rate facts remain. This is
**logical payload cleanup, not full rate erasure**, SQLite media sanitization or
backup deletion. Existing one-local-backup custody and historical keys are not
changed. Long-term database growth and checkpoint capacity require their own
measurement; a bounded multi-month test is not a ten-year capacity result.

## Acceptance boundaries

Fictional tests cover ordinary leased roles, disabled/stop/restore controls,
single attempts, concurrent connections, DST, pending availability, immutable
heads, unchanged/deduplicated data, quarantine and expiry/withdrawal. A saved US
model journey covers both supported model versions, default bootstrap, later FX
and confirmed-close updates, independent Node/client projection, stale state and
withdrawal, with no financial facts or external provider/AI calls.

The bootstrap deliberately retains **unknown costs**. When the fictional model
drifts, it remains blocked with `CANNOT_COMPARE_CHANGE_COST` and no checkpoint.
The positive continuation separately admits explicit invented owner cost
assumptions. It does not treat historical study fees as a verified broker tariff
or install those fixture assumptions in production.

An offline encrypted temporary-database roundtrip preserves FX bytes/heads and an
unknown job attempt while the restore barrier continues to forbid runtime work.
It is not an independent-machine production recovery drill. Previously retained
real ECB bytes may be independently replayed offline; that is neither another
network capture nor real-source admission. Exact-commit CI, protected deployment,
real authority installation, complete actions, actual ordinary/funding/stale
homepage monitoring and full P0/P1/P2 acceptance remain separate work.
