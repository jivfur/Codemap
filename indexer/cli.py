from __future__ import annotations

import argparse
from pathlib import Path

from .db import connect_db, init_schema
from .graph_queries import get_impact, get_neighbors
from .index import build_or_update_index


def _repo_root() -> Path:
    return Path.cwd()


def _db_path() -> Path:
    return _repo_root() / "index.db"


def cmd_index(args: argparse.Namespace) -> int:
    stats = build_or_update_index(_repo_root(), _db_path(), changed_only=args.changed_only)
    print(f"Indexed: {stats['indexed']} | Skipped: {stats['skipped']} | Total supported: {stats['total']}")
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    conn = connect_db(_db_path())
    try:
        init_schema(conn, _repo_root() / "indexer" / "schema.sql")
        rows = conn.execute(
            """
            SELECT s.kind, s.name, s.qualified_name, s.signature, s.start_line, s.end_line
            FROM symbols s
            JOIN files f ON f.id = s.file_id
            WHERE f.path = ?
            ORDER BY s.start_line
            """,
            (args.file_path,),
        ).fetchall()
        if not rows:
            print("No symbols found for file.")
            return 0
        for row in rows:
            print(
                f"[{row['kind']}] {row['qualified_name']} | {row['signature']} | lines {row['start_line']}-{row['end_line']}"
            )
        return 0
    finally:
        conn.close()


def cmd_search(args: argparse.Namespace) -> int:
    conn = connect_db(_db_path())
    try:
        init_schema(conn, _repo_root() / "indexer" / "schema.sql")
        like = f"%{args.term}%"
        rows = conn.execute(
            """
            SELECT s.kind, s.name, s.qualified_name, s.signature, COALESCE(s.doc_summary, '') AS doc_summary, f.path
            FROM symbols s
            JOIN files f ON f.id = s.file_id
            WHERE s.name LIKE ? OR s.qualified_name LIKE ? OR s.doc_summary LIKE ?
            ORDER BY s.qualified_name
            LIMIT 50
            """,
            (like, like, like),
        ).fetchall()
        if not rows:
            print("No symbol matches.")
            return 0
        for row in rows:
            print(f"[{row['kind']}] {row['qualified_name']} ({row['path']})")
            if row["doc_summary"]:
                print(f"  - {row['doc_summary']}")
        return 0
    finally:
        conn.close()


def cmd_body(args: argparse.Namespace) -> int:
    conn = connect_db(_db_path())
    try:
        init_schema(conn, _repo_root() / "indexer" / "schema.sql")
        row = conn.execute(
            """
            SELECT s.qualified_name, s.start_line, s.end_line, f.path
            FROM symbols s
            JOIN files f ON f.id = s.file_id
            WHERE s.qualified_name = ? OR s.name = ?
            ORDER BY CASE WHEN s.qualified_name = ? THEN 0 ELSE 1 END, s.id
            LIMIT 1
            """,
            (args.symbol, args.symbol, args.symbol),
        ).fetchone()
        if not row:
            print("Symbol not found.")
            return 1

        file_path = _repo_root() / row["path"]
        lines = file_path.read_text(encoding="utf-8", errors="replace").splitlines()
        start = max(1, int(row["start_line"]))
        end = min(len(lines), int(row["end_line"]))
        print(f"# {row['qualified_name']} ({row['path']}:{start}-{end})")
        for i in range(start, end + 1):
            print(f"{i:>4} | {lines[i - 1]}")
        return 0
    finally:
        conn.close()


def cmd_neighbors(args: argparse.Namespace) -> int:
    conn = connect_db(_db_path())
    try:
        init_schema(conn, _repo_root() / "indexer" / "schema.sql")
        result = get_neighbors(conn, args.symbol)
        if not result:
            print("Symbol not found.")
            return 1

        target = result["target"]["qualified_name"]
        print(f"# Neighbors for {target}")
        print("Callers:")
        callers = result["callers"]
        if not callers:
            print("  - (none)")
        for row in callers:
            state = "resolved" if row["resolved"] else "unresolved"
            print(f"  - {row['symbol']} [{state}]")

        print("Callees:")
        callees = result["callees"]
        if not callees:
            print("  - (none)")
        for row in callees:
            state = "resolved" if row["resolved"] else "unresolved"
            print(f"  - {row['symbol']} [{state}]")
        return 0
    finally:
        conn.close()


def cmd_impact(args: argparse.Namespace) -> int:
    conn = connect_db(_db_path())
    try:
        init_schema(conn, _repo_root() / "indexer" / "schema.sql")
        result = get_impact(conn, args.symbol)
        if not result:
            print("Symbol not found.")
            return 1

        target = result["target"]["qualified_name"]
        impacted = result["impacted"]
        print(f"# Impact for {target}")
        if not impacted:
            print("No callers found.")
            return 0

        for row in impacted:
            state = "resolved" if row["resolved"] else "unresolved"
            print(f"- depth={row['depth']} {row['symbol']} [{state}]")
        return 0
    finally:
        conn.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Repo graph index CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    p_index = sub.add_parser("index", help="Build/update graph index")
    p_index.add_argument("--changed-only", action="store_true", help="Only re-index files already present in DB")
    p_index.set_defaults(func=cmd_index)

    p_show = sub.add_parser("show", help="List symbols in a file")
    p_show.add_argument("file_path", help="Workspace-relative file path")
    p_show.set_defaults(func=cmd_show)

    p_search = sub.add_parser("search", help="Search symbols")
    p_search.add_argument("term", help="Search term")
    p_search.set_defaults(func=cmd_search)

    p_body = sub.add_parser("body", help="Show source for symbol")
    p_body.add_argument("symbol", help="Qualified or short symbol name")
    p_body.set_defaults(func=cmd_body)

    p_neighbors = sub.add_parser("neighbors", help="Show direct callers and callees")
    p_neighbors.add_argument("symbol", help="Qualified or short symbol name")
    p_neighbors.set_defaults(func=cmd_neighbors)

    p_impact = sub.add_parser("impact", help="Show full reverse dependency closure")
    p_impact.add_argument("symbol", help="Qualified or short symbol name")
    p_impact.set_defaults(func=cmd_impact)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))
