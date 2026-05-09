import tempfile
import unittest
from pathlib import Path

from codex_relay.sessions import SessionStore, extract_session_id, migrate_session_store


class SessionTests(unittest.TestCase):
    def test_extract_session_id_from_json_line(self):
        stdout = '{"session_id":"12345678-1234-1234-1234-123456789abc"}'
        self.assertEqual(extract_session_id(stdout), "12345678-1234-1234-1234-123456789abc")

    def test_session_store_alias_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sessions.json"
            store = SessionStore(path)
            store.set_alias("main", "12345678-1234-1234-1234-123456789abc", "/repo")

            record = store.get_alias("main")

            self.assertIsNotNone(record)
            self.assertEqual(record.alias, "main")
            self.assertEqual(record.session_ref, "12345678-1234-1234-1234-123456789abc")
            self.assertEqual(record.cwd, "/repo")
            self.assertEqual(store.resolve_alias("main"), "12345678-1234-1234-1234-123456789abc")

    def test_migrates_old_alias_store(self):
        migrated = migrate_session_store({"main": {"session_id": "12345678-1234-1234-1234-123456789abc", "cwd": "/repo"}})

        self.assertEqual(migrated["aliases"]["main"]["session_ref"], "12345678-1234-1234-1234-123456789abc")

    def test_migrates_relay_uuid_store_to_aliases(self):
        migrated = migrate_session_store(
            {
                "sessions": {
                    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa": {
                        "session_id": "12345678-1234-1234-1234-123456789abc",
                        "cwd": "/repo",
                        "alias": "main",
                    }
                },
                "aliases": {"main": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"},
            }
        )

        self.assertEqual(migrated["aliases"]["main"]["session_ref"], "12345678-1234-1234-1234-123456789abc")


if __name__ == "__main__":
    unittest.main()

