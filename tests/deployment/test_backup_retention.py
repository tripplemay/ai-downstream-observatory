"""Synthetic filesystem/operator attestations; not off-host recovery certification."""
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'scripts/backup-retention.py'
spec = importlib.util.spec_from_file_location('backup_retention', SOURCE)
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)


class BackupRetentionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='etf-retention-synthetic-')
        self.root = Path(self.temporary.name).resolve()
        self.owner = patch.object(retention, 'WORKBENCH_UID', os.geteuid())
        self.owner.start()
        self.addCleanup(self.owner.stop)
        self.addCleanup(self.temporary.cleanup)
        self.release = '7' * 40
        for name in ['backups-workbench', 'data-workbench', 'backup-retention-evidence', 'releases/' + self.release]:
            (self.root / name).mkdir(parents=True, mode=0o700)
        (self.root / 'releases' / self.release / '.release-sha').write_text(self.release)
        (self.root / 'current').symlink_to(self.root / 'releases' / self.release)
        (self.root / '.release.lock').touch(mode=0o600)
        (self.root / 'data-workbench/etf-workbench.db').write_bytes(b'protected synthetic database')
        self.files = []
        for index in range(3):
            name = f'workbench-0000000{index}-0000-0000-0000-000000000000.etfbackup'
            data = ('invented ciphertext ' + str(index)).encode()
            path = self.root / 'backups-workbench' / name
            path.write_bytes(data); path.chmod(0o600)
            self.files.append({'name': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        keep = self.files[-1]
        self.receipts = {'format': 'etf-offhost-backup-receipts-v1', 'primary_root': str(self.root),
            'source_release': self.release, 'offhost_host': 'synthetic-independent-host',
            'offhost_directory': '/private/synthetic-only', 'verified_at': '2026-01-01T00:00:00Z',
            'keep_archive': keep['name'], 'files': self.files,
            'restore_verification': {'archive': keep['name'], 'sha256': keep['sha256'],
                'source_release': self.release, 'schema_version': 46, 'status': 'verified',
                'network_disabled': True, 'financial_and_research_match': True}}
        self.journal = self.root / 'backup-retention-evidence/test.jsonl'

    def plan(self):
        return retention.plan_retention(self.root, self.receipts)

    def assert_blocked(self, mutate):
        mutate()
        with self.assertRaises((ValueError, OSError)):
            self.plan()
        self.assertFalse(self.journal.exists())

    def test_dry_run_is_zero_write_and_complete_execution_keeps_exactly_one(self):
        before = (self.root / 'data-workbench/etf-workbench.db').read_bytes()
        plan = self.plan()
        self.assertEqual(len(list((self.root / 'backups-workbench').iterdir())), 3)
        self.assertFalse(self.journal.exists())
        result = retention.execute_retention(self.root, self.receipts, plan['plan_hash'], self.journal, mounts=lambda: [])
        self.assertEqual(result['removed_count'], 2)
        self.assertEqual([p.name for p in (self.root / 'backups-workbench').iterdir()], [self.files[-1]['name']])
        self.assertEqual((self.root / 'data-workbench/etf-workbench.db').read_bytes(), before)
        events = [json.loads(line) for line in self.journal.read_text().splitlines()]
        self.assertEqual(events[-1]['event'], 'complete')
        self.assertEqual(sum(row['event'] == 'remove_intent' for row in events), 2)
        self.assertEqual(self.journal.stat().st_mode & 0o077, 0)

    def test_unarchived_new_file_blocks_all_deletions(self):
        self.assert_blocked(lambda: (self.root / 'backups-workbench/new-unclassified.tmp').write_bytes(b'new'))

    def test_changed_bytes_and_same_size_forged_archive_fail_closed(self):
        path = self.root / 'backups-workbench' / self.files[0]['name']
        self.assert_blocked(lambda: path.write_bytes(b'x' * path.stat().st_size))

    def test_symlinked_and_hardlinked_archives_are_rejected(self):
        path = self.root / 'backups-workbench' / self.files[0]['name']
        path.unlink(); path.symlink_to(self.root / 'data-workbench/etf-workbench.db')
        with self.assertRaises((ValueError, OSError)): self.plan()
        path.unlink(); os.link(self.root / 'backups-workbench' / self.files[1]['name'], path)
        with self.assertRaises(ValueError): self.plan()

    def test_recovery_barrier_and_wrong_current_release_block(self):
        marker = self.root / 'data-workbench/RESTORE_PENDING_REVIEW'
        marker.write_text('synthetic recovery')
        with self.assertRaises(ValueError): self.plan()
        marker.unlink()
        (self.root / 'releases' / self.release / '.release-sha').write_text('8' * 40)
        with self.assertRaises(ValueError): self.plan()

    def test_missing_restore_proof_or_false_qualification_is_rejected(self):
        for field in ['network_disabled', 'financial_and_research_match', 'source_release', 'sha256']:
            receipt = copy.deepcopy(self.receipts)
            receipt['restore_verification'][field] = False
            with self.subTest(field=field), self.assertRaises(ValueError):
                retention.plan_retention(self.root, receipt)

    def test_manifest_cannot_name_outside_files_or_duplicate_entries(self):
        for name in ['../etf-workbench.db', '/etc/passwd', 'workbench-bad.etfbackup']:
            receipt = copy.deepcopy(self.receipts); receipt['files'][0]['name'] = name
            with self.assertRaises(ValueError): retention.plan_retention(self.root, receipt)
        receipt = copy.deepcopy(self.receipts); receipt['files'].append(receipt['files'][0])
        with self.assertRaises(ValueError): retention.plan_retention(self.root, receipt)

    def test_stale_dry_run_hash_cannot_execute(self):
        with self.assertRaises(ValueError):
            retention.execute_retention(self.root, self.receipts, '0' * 64, self.journal, mounts=lambda: [])
        self.assertEqual(len(list((self.root / 'backups-workbench').iterdir())), 3)

    def test_running_or_stopped_mount_reference_and_parent_mount_block(self):
        plan = self.plan()
        for path in [self.root, self.root / 'backups-workbench', self.root / 'backups-workbench' / self.files[0]['name']]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                retention.execute_retention(self.root, self.receipts, plan['plan_hash'], self.journal,
                    mounts=lambda: [{'Source': str(path)}])
        self.assertFalse(self.journal.exists())

    def test_concurrent_release_lock_and_symlink_lock_block(self):
        plan = self.plan()
        with (self.root / '.release.lock').open('r') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(ValueError):
                retention.execute_retention(self.root, self.receipts, plan['plan_hash'], self.journal, mounts=lambda: [])
        (self.root / '.release.lock').unlink()
        (self.root / '.release.lock').symlink_to(self.root / 'data-workbench/etf-workbench.db')
        with self.assertRaises(ValueError):
            retention.execute_retention(self.root, self.receipts, plan['plan_hash'], self.journal, mounts=lambda: [])

    def test_partial_io_failure_is_journalled_and_keeps_verified_backup(self):
        plan = self.plan(); original = Path.unlink; calls = 0
        def fail_second(path, *args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2: raise OSError('synthetic IO failure')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'unlink', fail_second), self.assertRaises(OSError):
            retention.execute_retention(self.root, self.receipts, plan['plan_hash'], self.journal, mounts=lambda: [])
        self.assertTrue((self.root / 'backups-workbench' / self.files[-1]['name']).is_file())
        events = [json.loads(line) for line in self.journal.read_text().splitlines()]
        self.assertNotEqual(events[-1]['event'], 'complete')
        self.assertEqual(sum(row['event'] == 'removed_primary_copy' for row in events), 1)

    def test_duplicate_json_and_insecure_operator_receipts_are_rejected(self):
        path = self.root / 'operator.json'; path.write_text('{"a":1,"a":2}'); path.chmod(0o600)
        with self.assertRaises(ValueError): retention.read_manifest(path)
        path.write_text(json.dumps(self.receipts)); path.chmod(0o644)
        with self.assertRaises(ValueError): retention.read_manifest(path)


if __name__ == '__main__': unittest.main()
