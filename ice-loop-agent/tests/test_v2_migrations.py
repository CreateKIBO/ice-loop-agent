"""v2.0 M0-04/05/08/09: migration samples, framework and backup/restore drill."""
from __future__ import annotations

import json
import sqlite3
import unittest
from pathlib import Path

from ice_agent import __version__
from ice_agent.backup import create_backup, restore_backup
from ice_agent.migrations import (
    BASELINE_VERSION, MAX_KNOWN_VERSION, run_migrations, verify_migrations,
    MIGRATIONS,
)
from ice_agent.domain.store import Store

from tests import temp_dir


def _fresh_v9_db(path: Path) -> sqlite3.Connection:
    """A v1.5.3-shaped database (user_version=9, core tables, sample rows)."""
    conn = sqlite3.connect(str(path))
    conn.executescript("""
        CREATE TABLE articles (
            article_id TEXT PRIMARY KEY, series TEXT NOT NULL, episode INTEGER NOT NULL,
            topic TEXT NOT NULL, readiness TEXT NOT NULL DEFAULT 'draft',
            spec_json TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE article_revisions (
            revision_id TEXT PRIMARY KEY, article_id TEXT NOT NULL, kind TEXT NOT NULL,
            content TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE jobs (
            job_id TEXT PRIMARY KEY, article_id TEXT NOT NULL, state TEXT NOT NULL,
            current_node TEXT NOT NULL, mode TEXT NOT NULL, created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL);
        CREATE TABLE model_invocations (
            invocation_id TEXT PRIMARY KEY, job_id TEXT, node_key TEXT, role TEXT,
            profile_id TEXT, model_id TEXT, adapter TEXT, attempt INTEGER NOT NULL DEFAULT 1,
            status TEXT, request_hash TEXT, usage_json TEXT, finish_reason TEXT,
            error TEXT, created_at TEXT NOT NULL);
        CREATE TABLE tasks (
            task_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 5, state TEXT NOT NULL DEFAULT 'queued',
            input_hash TEXT NOT NULL DEFAULT '', idempotency_key TEXT,
            payload TEXT NOT NULL DEFAULT '{}', result TEXT, error_code TEXT,
            attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
            lease_token TEXT, lease_expires_at TEXT,
            cancel_requested INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        INSERT INTO articles VALUES ('art-1', 'PY', 5, '示例主题', 'draft', '{}', '2026-10-07T00:00:00');
        INSERT INTO article_revisions VALUES ('rev-1', 'art-1', 'draft', '# 示例', 'hash-1', '2026-10-07T00:00:00');
        INSERT INTO jobs VALUES ('job-1', 'art-1', 'running', 'draft', 'review_each', '2026-10-07T00:00:00', '2026-10-07T00:00:00');
    """)
    # PRAGMA 不支持 ? 绑定；基线版本为字面量 9（与 migrations.BASELINE_VERSION 一致）。
    conn.execute("PRAGMA user_version=9")
    conn.commit()
    return conn


