from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
import shutil

from indexer.index import build_or_update_index


SCHEMA_SRC = Path(__file__).resolve().parents[1] / "indexer" / "schema.sql"


class InheritsIndexTests(unittest.TestCase):
    def test_index_persists_inherits_edges(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            db_path = repo_root / "index.db"

            schema_target = repo_root / "indexer" / "schema.sql"
            schema_target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SCHEMA_SRC, schema_target)

            source = repo_root / "model.py"
            source.write_text(
                """
class Base:
    pass

class Child(Base):
    pass
""".strip()
                + "\n",
                encoding="utf-8",
            )

            stats = build_or_update_index(repo_root, db_path, changed_only=False)
            self.assertEqual(stats["indexed"], 1)

            conn = sqlite3.connect(str(db_path))
            conn.row_factory = sqlite3.Row
            try:
                child_id = int(
                    conn.execute("SELECT id FROM symbols WHERE qualified_name = 'model.Child'").fetchone()["id"]
                )
                base_id = int(
                    conn.execute("SELECT id FROM symbols WHERE qualified_name = 'model.Base'").fetchone()["id"]
                )

                edge = conn.execute(
                    """
                    SELECT resolved, dst_id, dst_name
                    FROM edges
                    WHERE edge_type = 'inherits'
                      AND src_type = 'symbol'
                      AND src_id = ?
                    """,
                    (child_id,),
                ).fetchone()
                self.assertIsNotNone(edge)
                self.assertEqual(int(edge["resolved"]), 1)
                self.assertEqual(int(edge["dst_id"]), base_id)
                self.assertEqual(edge["dst_name"], "Base")
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main()
