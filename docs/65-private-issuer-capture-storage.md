# Private issuer capture staging

This is an intermediate source-acquisition layer for [v2](09-product-v2-portfolio-first.md),
not a completed continuous monitor or a new investment strategy. It persists the
bounded [issuer response](63-issuer-distribution-updates.md) without admitting it
as economic evidence. The normal investor journey must not require editing JSON;
the commands below are an advanced private operator interface.

## Permission, identity and financial review are separate

An immutable owner declaration binds the fixed provider, requested four-digit
fund ID, boolean query option, four private uses, retention days, validity interval
and private clause references. Its basis is explicitly
`owner_declared_private_use_not_provider_certified`. It is not a supplier licence
certificate, verified listing identity or a claim that the requested fund ID is
the intended ETF. External-AI use cannot be added. No credential is accepted by
this issuer interface.

Registering a declaration creates a **disabled** control. Only an explicit owner
enable creates an active version. Disable/re-enable appends controls, never edits
the old declaration, resurrects an old capture or extends its retention. Captures
bind their exact enabled control and permission hash. Independent workspaces have
independent permission, request, payload and purge scope.

## Single attempts, durable uncertainty, no automatic resend

Before I/O, the application atomically commits an immutable request and audit.
A 32-character lowercase hexadecimal request key binds the exact owner, authority
and date window. Reuse inspects the same state without invoking transport. Reuse
with different intent fails. A separate unique constraint limits each workspace
and fund to one started attempt per New York calendar day, even with a different
authority or query flag. Different funds have separate daily limits.

No database write lock is held across the isolated, fixed-host, maximum-30-second
capture. The receiver's byte/receipt verifier and exact Decimal parser are replayed
independently before committing. The application rechecks owner permission,
enabled control, expiry, stop, read-only and restore gates after I/O and within
the final write transaction. Withdrawal discards returned bytes; closed failure
categories never store raw exceptions or response bodies from failed calls.

If the process crashes, or stop/recovery prevents the result transaction, the
durable request is `indeterminate`. This means **unknown**, not success or proven
failure. Inspection and repeating its key never retry the HTTP operation. A new
day permits a new explicit attempt, not replay of the uncertain one. This layer
does not itself create recurring jobs, acquire a worker lease or authorize a
scheduled producer; that integration remains open.

## Space and retention

Migration 47 adds six tables: authority, append-only control, durable request,
terminal capture, raw payload and purge receipt. Terminal metadata is immutable.
Each successful capture stores its request/transport/parser hashes and receipt;
unchanged exact response bytes occupy only **one BLOB per workspace and SHA-256**,
not one full response per daily receipt. No duplicate normalized record archive
or filesystem copy is created. SHA/length, transport binding and parser digest
are revalidated on internal read. Synthetic test captures are rejected by default.

Payload validity is the earlier of permission expiry and capture time plus the
declared retention days. Disabled/superseded controls make old captures unreadable.
The core worker's existing shared, bounded retention pass can audit eligible
purges without source/AI requests, financial writes or monitor publication. A
shared BLOB is deleted only after every capture referencing it has a verified
purge receipt. A later identical response cannot revive an old purged capture.

This is logical database deletion, not SQLite-page/WAL/media erasure or proof
that existing encrypted archives were erased. The CLI therefore returns
`backup_purge_verified: false`. Existing single-local-backup policy and encrypted
custody are unchanged; collection never creates a backup, replica or restore
directory. Immutable metadata still grows over time; daily ceilings and dedup
are not a ten-year capacity benchmark.

## Advanced private operator sequence

Use an existing owner-only database and a private authority JSON file **outside
the checkout**. The file and its parent must be owner-only; symlinks, hardlinks,
duplicate JSON keys, non-finite numbers and oversized documents are rejected.
All examples use placeholders, not real permissions or fund mappings.

```sh
python -m worker.investor.data_pipeline --db /private/workbench.db --workspace WORKSPACE --actor OWNER register-issuer-authority --file /private/issuer-authority.json
python -m worker.investor.data_pipeline --db /private/workbench.db --workspace WORKSPACE --actor OWNER control-issuer-authority --authority AUTHORITY --enable
python -m worker.investor.data_pipeline --db /private/workbench.db --workspace WORKSPACE --actor OWNER collect-issuer-draft --authority AUTHORITY --request-key REQUEST_KEY --start YYYY-MM-DD --end YYYY-MM-DD
python -m worker.investor.data_pipeline --db /private/workbench.db --workspace WORKSPACE --actor OWNER inspect-issuer-request --request-key REQUEST_KEY
python -m worker.investor.data_pipeline --db /private/workbench.db --workspace WORKSPACE --actor OWNER check-issuer-capture --capture CAPTURE
```

`check-issuer-capture` emits only IDs, hashes, byte/record counts, retention and
closed gap codes, not raw responses, distribution values or private clauses.
Disable uses `control-issuer-authority --authority AUTHORITY --disable`;
`purge-issuer-capture --capture CAPTURE` only works when due. No command exposes
URL, caller clock, synthetic collector, raw-output or credential overrides.

## Not yet financial or production acceptance

Every draft and capture retains `owner_reviewed: false`,
`research_admitted: false`, `corporate_actions_complete: false` and
`live_advice_eligible: false`. Saving it does not edit historical source reviews,
strategy trials, model weights, cash, orders, research inputs or monitor queues.
It is not a portfolio observation checkpoint.

Remaining work includes verified listing/currency/per-unit basis, complete
distributions and splits, long-lived current FX authority, scheduled producer
and lease integration, independent monitor admission and real normal/funding/stale
homepage journeys. Fixtures test storage, retention and an encrypted temporary
roundtrip offline; they do not prove live supplier permission, production source
installation, business recovery RPO/RTO or full-load capacity.
