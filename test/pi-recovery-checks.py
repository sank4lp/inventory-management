import importlib.util
import io
import json
import os
import pathlib
import shutil
import sqlite3
import sys
import tarfile
import tempfile
import unittest

fixture = pathlib.Path(sys.argv.pop(1))
spec = importlib.util.spec_from_file_location('portable', pathlib.Path(__file__).parents[1] / 'scripts/release/portable-backup.py')
portable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portable)


class RecoveryChecks(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.folder.name)
        self.data = self.root / 'data'
        self.data.mkdir()
        shutil.copyfile(fixture, self.data / 'inventory.db')
        (self.data / 'archives').mkdir()
        (self.data / 'archives/business-history-old.json').write_text('{"tasks":[1,2]}')
        self.backup = self.root / 'warehouse.lytbackup'

    def tearDown(self):
        self.folder.cleanup()

    def build(self):
        return portable.create(self.data, self.backup, '0.1.0~test.1')

    def altered(self, change):
        with tarfile.open(self.backup, 'r:gz') as source:
            entries = [(item, source.extractfile(item).read()) for item in source]
        change(entries)
        path = self.root / 'altered.lytbackup'
        with tarfile.open(path, 'w:gz') as target:
            for item, contents in entries:
                item.size = len(contents)
                target.addfile(item, io.BytesIO(contents))
        return path

    def test_online_snapshot_keeps_committed_wal_and_all_archived_history(self):
        live = sqlite3.connect(self.data / 'inventory.db')
        live.execute('PRAGMA journal_mode=WAL')
        live.execute("UPDATE products SET description='Committed WAL recovery marker'")
        live.commit()
        try:
            self.assertGreater((self.data / 'inventory.db-wal').stat().st_size, 0)
            manifest = self.build()
            restored = self.root / 'restored'
            self.assertEqual(portable.extract(self.backup, restored), manifest)
            checked = sqlite3.connect(restored / 'inventory.sqlite')
            self.assertEqual(checked.execute('SELECT description FROM products LIMIT 1').fetchone()[0], 'Committed WAL recovery marker')
            checked.close()
            self.assertEqual((restored / 'archives/business-history-old.json').read_text(), '{"tasks":[1,2]}')
            self.assertEqual(self.backup.stat().st_mode & 0o777, 0o600)
        finally:
            live.close()

    def test_modified_payload_is_rejected_without_leaving_extracted_data(self):
        self.build()
        def damage(entries):
            index = next(i for i, (item, _) in enumerate(entries) if item.name == 'inventory.sqlite')
            item, contents = entries[index]
            entries[index] = (item, contents[:-1] + bytes([contents[-1] ^ 1]))
        path = self.altered(damage)
        with self.assertRaisesRegex(ValueError, 'checksum'):
            portable.extract(path, self.root / 'bad')
        self.assertFalse((self.root / 'bad').exists())

    def test_tar_traversal_links_and_duplicates_are_never_extracted(self):
        self.build()
        for kind in ('traversal', 'link', 'duplicate'):
            with self.subTest(kind=kind):
                def damage(entries):
                    if kind == 'duplicate':
                        entries.append(entries[-1])
                    else:
                        item = tarfile.TarInfo('../escaped' if kind == 'traversal' else 'inventory.sqlite')
                        if kind == 'link':
                            item.type, item.linkname = tarfile.SYMTYPE, '/etc/passwd'
                        entries.append((item, b''))
                path = self.altered(damage)
                with self.assertRaises(ValueError):
                    portable.extract(path, self.root / 'bad')
                self.assertFalse((self.root / 'escaped').exists())

    def test_truncated_snapshot_and_wrong_database_summary_are_rejected(self):
        self.build()
        truncated = self.root / 'truncated.lytbackup'
        contents = self.backup.read_bytes()
        truncated.write_bytes(contents[:len(contents)//2])
        with self.assertRaises(Exception):
            portable.extract(truncated, self.root / 'bad')
        def damage(entries):
            item, contents = entries[0]
            manifest = json.loads(contents)
            manifest['counts']['products'] += 1
            entries[0] = (item, json.dumps(manifest).encode())
        with self.assertRaisesRegex(ValueError, 'summary'):
            portable.extract(self.altered(damage), self.root / 'bad')

    def test_manifest_cannot_expand_beyond_the_checked_limits(self):
        self.build()
        def damage(entries):
            item, contents = entries[0]
            manifest = json.loads(contents)
            manifest['files'][0]['bytes'] = portable.MAX_EXPANDED + 1
            entries[0] = (item, json.dumps(manifest).encode())
        with self.assertRaises(ValueError):
            portable.extract(self.altered(damage), self.root / 'bad')

    def test_card_rotation_keeps_two_backups_and_unrelated_boot_files(self):
        self.build()
        card = self.root / 'card'
        card.mkdir()
        (card / 'config.txt').write_text('do not change')
        copies = []
        for i in range(4):
            result = portable.publish(self.backup, card)
            copies.append(card / result['filename'])
            os.utime(copies[-1], ns=(10**15 + i, 10**15 + i))
        self.assertFalse(copies[0].exists())
        self.assertFalse(copies[1].exists())
        self.assertTrue(copies[2].exists())
        self.assertTrue(copies[3].exists())
        self.assertEqual((card / 'config.txt').read_text(), 'do not change')
        portable.extract(copies[3], self.root / 'restored')

    def test_low_space_and_oversize_leave_last_good_copy_untouched(self):
        self.build()
        card = self.root / 'card'
        card.mkdir()
        previous = card / portable.publish(self.backup, card)['filename']
        digest = portable.checksum(previous)
        for options in ({'min_free': shutil.disk_usage(card).total + 1}, {'max_file': 1}):
            with self.assertRaises(ValueError):
                portable.publish(self.backup, card, **options)
            self.assertEqual(portable.checksum(previous), digest)
            self.assertEqual(len(list(card.glob('*.lytbackup'))), 1)
            self.assertEqual(len(list(card.glob('*.writing'))), 0)

    def test_no_existing_export_or_symlinked_archive_is_overwritten(self):
        self.build()
        digest = portable.checksum(self.backup)
        with self.assertRaises(ValueError):
            self.build()
        self.assertEqual(portable.checksum(self.backup), digest)
        (self.data / 'archives/link.json').symlink_to(self.root / 'outside')
        with self.assertRaises(ValueError):
            portable.create(self.data, self.root / 'other.lytbackup', '1.0')


if __name__ == '__main__':
    unittest.main(verbosity=2)
