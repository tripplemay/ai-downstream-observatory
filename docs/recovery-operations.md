# ETF workbench backup and recovery operations

Status: implemented local tooling; production failover, remote fault-domain separation and the 15-minute RPO / 2-hour RTO have not been validated by these unit tests.

## Commands and configuration

Run from the repository root using the same pinned dependencies and migration files as the application. The scripts do not initialize, migrate or replace the source database.

```sh
node scripts/backup-workbench.mjs
node scripts/restore-workbench.mjs
node --test tests/recovery/*.test.mjs
```

No command-line arguments are accepted, so a secret cannot accidentally be passed in `argv`. Supply exactly one secret source:

- `WORKBENCH_BACKUP_PASSPHRASE_FILE`: absolute path to a regular non-symlink file with no group/other permissions, normally mode `0600`.
- `WORKBENCH_BACKUP_SECRET_STDIN=1`: read one secret from standard input; never use terminal echo or paste it into a recorded command.
- `WORKBENCH_BACKUP_PASSPHRASE`: supported for secret-manager injection, but a protected file/stdin is preferable to an interactive shell environment.

Use a randomly generated secret of at least 32 characters and at most 1,024 UTF-8 bytes. Keep its recovery copy in a different failure domain from the encrypted backups. The script never prints or backs up this secret. Losing the only key makes the archive unrecoverable.

Backup environment:

| Variable | Meaning |
|---|---|
| `WORKBENCH_DB_PATH` | Absolute path to the explicitly migrated workbench database; never the legacy `observatory.db` |
| `WORKBENCH_DATA_DIR` | Absolute source data directory, containing `attachments/` and optionally `auth.sqlite` |
| `WORKBENCH_BACKUP_DIR` | Local archive destination |
| `WORKBENCH_RELEASE_REF` | Explicit application release SHA or clearly labeled test reference |
| `WORKBENCH_BACKUP_REPLICA_DIR` | Optional separate filesystem destination, such as an operator-configured remote mount |

The replica interface copies only an encrypted archive and verifies its SHA-256. It does not install a remote transport, upload by default, store cloud credentials or prove remote placement. A second directory on the same host is **not** an independently verified backup. A configured replica-copy failure is a failed command even when the completed local archive is retained; the error identifies that local artifact.

Restore environment:

| Variable | Meaning |
|---|---|
| `WORKBENCH_RESTORE_ARCHIVE` | Absolute encrypted archive path |
| `WORKBENCH_RESTORE_TARGET_DIR` | A completely new destination directory; any existing target, including a symlink, is refused |
| `WORKBENCH_RECOVERY_INCIDENT_AT` | Optional actual incident UTC timestamp for reporting snapshot age; omit when unknown |

Do not restore over a live data directory. The tool never changes current application environment variables, starts services, switches traffic or enables investment advice.

## Consistent contents

1. Use SQLite Online Backup API to create an isolated, consistent database snapshot while the source remains available. Never copy only an active `.db` file while ignoring its WAL.
2. Read schema checksums, ledger heads, market publication heads and required attachment records **from that snapshot**, not from separate current-state reads.
3. Copy every referenced attachment, checking the database-recorded byte count and SHA-256. Missing, changed, oversized or symlinked originals fail the entire backup. An unimplemented attachment source is not treated as an empty successful attachment set.
4. If `auth.sqlite` exists, snapshot and validate its known schema separately. It is not a financial transaction participant; its sessions will be discarded on recovery.
5. Stream a TAR archive with `manifest.json` first, then the database, optional auth snapshot and controlled relative attachment files. No database or whole attachment set is loaded as base64 in memory.
6. Encrypt, finish authentication, fsync and publish the completed archive. Incomplete working files are private and are removed on normal failure.

The manifest includes the application reference, schema version/checksums, financial ledger heads, market publication heads, snapshot start/completion times, exact file hashes/sizes and source attachment metadata. The source ledger and its legacy predecessor are never modified.

## Encryption and archive limits

Archive version 1 uses standard Node/OpenSSL AES-256-GCM with a fresh 16-byte random salt and 12-byte nonce. A 32-byte key is derived with scrypt (`N=32768`, `r=8`, `p=1`). The fixed version header, salt and nonce are authenticated as AAD; a 16-byte GCM tag closes the archive. The versioned container is `ETFWBK1\n | salt | nonce | ciphertext | tag`. Cryptographic algorithms are standard primitives, not a proprietary cipher.

The stream is capped at 32 GiB, the database at 16 GiB, each attachment at 256 MiB, the manifest at 32 MiB and the file count at 100,000. These are resource-safety limits, not measured capacity claims. Before operation, reserve enough temporary disk for the SQLite snapshot and archive; restoration needs the authenticated TAR plus extracted files. Unlinking temporary files does not promise forensic secure erasure on SSDs.

Recovery decrypts only to a private staging file and verifies the entire GCM tag **before invoking the TAR parser**. Extraction accepts only expected regular files and exact manifest sizes/hashes. Absolute paths, traversal, duplicate names, symlinks, hardlinks, device entries, unexpected files and missing members fail closed. The pinned `tar-stream` library performs streaming TAR decoding; filesystem operations remain controlled by the application whitelist.

## Recovery and session invalidation

Before publishing the new directory, recovery verifies:

- Every file hash/size and the attachment-table-to-manifest mapping.
- Schema migration checksums/version, SQLite `quick_check` and foreign-key integrity.
- Exact snapshot ledger heads and market publication references.
- The auth snapshot schema, if present.

Recovery then creates a fresh empty `auth.sqlite`, writes a new randomly generated session secret into `recovery-session.env` (`0600`), and adds `WORKBENCH_MODE=read_only` there. No old session is retained. Credentials such as the password hash are not embedded in the archive and must be restored from the operator's separate secret-management process.

`RESTORE_PENDING_REVIEW` remains in the restored data directory. The application and worker must honor this marker as a write barrier; removing the marker is a separate manual recovery approval, not part of the script. `recovery-report.json` records verification, elapsed tool time and required follow-up. It intentionally does not claim production readiness.

Before approving the recovered instance:

1. Apply the new session secret using the production secret-injection mechanism, retain the read-only mode and validate login/logout with the new configuration.
2. Check ledger heads, source files, pending imports, account reconciliation and actual broker fills after the snapshot. Preserve the newer damaged source and all confirmable tail facts; never fabricate missing funds from the funding plan.
3. Replay verified tail events into an isolated recovery copy and reconcile. Do not point the old application at new-schema financial facts or overwrite them with the legacy database.
4. Re-run applicable accounting, source-quality, authorization, backup and restoration checks for the exact release.
5. Record operator approval before removing the recovery marker and changing `WORKBENCH_MODE`. Strategy approval and live-advice gates remain separate; software recovery never reverses an external brokerage execution.

## Evidence and remaining operational gates

The tool reports the encrypted artifact SHA-256 and actual snapshot completion time. A replica copy reports `independent_failure_domain_verified=false` until independently evidenced by operations. Recovery optionally reports snapshot age at a supplied incident timestamp; elapsed script time is **not** the full time to restore business service, authenticate users, reconcile tail facts and approve resumption.

Production must separately configure scheduling, alerting, retention, remote transport, key custody, restoration resources and an actual independent-host rehearsal. Measure the latest recoverable verified replica, not just the newest local filename. The accepted 15-minute RPO and 2-hour RTO remain unproven until those end-to-end exercises pass. Synthetic timestamp tests only verify arithmetic and tooling behavior.
