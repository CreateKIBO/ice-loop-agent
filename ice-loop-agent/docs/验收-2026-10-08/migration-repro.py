from __future__ import annotations
import json
import sqlite3
import sys
from pathlib import Path
from unittest.mock import patch
repo=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(repo))
import ice_agent.migrations as migrations

def first(conn):
    conn.execute("CREATE TABLE first(id INTEGER)")
def second(conn):
    conn.execute("CREATE TABLE second(id INTEGER)")
left=migrations.Migration(10,"same description",first)
right=migrations.Migration(10,"same description",second)
conn=sqlite3.connect(":memory:")
conn.execute("PRAGMA user_version=9")
with patch.object(migrations,"MIGRATIONS",[left]):
    migrations.run_migrations(conn,app_version="review")
with patch.object(migrations,"MIGRATIONS",[right]):
    resumed=migrations.run_migrations(conn,app_version="review")
checks={"different_sql_same_checksum":left.checksum==right.checksum,
        "changed_migration_silently_accepted":resumed["applied"]==[],
        "second_table_absent":conn.execute("SELECT name FROM sqlite_master WHERE name='second'").fetchone() is None}
conn.close()
conn=sqlite3.connect(":memory:")
conn.execute("PRAGMA user_version=9")
before={r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
with patch.object(migrations,"MIGRATIONS",[left]):
    migrations.run_migrations(conn,dry_run=True)
after={r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
checks["dry_run_added_tracking_table"]="schema_migrations" in after-before
conn.close()
(repo/'docs/验收-2026-10-08/migration-repro-result.json').write_text(json.dumps(checks,indent=2),encoding="utf-8")
print(json.dumps(checks))