class TestMigrationFramework(unittest.TestCase):
    def setUp(self):
        self.dir = temp_dir('v2mig-')

    def test_pending_and_apply_records_checksum(self):
        path = self.dir / 'a.db'
        conn = _fresh_v9_db(path)
        latest = MAX_KNOWN_VERSION
        self.assertEqual(MIGRATIONS[-1].version, latest)
        self.assertEqual([m.version for m in sorted(MIGRATIONS, key=lambda m: m.version)],
                         list(range(BASELINE_VERSION + 1, latest + 1)),
                         '迁移编号必须从 10 起连续无空洞')
        report = run_migrations(conn, app_version=__version__)
        self.assertEqual(report['before'], 9)
        self.assertEqual(report['after'], latest)
        self.assertEqual([m['version'] for m in report['applied']],
                         list(range(BASELINE_VERSION + 1, latest + 1)))
        audit = verify_migrations(conn)
        self.assertEqual(audit['problems'], [])
        self.assertEqual(audit['recorded'], list(range(BASELINE_VERSION + 1, latest + 1)))
        # Re-running is a no-op: same version, nothing applied twice.
        again = run_migrations(conn, app_version=__version__)
        self.assertEqual(again['applied'], [])
        conn.close()

    def test_dry_run_leaves_database_untouched(self):
        path = self.dir / 'b.db'
        conn = _fresh_v9_db(path)
        report = run_migrations(conn, dry_run=True, app_version=__version__)
        self.assertEqual(report['dry_run'], True)
        self.assertEqual(report['dry_run_rolled_back'],
                         list(range(BASELINE_VERSION + 1, MAX_KNOWN_VERSION + 1)))
        self.assertEqual(conn.execute('PRAGMA user_version').fetchone()[0], 9)
        self.assertIsNone(conn.execute(
            "SELECT name FROM sqlite_master WHERE name='stream_events'").fetchone())
        # R15：dry-run 不留任何痕迹——包括本调用新建的跟踪表
        self.assertIsNone(conn.execute(
            "SELECT name FROM sqlite_master WHERE name='schema_migrations'").fetchone())
        conn.close()

    def test_checksum_covers_sql_content(self):
        """R15：不同 SQL 的迁移必须得到不同 checksum；v18+ 记录漂移会被拒绝执行。"""
        from ice_agent.migrations import Migration
        def make_a(conn):
            conn.execute("CREATE TABLE probe_a (x INTEGER)")
        def make_b(conn):
            conn.execute("CREATE TABLE probe_b (x INTEGER)")
        a = Migration(version=998, description="a", apply=make_a)
        b = Migration(version=999, description="b", apply=make_b)
        self.assertNotEqual(a.checksum, b.checksum,
                            "不同 SQL 内容不得因同形字节码得到相同 checksum")
        # 记录 checksum 漂移被拒绝执行（v18+ 使用当前算法，漂移即拒绝）
        path = self.dir / 'drift.db'
        conn = _fresh_v9_db(path)
        # 先迁移到最新，再篡改 v18 的 checksum
        run_migrations(conn, app_version=__version__)
        conn.execute(
            "UPDATE schema_migrations SET checksum='tampered' WHERE version>=18")
        conn.commit()
        with self.assertRaises(ValueError):
            run_migrations(conn, app_version=__version__)
        # v10-v17 使用旧算法，属于已知历史构建，不触发漂移拒绝
        conn.close()

    def test_failure_injection_rolls_back_version_and_schema(self):
        path = self.dir / 'c.db'
        conn = _fresh_v9_db(path)
        with self.assertRaises(RuntimeError):
            run_migrations(conn, app_version=__version__, stop_after=10)
        self.assertEqual(conn.execute('PRAGMA user_version').fetchone()[0], 9)
        self.assertIsNone(conn.execute(
            "SELECT name FROM sqlite_master WHERE name='stream_events'").fetchone())
        # Database stays openable and data intact after the aborted migration.
        self.assertEqual(conn.execute("SELECT topic FROM articles WHERE article_id='art-1'").fetchone()[0], '示例主题')
        conn.close()

    def test_newer_database_rejected_by_store(self):
        path = self.dir / 'd.db'
        conn = _fresh_v9_db(path)
        run_migrations(conn, app_version=__version__)
        # PRAGMA 不支持参数绑定；用字面量写一个远高于 MAX_KNOWN_VERSION 的
        # 版本号（9999 > 任何已注册迁移），语义与 MAX_KNOWN_VERSION+1 等价。
        self.assertLess(MAX_KNOWN_VERSION, 9999)
        conn.execute("PRAGMA user_version=9999")
        conn.commit()
        conn.close()
        with self.assertRaises(ValueError):
            Store(path)


