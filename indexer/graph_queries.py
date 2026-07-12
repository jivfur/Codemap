from __future__ import annotations

import sqlite3


def resolve_symbol(conn: sqlite3.Connection, symbol_query: str) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT id, name, qualified_name
        FROM symbols
        WHERE qualified_name = ? OR name = ?
        ORDER BY CASE WHEN qualified_name = ? THEN 0 ELSE 1 END, id
        LIMIT 1
        """,
        (symbol_query, symbol_query, symbol_query),
    ).fetchone()


def get_neighbors(conn: sqlite3.Connection, symbol_query: str) -> dict[str, object] | None:
    target = resolve_symbol(conn, symbol_query)
    if not target:
        return None

    callers_resolved = conn.execute(
        """
        SELECT s.qualified_name AS symbol, 1 AS resolved
        FROM edges e
        JOIN symbols s ON s.id = e.src_id
        WHERE e.edge_type = 'calls'
          AND e.src_type = 'symbol'
          AND e.dst_type = 'symbol'
          AND e.dst_id = ?
          AND e.resolved = 1
        ORDER BY s.qualified_name
        """,
        (target["id"],),
    ).fetchall()

    callers_unresolved = conn.execute(
        """
        SELECT s.qualified_name AS symbol, 0 AS resolved
        FROM edges e
        JOIN symbols s ON s.id = e.src_id
        WHERE e.edge_type = 'calls'
          AND e.src_type = 'symbol'
          AND e.resolved = 0
          AND e.dst_name = ?
        ORDER BY s.qualified_name
        """,
        (target["name"],),
    ).fetchall()

    callees = conn.execute(
        """
        SELECT COALESCE(s.qualified_name, e.dst_name) AS symbol, e.resolved AS resolved
        FROM edges e
        LEFT JOIN symbols s ON s.id = e.dst_id
        WHERE e.edge_type = 'calls'
          AND e.src_type = 'symbol'
          AND e.src_id = ?
        ORDER BY COALESCE(s.qualified_name, e.dst_name)
        """,
        (target["id"],),
    ).fetchall()

    callers = {}
    for row in list(callers_resolved) + list(callers_unresolved):
        callers[row["symbol"]] = int(row["resolved"])

    return {
        "target": dict(target),
        "callers": [{"symbol": k, "resolved": v} for k, v in sorted(callers.items())],
        "callees": [{"symbol": row["symbol"], "resolved": int(row["resolved"])} for row in callees],
    }


def get_impact(conn: sqlite3.Connection, symbol_query: str) -> dict[str, object] | None:
    target = resolve_symbol(conn, symbol_query)
    if not target:
        return None

    resolved_rows = conn.execute(
        """
        WITH RECURSIVE callers(depth, symbol_id, path) AS (
            SELECT 1 AS depth,
                   e.src_id AS symbol_id,
                   ',' || CAST(e.src_id AS TEXT) || ',' AS path
            FROM edges e
            WHERE e.edge_type = 'calls'
              AND e.src_type = 'symbol'
              AND e.dst_type = 'symbol'
              AND e.dst_id = ?
              AND e.resolved = 1

            UNION ALL

            SELECT c.depth + 1,
                   e.src_id,
                   c.path || CAST(e.src_id AS TEXT) || ','
            FROM callers c
            JOIN edges e
              ON e.dst_id = c.symbol_id
             AND e.edge_type = 'calls'
             AND e.src_type = 'symbol'
             AND e.dst_type = 'symbol'
             AND e.resolved = 1
            WHERE instr(c.path, ',' || CAST(e.src_id AS TEXT) || ',') = 0
        )
        SELECT s.qualified_name AS symbol, MIN(c.depth) AS depth, 1 AS resolved
        FROM callers c
        JOIN symbols s ON s.id = c.symbol_id
        WHERE c.symbol_id != ?
        GROUP BY s.qualified_name
        ORDER BY depth, symbol
        """,
        (target["id"], target["id"]),
    ).fetchall()

    unresolved_direct = conn.execute(
        """
        SELECT s.qualified_name AS symbol, 1 AS depth, 0 AS resolved
        FROM edges e
        JOIN symbols s ON s.id = e.src_id
        WHERE e.edge_type = 'calls'
          AND e.src_type = 'symbol'
          AND e.resolved = 0
          AND e.dst_name = ?
        ORDER BY s.qualified_name
        """,
        (target["name"],),
    ).fetchall()

    by_symbol: dict[str, dict[str, int | str]] = {}
    for row in resolved_rows:
        by_symbol[row["symbol"]] = {
            "symbol": row["symbol"],
            "depth": int(row["depth"]),
            "resolved": int(row["resolved"]),
        }

    for row in unresolved_direct:
        symbol = row["symbol"]
        if symbol in by_symbol:
            continue
        by_symbol[symbol] = {
            "symbol": symbol,
            "depth": int(row["depth"]),
            "resolved": int(row["resolved"]),
        }

    impacted = sorted(by_symbol.values(), key=lambda item: (int(item["depth"]), str(item["symbol"])))
    return {
        "target": dict(target),
        "impacted": impacted,
    }


def get_path(conn: sqlite3.Connection, source_query: str, target_query: str) -> dict[str, object] | None:
    source = resolve_symbol(conn, source_query)
    target = resolve_symbol(conn, target_query)
    if not source or not target:
        return None

    row = conn.execute(
        """
        WITH RECURSIVE walk(depth, symbol_id, visited, path_ids) AS (
            SELECT 0,
                   ? AS symbol_id,
                   ',' || CAST(? AS TEXT) || ',' AS visited,
                   CAST(? AS TEXT) AS path_ids

            UNION ALL

            SELECT w.depth + 1,
                   e.dst_id,
                   w.visited || CAST(e.dst_id AS TEXT) || ',',
                   w.path_ids || ',' || CAST(e.dst_id AS TEXT)
            FROM walk w
            JOIN edges e
              ON e.src_id = w.symbol_id
             AND e.edge_type = 'calls'
             AND e.src_type = 'symbol'
             AND e.dst_type = 'symbol'
             AND e.resolved = 1
             AND e.dst_id IS NOT NULL
            WHERE instr(w.visited, ',' || CAST(e.dst_id AS TEXT) || ',') = 0
        )
        SELECT path_ids
        FROM walk
        WHERE symbol_id = ?
        ORDER BY depth
        LIMIT 1
        """,
        (source["id"], source["id"], source["id"], target["id"]),
    ).fetchone()

    if not row:
        return {
            "source": dict(source),
            "target": dict(target),
            "path": [],
        }

    path_ids = [int(part) for part in str(row["path_ids"]).split(",") if part]
    placeholders = ",".join(["?"] * len(path_ids))
    symbol_rows = conn.execute(
        f"SELECT id, qualified_name FROM symbols WHERE id IN ({placeholders})",
        tuple(path_ids),
    ).fetchall()
    id_to_qname = {int(r["id"]): str(r["qualified_name"]) for r in symbol_rows}

    return {
        "source": dict(source),
        "target": dict(target),
        "path": [id_to_qname[sid] for sid in path_ids if sid in id_to_qname],
    }


def get_rank(conn: sqlite3.Connection, top: int = 20) -> list[dict[str, object]]:
    symbol_rows = conn.execute("SELECT id, qualified_name FROM symbols").fetchall()
    if not symbol_rows:
        return []

    symbol_ids = [int(row["id"]) for row in symbol_rows]
    id_to_name = {int(row["id"]): str(row["qualified_name"]) for row in symbol_rows}

    adjacency = {sid: set() for sid in symbol_ids}
    edge_rows = conn.execute(
        """
        SELECT src_id, dst_id
        FROM edges
        WHERE edge_type = 'calls'
          AND src_type = 'symbol'
          AND dst_type = 'symbol'
          AND resolved = 1
          AND dst_id IS NOT NULL
        """
    ).fetchall()
    for row in edge_rows:
        src_id = int(row["src_id"])
        dst_id = int(row["dst_id"])
        if src_id in adjacency and dst_id in adjacency:
            adjacency[src_id].add(dst_id)

    incoming = {sid: set() for sid in symbol_ids}
    for src_id, dst_ids in adjacency.items():
        for dst_id in dst_ids:
            incoming[dst_id].add(src_id)

    n = len(symbol_ids)
    damping = 0.85
    base = (1.0 - damping) / float(n)
    rank = {sid: 1.0 / float(n) for sid in symbol_ids}

    for _ in range(100):
        dangling_sum = sum(rank[sid] for sid in symbol_ids if not adjacency[sid])
        distributed_dangling = damping * dangling_sum / float(n)

        next_rank: dict[int, float] = {}
        for sid in symbol_ids:
            inbound = 0.0
            for src_id in incoming[sid]:
                out_degree = len(adjacency[src_id])
                if out_degree:
                    inbound += rank[src_id] / float(out_degree)
            next_rank[sid] = base + distributed_dangling + (damping * inbound)

        delta = sum(abs(next_rank[sid] - rank[sid]) for sid in symbol_ids)
        rank = next_rank
        if delta < 1e-12:
            break

    ordered = sorted(symbol_ids, key=lambda sid: (-rank[sid], id_to_name[sid]))
    limit = max(0, int(top))
    if limit == 0:
        return []

    return [
        {
            "symbol": id_to_name[sid],
            "score": rank[sid],
        }
        for sid in ordered[:limit]
    ]
