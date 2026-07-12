from __future__ import annotations

import hashlib
from pathlib import Path
import sqlite3

from .models import ParsedFile
from .parser import detect_language, parse_source_file

IGNORED_DIRS = {".git", ".venv", "venv", "node_modules", "__pycache__"}


def hash_file(file_path: Path) -> str:
    data = file_path.read_bytes()
    return hashlib.sha256(data).hexdigest()


def iter_supported_files(repo_root: Path) -> list[Path]:
    files: list[Path] = []
    for path in repo_root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in IGNORED_DIRS for part in path.parts):
            continue
        if detect_language(path) is None:
            continue
        files.append(path)
    return files


def _resolve_import_target(module_name: str, known_files: dict[str, int]) -> int | None:
    candidates = [
        f"{module_name.replace('.', '/')}.py",
        f"{module_name.replace('.', '/')}/__init__.py",
    ]
    for cand in candidates:
        if cand in known_files:
            return known_files[cand]
    return None


def _upsert_file_row(
    conn: sqlite3.Connection,
    rel_path: str,
    content_hash: str,
    parsed: ParsedFile,
) -> int:
    row = conn.execute("SELECT id FROM files WHERE path = ?", (rel_path,)).fetchone()
    if row:
        conn.execute(
            "UPDATE files SET language = ?, content_hash = ?, loc = ? WHERE id = ?",
            (parsed.language, content_hash, parsed.loc, row["id"]),
        )
        return int(row["id"])

    cur = conn.execute(
        "INSERT INTO files(path, language, content_hash, loc) VALUES (?, ?, ?, ?)",
        (rel_path, parsed.language, content_hash, parsed.loc),
    )
    return int(cur.lastrowid)


def _delete_existing_file_graph(conn: sqlite3.Connection, file_id: int) -> None:
    symbol_ids = [int(r["id"]) for r in conn.execute("SELECT id FROM symbols WHERE file_id = ?", (file_id,)).fetchall()]
    if symbol_ids:
        placeholders = ",".join(["?"] * len(symbol_ids))
        conn.execute(
            f"DELETE FROM edges WHERE (src_type = 'symbol' AND src_id IN ({placeholders})) "
            f"OR (dst_type = 'symbol' AND dst_id IN ({placeholders}))",
            tuple(symbol_ids + symbol_ids),
        )
        conn.execute(f"DELETE FROM symbols WHERE id IN ({placeholders})", tuple(symbol_ids))

    conn.execute("DELETE FROM edges WHERE src_type = 'file' AND src_id = ?", (file_id,))


def _insert_file_graph(
    conn: sqlite3.Connection,
    file_id: int,
    parsed: ParsedFile,
    file_lookup: dict[str, int],
) -> None:
    qname_to_id: dict[str, int] = {}
    for sym in parsed.symbols:
        cur = conn.execute(
            """
            INSERT INTO symbols(file_id, kind, name, qualified_name, signature, doc_summary, start_line, end_line)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                file_id,
                sym.kind,
                sym.name,
                sym.qualified_name,
                sym.signature,
                sym.doc_summary,
                sym.start_line,
                sym.end_line,
            ),
        )
        symbol_id = int(cur.lastrowid)
        qname_to_id[sym.qualified_name] = symbol_id
        conn.execute(
            "INSERT INTO edges(src_id, src_type, dst_id, dst_type, dst_name, edge_type, resolved) VALUES (?, 'file', ?, 'symbol', NULL, 'defines', 1)",
            (file_id, symbol_id),
        )

    for imp in parsed.imports:
        target_file_id = _resolve_import_target(imp.module, file_lookup)
        if target_file_id is not None:
            conn.execute(
                "INSERT INTO edges(src_id, src_type, dst_id, dst_type, dst_name, edge_type, resolved) VALUES (?, 'file', ?, 'file', NULL, 'imports', 1)",
                (file_id, target_file_id),
            )
        else:
            conn.execute(
                "INSERT INTO edges(src_id, src_type, dst_id, dst_type, dst_name, edge_type, resolved) VALUES (?, 'file', NULL, 'file', ?, 'imports', 0)",
                (file_id, imp.module),
            )

    for call in parsed.calls:
        src_id = qname_to_id.get(call.caller_qualified_name)
        if not src_id:
            continue
        conn.execute(
            "INSERT INTO edges(src_id, src_type, dst_id, dst_type, dst_name, edge_type, resolved) VALUES (?, 'symbol', NULL, 'symbol', ?, 'calls', 0)",
            (src_id, call.callee_name),
        )


def resolve_unresolved_calls(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        "SELECT id, dst_name FROM edges WHERE edge_type = 'calls' AND resolved = 0 AND dst_name IS NOT NULL"
    ).fetchall()
    for row in rows:
        callee = row["dst_name"]
        match = conn.execute(
            "SELECT id FROM symbols WHERE qualified_name = ? ORDER BY id LIMIT 1",
            (callee,),
        ).fetchone()
        if not match:
            match = conn.execute(
                "SELECT id FROM symbols WHERE name = ? ORDER BY id LIMIT 1",
                (callee,),
            ).fetchone()
        if match:
            conn.execute(
                "UPDATE edges SET dst_id = ?, resolved = 1 WHERE id = ?",
                (int(match["id"]), int(row["id"])),
            )


def build_or_update_index(repo_root: Path, db_path: Path, changed_only: bool = False) -> dict[str, int]:
    from .db import connect_db, init_schema

    conn = connect_db(db_path)
    try:
        init_schema(conn, repo_root / "indexer" / "schema.sql")
        files = iter_supported_files(repo_root)
        indexed = 0
        skipped = 0

        known_files = {
            str(Path(r["path"])): int(r["id"])
            for r in conn.execute("SELECT id, path FROM files").fetchall()
        }

        for path in files:
            rel_path = str(path.relative_to(repo_root))
            digest = hash_file(path)
            existing = conn.execute(
                "SELECT id, content_hash FROM files WHERE path = ?",
                (rel_path,),
            ).fetchone()

            if existing and existing["content_hash"] == digest:
                skipped += 1
                continue

            if changed_only and not existing:
                skipped += 1
                continue

            parsed = parse_source_file(path, repo_root)
            if parsed is None:
                skipped += 1
                continue
            file_id = _upsert_file_row(conn, rel_path, digest, parsed)
            _delete_existing_file_graph(conn, file_id)
            known_files[rel_path] = file_id
            _insert_file_graph(conn, file_id, parsed, known_files)
            indexed += 1

        resolve_unresolved_calls(conn)
        conn.commit()
        return {"indexed": indexed, "skipped": skipped, "total": len(files)}
    finally:
        conn.close()
