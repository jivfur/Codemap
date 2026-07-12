from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path

from indexer.graph_queries import get_impact, get_neighbors, get_path


SCHEMA_PATH = Path(__file__).resolve().parents[1] / "indexer" / "schema.sql"


class GraphQueryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))

        file_id = self.conn.execute(
            "INSERT INTO files(path, language, content_hash, loc) VALUES (?, ?, ?, ?)",
            ("pkg/mod.py", "python", "hash", 100),
        ).lastrowid

        self.a_id = self._add_symbol(file_id, "a", "pkg.mod.a")
        self.b_id = self._add_symbol(file_id, "b", "pkg.mod.b")
        self.c_id = self._add_symbol(file_id, "c", "pkg.mod.c")
        self.d_id = self._add_symbol(file_id, "d", "pkg.mod.d")

        self._add_call(self.b_id, self.a_id, None, 1)
        self._add_call(self.c_id, self.b_id, None, 1)
        self._add_call(self.a_id, self.b_id, None, 1)
        self._add_call(self.a_id, None, "unknown_call", 0)
        self._add_call(self.d_id, None, "a", 0)

        self.conn.commit()

    def tearDown(self) -> None:
        self.conn.close()

    def _add_symbol(self, file_id: int, name: str, qualified_name: str) -> int:
        return int(
            self.conn.execute(
                """
                INSERT INTO symbols(file_id, kind, name, qualified_name, signature, doc_summary, start_line, end_line)
                VALUES (?, 'function', ?, ?, ?, NULL, 1, 2)
                """,
                (file_id, name, qualified_name, f"{name}()"),
            ).lastrowid
        )

    def _add_call(self, src_id: int, dst_id: int | None, dst_name: str | None, resolved: int) -> None:
        self.conn.execute(
            """
            INSERT INTO edges(src_id, src_type, dst_id, dst_type, dst_name, edge_type, resolved)
            VALUES (?, 'symbol', ?, 'symbol', ?, 'calls', ?)
            """,
            (src_id, dst_id, dst_name, resolved),
        )

    def test_neighbors_returns_callers_and_callees(self) -> None:
        result = get_neighbors(self.conn, "pkg.mod.a")
        self.assertIsNotNone(result)

        callers = result["callers"]
        callees = result["callees"]

        self.assertEqual(
            callers,
            [
                {"symbol": "pkg.mod.b", "resolved": 1},
                {"symbol": "pkg.mod.d", "resolved": 0},
            ],
        )
        self.assertEqual(
            callees,
            [
                {"symbol": "pkg.mod.b", "resolved": 1},
                {"symbol": "unknown_call", "resolved": 0},
            ],
        )

    def test_impact_returns_reverse_closure(self) -> None:
        result = get_impact(self.conn, "pkg.mod.a")
        self.assertIsNotNone(result)

        self.assertEqual(
            result["impacted"],
            [
                {"symbol": "pkg.mod.b", "depth": 1, "resolved": 1},
                {"symbol": "pkg.mod.d", "depth": 1, "resolved": 0},
                {"symbol": "pkg.mod.c", "depth": 2, "resolved": 1},
            ],
        )

    def test_path_returns_shortest_route(self) -> None:
        result = get_path(self.conn, "pkg.mod.c", "pkg.mod.a")
        self.assertIsNotNone(result)
        self.assertEqual(result["path"], ["pkg.mod.c", "pkg.mod.b", "pkg.mod.a"])

    def test_path_returns_empty_when_unreachable(self) -> None:
        result = get_path(self.conn, "pkg.mod.a", "pkg.mod.d")
        self.assertIsNotNone(result)
        self.assertEqual(result["path"], [])


if __name__ == "__main__":
    unittest.main()
