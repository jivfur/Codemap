from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
import shutil

from indexer.index import build_or_update_index


SCHEMA_SRC = Path(__file__).resolve().parents[1] / "indexer" / "schema.sql"


class IncrementalIndexTests(unittest.TestCase):
    def test_changed_only_reresolves_importers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            db_path = repo_root / "index.db"

            schema_target = repo_root / "indexer" / "schema.sql"
            schema_target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SCHEMA_SRC, schema_target)

            dep_path = repo_root / "dep.py"
            app_path = repo_root / "app.py"

            dep_path.write_text(
                """
def foo():
    return 1
""".strip()
                + "\n",
                encoding="utf-8",
            )
            app_path.write_text(
                """
from dep import foo


def run():
    return foo()
""".strip()
                + "\n",
                encoding="utf-8",
            )

            first = build_or_update_index(repo_root, db_path, changed_only=False)
            self.assertEqual(first["indexed"], 2)

            conn = sqlite3.connect(str(db_path))
            conn.row_factory = sqlite3.Row
            try:
                run_id = int(
                    conn.execute("SELECT id FROM symbols WHERE qualified_name = 'app.run'").fetchone()["id"]
                )
                first_call = conn.execute(
                    "SELECT resolved, dst_name, dst_id FROM edges WHERE edge_type = 'calls' AND src_id = ?",
                    (run_id,),
                ).fetchone()
                self.assertIsNotNone(first_call)
                self.assertEqual(int(first_call["resolved"]), 1)

                dep_path.write_text(
                    """
def bar():
    return 2
""".strip()
                    + "\n",
                    encoding="utf-8",
                )

                second = build_or_update_index(repo_root, db_path, changed_only=True)
                self.assertEqual(second["indexed"], 2)

                run_id = int(
                    conn.execute("SELECT id FROM symbols WHERE qualified_name = 'app.run'").fetchone()["id"]
                )

                second_call = conn.execute(
                    "SELECT resolved, dst_name, dst_id FROM edges WHERE edge_type = 'calls' AND src_id = ?",
                    (run_id,),
                ).fetchone()
                self.assertIsNotNone(second_call)
                self.assertEqual(int(second_call["resolved"]), 0)
                self.assertEqual(second_call["dst_name"], "foo")
                self.assertIsNone(second_call["dst_id"])
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main()