class TestBackupRestoreDrill(unittest.TestCase):
    """M0-05: consistent backup via sqlite backup API and verified restore."""

    def setUp(self):
        self.dir = temp_dir('v2backup-')

    def _make_workload(self, root: Path) -> Path:
        import hashlib
        runtime = root / 'runtime'
        runtime.mkdir(parents=True)
        (runtime / 'jobs').mkdir()
        (runtime / 'jobs' / 'job-1').mkdir()
        (runtime / 'jobs' / 'job-1' / 'evidence.txt').write_text('run evidence', encoding='utf-8')
        articles = root / 'articles'
        articles.mkdir()
        (articles / '005-demo.md').write_text('# Demo\n\n正文', encoding='utf-8')
        settings = {
            'accounts': {'ice-loop': {'id': 'ice-loop', 'name': 'ICE Loop',
                                      'article_root': str(articles)}},
            'article_root': str(articles),
            'vision': {'status': 'ok'},
            'profiles': {'qwen': {'adapter': 'mock', 'status': 'ok'}},
        }
        # Real Store creates the full v9 schema (backup validation expects it).
        store = Store(runtime / 'app.db')
        spec = json.dumps({'article_root': str(articles)})
        store.conn.execute(
            "INSERT INTO articles (article_id, series, episode, topic, readiness, spec_json, created_at)"
            " VALUES ('art-1','PY',5,'示例主题','draft',?,'2026-10-07T00:00:00')", (spec,))
        evidence = runtime / 'jobs' / 'job-1' / 'evidence.txt'
        store.conn.execute(
            "INSERT INTO artifacts (artifact_id, kind, path, sha256, created_at)"
            " VALUES ('a-1','run-evidence',?,?,'2026-10-07T00:00:00')",
            (str(evidence), hashlib.sha256(evidence.read_bytes()).hexdigest()))
        store.conn.commit()
        store.close()
        return settings

    def test_roundtrip_preserves_data_and_blocks_running_jobs(self):
        import hashlib
        root = self.dir / 'ws'
        runtime = root / 'runtime'
        settings = self._make_workload(root)
        # A running job must block the backup (no inconsistent snapshot).
        conn = sqlite3.connect(str(runtime / 'app.db'))
        conn.execute(
            "INSERT INTO jobs (job_id, article_id, workflow, state, current_node, mode,"
            " lease, created_at, updated_at) VALUES"
            " ('job-1','art-1','main','running','draft','review_each','lease-x',"
            " '2026-10-07T00:00:00','2026-10-07T00:00:00')")
        conn.commit()
        conn.close()
        target = self.dir / 'backup.zip'
        with self.assertRaises(ValueError):
            create_backup(runtime, settings, target)
        conn = sqlite3.connect(str(runtime / 'app.db'))
        conn.execute("UPDATE jobs SET lease=NULL, state='paused'")
        conn.commit()
        conn.close()
        summary = create_backup(runtime, settings, target)
        self.assertTrue(target.exists())
        self.assertGreater(summary['files'], 0)
        # Restore into a fresh directory and verify content equality.
        destination = self.dir / 'restored'
        result = restore_backup(target, destination, summary['package_hash'])
        self.assertTrue((destination / 'runtime' / 'app.db').exists())
        restored = sqlite3.connect(str(destination / 'runtime' / 'app.db'))
        self.assertEqual(restored.execute('SELECT article_id FROM articles').fetchall(), [('art-1',)])
        source_version = sqlite3.connect(str(runtime / 'app.db')).execute(
            'PRAGMA user_version').fetchone()[0]
        self.assertEqual(restored.execute('PRAGMA user_version').fetchone()[0], source_version)
        restored.close()
        evidence = destination / 'runtime' / 'jobs' / 'job-1' / 'evidence.txt'
        self.assertEqual(evidence.read_text(encoding='utf-8'), 'run evidence')
        self.assertEqual(
            hashlib.sha256(evidence.read_bytes()).hexdigest(),
            hashlib.sha256((runtime / 'jobs' / 'job-1' / 'evidence.txt').read_bytes()).hexdigest())
        article = json.loads(sqlite3.connect(str(destination / 'runtime' / 'app.db'))
                             .execute('SELECT spec_json FROM articles').fetchone()[0])
        expected_root = str(destination / 'articles' / 'root-0')
        self.assertEqual(article['article_root'], expected_root)

    def test_restore_refuses_existing_directory_and_bad_hash(self):
        root = self.dir / 'ws2'
        runtime = root / 'runtime'
        settings = self._make_workload(root)
        target = self.dir / 'backup2.zip'
        summary = create_backup(runtime, settings, target)
        occupied = self.dir / 'restored2'
        occupied.mkdir()
        with self.assertRaises(ValueError):
            restore_backup(target, occupied, summary['package_hash'])
        with self.assertRaises(ValueError):
            restore_backup(target, self.dir / 'fresh', '0' * 64)


if __name__ == '__main__':
    unittest.main()
