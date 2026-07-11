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
