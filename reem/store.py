"""SQLite storage: schema, migrations, seeding and small helpers.

Uses the standard library ``sqlite3`` so the project has no third-party
database dependency. A single connection is shared behind a re-entrant lock:
a weighing terminal issues a handful of writes an hour, so serialising them is
cheaper and far clearer than a pool.
"""

from __future__ import annotations


# ===========================================================================
# Seed item master  (was seed_data.py)
# ===========================================================================

SEED_ITEMS = [
    {"slug": "rice", "name": "Rice", "hi": "चावल"},
    {"slug": "sugar", "name": "Sugar", "hi": "चीनी"},
    {"slug": "wheat", "name": "Wheat", "hi": "गेहूं"},
    {"slug": "dal", "name": "Dal", "hi": "दाल"},
    {"slug": "flour", "name": "Flour", "hi": "आटा"},
    {"slug": "corn", "name": "Corn", "hi": "मक्का"},
]

# ===========================================================================
# Database access  (was db.py)
# ===========================================================================

import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterable, Sequence


_lock = threading.RLock()
_conn: sqlite3.Connection | None = None
_db_path: Path | None = None


def init_db(path: Path) -> sqlite3.Connection:
    """Open the database, create the schema and seed the item master."""
    global _conn, _db_path
    with _lock:
        if _conn is not None:
            return _conn
        _db_path = Path(path)
        _db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(_db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        # Take transaction control away from the sqlite3 driver: helpers below
        # either commit one statement or bracket a batch with an explicit
        # BEGIN/COMMIT, and the driver's implicit BEGIN would collide with it.
        conn.isolation_level = None
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA foreign_keys = ON")
        _conn = conn
        _migrate_legacy_recipe_tables(conn)
        _create_schema(conn)
        _run_migrations(conn)
        _seed(conn)
        return conn


def connection() -> sqlite3.Connection:
    if _conn is None:
        raise RuntimeError("init_db() has not been called")
    return _conn


def close() -> None:
    global _conn
    with _lock:
        if _conn is not None:
            try:
                _conn.close()
            finally:
                _conn = None


# ---------------------------------------------------------------------------
# Query helpers
# ---------------------------------------------------------------------------

def query_one(sql: str, params: Sequence[Any] = ()) -> sqlite3.Row | None:
    with _lock:
        cur = connection().execute(sql, params)
        try:
            return cur.fetchone()
        finally:
            cur.close()


def query_all(sql: str, params: Sequence[Any] = ()) -> list[sqlite3.Row]:
    with _lock:
        cur = connection().execute(sql, params)
        try:
            return cur.fetchall()
        finally:
            cur.close()


def run(sql: str, params: Sequence[Any] = ()) -> sqlite3.Cursor:
    with _lock:
        conn = connection()
        cur = conn.execute(sql, params)
        conn.commit()
        return cur


def execute_script(script: str) -> None:
    with _lock:
        conn = connection()
        conn.executescript(script)
        conn.commit()


class transaction:
    """Context manager that batches several statements into one transaction.

    The connection is in autocommit-like mode (each ``run`` commits), so a
    batch of line inserts has to be bracketed explicitly or a crash halfway
    through leaves a bill with fewer lines than were weighed.
    """

    def __init__(self) -> None:
        self._cursor: sqlite3.Cursor | None = None

    def __enter__(self) -> sqlite3.Connection:
        with _lock:
            conn = connection()
            conn.execute("BEGIN")
            return conn

    def __exit__(self, exc_type, exc, tb) -> bool:
        with _lock:
            conn = connection()
            if exc_type is None:
                conn.commit()
            else:
                conn.rollback()
        return False


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    cur = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
    )
    try:
        return cur.fetchone() is not None
    finally:
        cur.close()


def _columns(conn: sqlite3.Connection, table: str) -> list[str]:
    cur = conn.execute(f"PRAGMA table_info({table})")
    try:
        return [row["name"] for row in cur.fetchall()]
    finally:
        cur.close()


def _has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    return column in _columns(conn, table)


def _migrate_legacy_recipe_tables(conn: sqlite3.Connection) -> None:
    """Rename old 'recipe' tables to 'formula' in place, preserving rows."""
    if _table_exists(conn, "recipes") and not _table_exists(conn, "formulas"):
        conn.execute("ALTER TABLE recipes RENAME TO formulas")
        print("Migrated table recipes -> formulas")
    if _table_exists(conn, "recipe_lines") and not _table_exists(conn, "formula_lines"):
        conn.execute("ALTER TABLE recipe_lines RENAME TO formula_lines")
        print("Migrated table recipe_lines -> formula_lines")
    if _table_exists(conn, "formula_lines"):
        cols = _columns(conn, "formula_lines")
        if "recipe_id" in cols and "formula_id" not in cols:
            conn.execute("ALTER TABLE formula_lines RENAME COLUMN recipe_id TO formula_id")
            print("Migrated column formula_lines.recipe_id -> formula_id")
    conn.execute("DROP INDEX IF EXISTS idx_recipe_lines_recipe")
    conn.commit()


def _create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL UNIQUE,
          code TEXT NOT NULL,
          name TEXT NOT NULL,
          name_hi TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        CREATE TABLE IF NOT EXISTS formulas (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          item_count INTEGER NOT NULL DEFAULT 0,
          total_weight REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        CREATE TABLE IF NOT EXISTS formula_lines (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          formula_id INTEGER NOT NULL REFERENCES formulas(id) ON DELETE CASCADE,
          item_id INTEGER,
          item_name TEXT NOT NULL,
          required_weight REAL NOT NULL,
          position INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_formula_lines_formula ON formula_lines(formula_id);
        """
    )
    conn.commit()


def _run_migrations(conn: sqlite3.Connection) -> None:
    # Item photos live as files; the row keeps only the path.
    if not _has_column(conn, "items", "image_path"):
        conn.execute("ALTER TABLE items ADD COLUMN image_path TEXT")
        print("Migrated items: added image_path column")
    conn.commit()


def _seed(conn: sqlite3.Connection) -> None:
    cur = conn.execute("SELECT COUNT(*) AS n FROM items")
    try:
        count = int(cur.fetchone()["n"])
    finally:
        cur.close()
    if count > 0:
        print(f"Item master already seeded: {count} items")
        return
    for index, item in enumerate(SEED_ITEMS):
        code = f"RM-{index + 1:02d}"
        conn.execute(
            "INSERT INTO items (slug, code, name, name_hi) "
            "VALUES (?, ?, ?, ?)",
            (item["slug"], code, item["name"], item["hi"]),
        )
    conn.commit()
    print(f"Seeded item master with {len(SEED_ITEMS)} items")
