# One steady-state VPS backup

## Policy

Keep at most one verified, encrypted archive in the production backup directory
after a completed archive/rotation operation. During publication, the existing
online/final-before-migration/after-migration recovery points remain mandatory.
Do not delete them just to satisfy a numerical limit while a release is running.
Neither encryption nor the backup format changes in this increment.

Old archives may leave the VPS only after an operator has copied them to a
distinct private host, verified the complete bytes and SHA256, and independently
restored the selected current archive with the separately held key. Preserve
all financial/research records and compatible historical recovery source.
This is data-recovery evidence, not certification of business failover or RPO/RTO.

## Operator tool

`scripts/backup-retention.py` consumes root-owned0600 operator attestations, not
application/API input. The attestation is a trusted operator record of completed
cross-host verification; it is NOT a cryptographic proof of remote custody.
The normal application cannot select a file, assert recovery or authorize deletion.

The closed receipt format identifies the project root, exact current release,
distinct host/private directory, exact one retained archive, all file byte/hash
receipts, and the matching current off-host restoration result. Keep this private.
No credential, original price payload or personal financial row is included.

Default behavior only computes a plan. Execution requires root, the exact plan
hash, an exclusive0600 append-only journal and the normal release lock. Recovery,
changed release/set/content, unknown files, symlinks/hardlinks, unsafe ownership,
missing proof, and any running OR stopped container mount reference block removal.
The selected good backup is revalidated before every deletion; deletion intent
and completion are fsynced separately. A partial failure retains the journal and
remaining files for reconciliation, not an automatic retry or deployment rerun.

```sh
python3 scripts/backup-retention.py --root /opt/observatory --receipts /private/operator/receipts.json
# Review the complete plan first; directories/receipts must satisfy owner/mode checks.
python3 scripts/backup-retention.py --root /opt/observatory --receipts /private/operator/receipts.json \
  --execute --expected-plan-hash <reviewed-plan-sha256> \
  --journal /opt/observatory/backup-retention-evidence/<unique-operation>.jsonl
```

Receipts and resulting lifecycle records must remain separate from immutable
original backup/release reports. Old reports retain their historical meaning,
but the lifecycle journal records which primary copies have been retired and
where their verified encrypted replicas were placed.

## Automation boundary

Run this guarded rotation after a successful private archive/verification cycle.
Do not configure an unconditional timer deleting every file except the newest.
New files without off-host receipts block rotation. If the destination is an
operator workstation which is asleep or disconnected, archival/rotation waits;
temporary excess is reported rather than deleting an unprotected recovery point.
A continuously available destination and explicit transport/scheduling remain
necessary for a fully unattended retention SLA. This helper alone is not that SLA.

The tool does not touch live databases, attachments, restores, Docker resources,
passwords, investor profiles, research windows or strategy/approval gates. Routine
restore-payload retirement and compressed/incremental archive formats are separate
changes, not silently bundled into this single-archive rule.
