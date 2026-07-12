from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
import shutil

from indexer.index import build_or_update_index


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_SRC = PROJECT_ROOT / "indexer" / "schema.sql"
FIXTURE_SRC = PROJECT_ROOT / "tests" / "fixtures" / "baseline_repo"


class BaselineFixtureTests(unittest.TestCase):
    def test_fixture_repo_indexes_with_stable_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp) / "fixture_repo"
            shutil.copytree(FIXTURE_SRC, repo_root)

            schema_target = repo_root / "indexer" / "schema.sql"
            schema_target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SCHEMA_SRC, schema_target)

            db_path = repo_root / "index.db"
            stats = build_or_update_index(repo_root, db_path, changed_only=False)
            self.assertEqual(stats, {"indexed": 2, "skipped": 0, "total": 2})

            conn = sqlite3.connect(str(db_path))
            conn.row_factory = sqlite3.Row
            try:
                file_count = int(conn.execute("SELECT COUNT(*) AS c FROM files").fetchone()["c"])
                symbol_count = int(conn.execute("SELECT COUNT(*) AS c FROM symbols").fetchone()["c"])
                defines_count = int(
                    conn.execute("SELECT COUNT(*) AS c FROM edges WHERE edge_type = 'defines'").fetchone()["c"]
                )
                imports_count = int(
                    conn.execute("SELECT COUNT(*) AS c FROM edges WHERE edge_type = 'imports'").fetchone()["c"]
                )
                calls_count = int(
                    conn.execute("SELECT COUNT(*) AS c FROM edges WHERE edge_type = 'calls'").fetchone()["c"]
                )
                inherits_count = int(
                    conn.execute("SELECT COUNT(*) AS c FROM edges WHERE edge_type = 'inherits'").fetchone()["c"]
                )

                self.assertEqual(file_count, 2)
                self.assertEqual(symbol_count, 4)
                self.assertEqual(defines_count, 4)
                self.assertEqual(imports_count, 1)
                self.assertEqual(calls_count, 1)
                self.assertEqual(inherits_count, 1)
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main()
