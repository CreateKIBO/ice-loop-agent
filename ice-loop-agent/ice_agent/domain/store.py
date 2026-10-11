"""SQLite 存储层（设计文档 §17.2 核心表的实现）。

- 关系、状态、版本、审核入 SQLite；
- 大文本与文件本体落文件系统，表里存 artifact 引用与 hash；
- operation_key 唯一约束实现生图幂等；
- events 表 job_id+sequence 唯一，SSE 恢复据此重放；
- 安全约定：每个 execute 调用点的 SQL 都是字符串字面量，值一律 ``?``
  参数绑定；更新方法逐列展开并做列名白名单校验，运行期零 SQL 拼接。
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .types import now_iso
from .. import __version__

_SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
    article_id TEXT PRIMARY KEY,
    folder_no INTEGER,
    folder_name TEXT,
    series TEXT NOT NULL,
    episode INTEGER NOT NULL,
    topic TEXT NOT NULL,
    working_title TEXT,
    final_title TEXT,
    abstract TEXT,
    readiness TEXT NOT NULL DEFAULT 'draft',
    spec_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS article_revisions (
    revision_id TEXT PRIMARY KEY,
    article_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    parent_revision TEXT,
    producer TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    article_id TEXT NOT NULL,
    workflow TEXT NOT NULL,
    state TEXT NOT NULL,
    current_node TEXT NOT NULL,
    mode TEXT NOT NULL,
    lease TEXT,
    model_route_snapshot TEXT,
    limits_json TEXT,
    pause_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS steps (
    step_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    node_key TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    input_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    output_refs TEXT,
    error TEXT,
    started_at TEXT,
    finished_at TEXT
);
CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    producer_step TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
    source_id TEXT PRIMARY KEY,
    article_id TEXT,
    url TEXT NOT NULL,
    title TEXT,
    tier INTEGER,
    retrieved_at TEXT,
    content_hash TEXT,
    summary TEXT
);
CREATE TABLE IF NOT EXISTS claims (
    claim_id TEXT PRIMARY KEY,
    article_id TEXT,
    text TEXT NOT NULL,
    risk_type TEXT,
    source_ids TEXT,
    status TEXT,
    verified_at TEXT,
    publish_day_check_required INTEGER DEFAULT 0,
    review_notes TEXT
);
CREATE TABLE IF NOT EXISTS asset_slots (
    slot_id TEXT PRIMARY KEY,
    article_id TEXT NOT NULL,
    figure_no INTEGER,
    prompt_no INTEGER,
    slot_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_candidates (
    candidate_id TEXT PRIMARY KEY,
    slot_id TEXT NOT NULL,
    source TEXT,
    file_path TEXT,
    sha256 TEXT,
    review_status TEXT,
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
    approval_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    revision INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    decision_note TEXT,
    decided_by TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS operations (
    operation_id TEXT PRIMARY KEY,
    operation_key TEXT NOT NULL UNIQUE,
    article_id TEXT NOT NULL,
    slot_id TEXT NOT NULL,
    candidate_index INTEGER NOT NULL,
    provider TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,
    settings_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_task_ref TEXT,
    provider_asset_refs TEXT,
    reserved_budget INTEGER,
    observed_cost TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    last_checked_at TEXT,
    notes TEXT
);
CREATE TABLE IF NOT EXISTS model_invocations (
    invocation_id TEXT PRIMARY KEY,
    job_id TEXT,
    node_key TEXT,
    role TEXT,
    profile_id TEXT,
    model_id TEXT,
    adapter TEXT,
    attempt INTEGER NOT NULL DEFAULT 1,
    status TEXT,
    request_hash TEXT,
    usage_json TEXT,
    finish_reason TEXT,
    error TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    job_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT,
    occurred_at TEXT NOT NULL,
    PRIMARY KEY (job_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_steps_job ON steps(job_id, node_key);
CREATE INDEX IF NOT EXISTS idx_revisions_article ON article_revisions(article_id, kind);
CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id, sequence);
CREATE TABLE IF NOT EXISTS checkpoints (
    job_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, content_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approval_choices (
    approval_id TEXT PRIMARY KEY, choice INTEGER
);
CREATE TABLE IF NOT EXISTS publication_resources (
    resource_id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS publication_drafts (
    draft_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, title TEXT NOT NULL,
    body TEXT NOT NULL, content_hash TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS publication_history (
    history_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, source_key TEXT NOT NULL,
    series TEXT NOT NULL DEFAULT '', episode INTEGER, title TEXT NOT NULL,
    body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', published_at TEXT NOT NULL DEFAULT '',
    manual_metadata INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    UNIQUE(account_id, source_key)
);
CREATE TABLE IF NOT EXISTS publication_progress (
    account_id TEXT NOT NULL, series TEXT NOT NULL, published_episode INTEGER NOT NULL,
    PRIMARY KEY(account_id, series)
);
CREATE TABLE IF NOT EXISTS publication_plans (
    plan_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, series TEXT NOT NULL,
    episode INTEGER NOT NULL, context_hash TEXT NOT NULL, proposal_json TEXT NOT NULL,
    confirmation_json TEXT, confirmation_hash TEXT, job_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_reviews (
    candidate_id TEXT PRIMARY KEY, status TEXT NOT NULL, note TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS editorial_topics (
    topic_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, series TEXT NOT NULL,
    episode INTEGER NOT NULL, title TEXT NOT NULL, content_angle TEXT NOT NULL,
    core_benefit TEXT NOT NULL, next_episode_plan TEXT NOT NULL,
    source_name TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(account_id,series,episode)
);
CREATE TABLE IF NOT EXISTS editorial_topic_imports (
    import_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, source_name TEXT NOT NULL,
    source_text TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
"""


def _reject_unknown_columns(entity: str, allowed: frozenset[str],
                            fields: dict[str, Any]) -> None:
    unknown = set(fields) - allowed
    if unknown:
        raise ValueError(f"{entity} 非法更新列：{sorted(unknown)}")


class Store:
    _ARTICLE_COLS = frozenset({
        "folder_no", "folder_name", "series", "episode", "topic", "working_title",
        "final_title", "abstract", "readiness",
    })
    _JOB_COLS = frozenset({"state", "current_node", "mode", "lease", "pause_reason"})
    _OPERATION_COLS = frozenset({
        "status", "provider_task_ref", "provider_asset_refs", "reserved_budget",
        "observed_cost", "error_code", "notes",
    })

    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.conn = sqlite3.connect(str(self.db_path))
        self.conn.row_factory = sqlite3.Row
        from ..migrations import MAX_KNOWN_VERSION, run_migrations
        schema_version=self.conn.execute('PRAGMA user_version').fetchone()[0]
        if schema_version>MAX_KNOWN_VERSION:
            self.conn.close()
            raise ValueError('数据库来自较新版本，不能使用旧引擎打开')
        if schema_version<9 and self.conn.execute("SELECT 1 FROM sqlite_master WHERE name='articles'").fetchone():
            backup_path=self.db_path.with_name(self.db_path.stem+'-before-v1.0.db')
            if not backup_path.exists():
                with sqlite3.connect(str(backup_path)) as destination:
                    self.conn.backup(destination)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(_SCHEMA)
        # Legacy (<9) databases adopt the v1.5.3 baseline version; databases at
        # 9+ are only ever advanced by numbered migrations, never rewritten on
        # open (read/poll connections must not take a writer lock).
        if schema_version < 9:
            self.conn.execute('PRAGMA user_version=9')
        self.conn.commit()
        # Numbered v2.0 migrations run only when something is pending; fully
        # migrated databases skip the tracking-table check-free fast path.
        if schema_version < MAX_KNOWN_VERSION or not self.conn.execute(
                "SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").fetchone():
            run_migrations(self.conn, app_version=__version__)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    @contextmanager
    def transaction(self):
        """One connection per worker; nested store calls share the outer transaction."""
        outer = self.conn.in_transaction
        if not outer:
            self.conn.execute("BEGIN IMMEDIATE")
        try:
            yield
            if not outer:
                self.conn.commit()
        except BaseException:
            if not outer:
                self.conn.rollback()
            raise

    def reserve_invocation(self, inv: dict[str, Any], maximum: int | None) -> None:
        from ..llm.errors import ModelBudgetExceeded
        with self.transaction():
            count = self.conn.execute(
                "SELECT COUNT(*) FROM model_invocations WHERE job_id=?"
                " AND status != 'MODEL_CAPABILITY_MISMATCH'", (inv.get("job_id"),)).fetchone()[0]
            if maximum is not None and count >= maximum:
                raise ModelBudgetExceeded(f"本篇模型调用已达到上限 {maximum}，请调整预算后再继续")
            self.add_invocation(inv, commit=False)

    def finish_invocation(self, invocation_id: str, status: str, usage: dict,
                          finish_reason: str = "", error: str = "") -> None:
        self.conn.execute(
            "UPDATE model_invocations SET status=?, usage_json=?, finish_reason=?, error=?"
            " WHERE invocation_id=?",
            (status, json.dumps(usage, ensure_ascii=False), finish_reason, error, invocation_id))
        self.conn.commit()

    def claim_job(self, job_id: str, token: str) -> bool:
        cursor = self.conn.execute(
            "UPDATE jobs SET lease=? WHERE job_id=? AND (lease IS NULL OR lease='')",
            (token, job_id))
        self.conn.commit()
        return cursor.rowcount == 1

    def release_job(self, job_id: str, token: str) -> None:
        self.conn.execute("UPDATE jobs SET lease=NULL WHERE job_id=? AND lease=?", (job_id, token))
        self.conn.commit()

    def get_candidate(self, candidate_id: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM asset_candidates WHERE candidate_id=?", (candidate_id,)).fetchone()
        return dict(row) if row else None

    def get_source(self, source_id: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM sources WHERE source_id=?", (source_id,)).fetchone()
        return dict(row) if row else None

    def reserve_folder(self, article_id: str, article_root: Path) -> int:
        with self.transaction():
            row = self.conn.execute("SELECT folder_no FROM articles WHERE article_id=?", (article_id,)).fetchone()
            if row and row[0] is not None:
                return row[0]
            number = self.next_folder_no(article_root)
            self.conn.execute("UPDATE articles SET folder_no=? WHERE article_id=?", (number, article_id))
            return number

    # ------------------------------------------------------------ 文章
    def create_article(self, article: dict[str, Any]) -> None:
        self.conn.execute(
            "INSERT INTO articles (article_id, folder_no, folder_name, series, episode,"
            " topic, working_title, final_title, abstract, readiness, spec_json, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                article["article_id"], article.get("folder_no"), article.get("folder_name"),
                article["series"], article["episode"], article["topic"],
                article.get("working_title"), article.get("final_title"),
                article.get("abstract"), article.get("readiness", "draft"),
                json.dumps(article.get("spec", {}), ensure_ascii=False), now_iso(),
            ),
        )
        self.conn.commit()

    def get_article(self, article_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM articles WHERE article_id=?", (article_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["spec"] = json.loads(d.pop("spec_json"))
        return d

    def update_article(self, article_id: str, **fields: Any) -> None:
        _reject_unknown_columns("articles", self._ARTICLE_COLS, fields)
        if "folder_no" in fields:
            self.conn.execute(
                "UPDATE articles SET folder_no=? WHERE article_id=?",
                (fields["folder_no"], article_id))
        if "folder_name" in fields:
            self.conn.execute(
                "UPDATE articles SET folder_name=? WHERE article_id=?",
                (fields["folder_name"], article_id))
        if "series" in fields:
            self.conn.execute(
                "UPDATE articles SET series=? WHERE article_id=?",
                (fields["series"], article_id))
        if "episode" in fields:
            self.conn.execute(
                "UPDATE articles SET episode=? WHERE article_id=?",
                (fields["episode"], article_id))
        if "topic" in fields:
            self.conn.execute(
                "UPDATE articles SET topic=? WHERE article_id=?",
                (fields["topic"], article_id))
        if "working_title" in fields:
            self.conn.execute(
                "UPDATE articles SET working_title=? WHERE article_id=?",
                (fields["working_title"], article_id))
        if "final_title" in fields:
            self.conn.execute(
                "UPDATE articles SET final_title=? WHERE article_id=?",
                (fields["final_title"], article_id))
        if "abstract" in fields:
            self.conn.execute(
                "UPDATE articles SET abstract=? WHERE article_id=?",
                (fields["abstract"], article_id))
        if "readiness" in fields:
            self.conn.execute(
                "UPDATE articles SET readiness=? WHERE article_id=?",
                (fields["readiness"], article_id))
        self.conn.commit()

    def list_articles(self) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT article_id, folder_no, series, episode, topic, final_title,"
            " readiness FROM articles ORDER BY created_at").fetchall()
        return [dict(r) for r in rows]

    def next_folder_no(self, article_root: Path) -> int:
        """扫描已有文件夹编号并给出下一个可用编号（§17.1）。"""
        rows = self.conn.execute(
            "SELECT folder_no FROM articles WHERE folder_no IS NOT NULL").fetchall()
        used: set[int] = {r["folder_no"] for r in rows}
        if article_root.exists():
            for child in article_root.iterdir():
                if child.is_dir():
                    head = child.name.split("-", 1)[0]
                    if head.isdigit():
                        used.add(int(head))
        n = 1
        while n in used:
            n += 1
        return n

    # ------------------------------------------------------------ 版本
    def add_revision(self, rev: dict[str, Any]) -> None:
        self.conn.execute(
            "INSERT INTO article_revisions (revision_id, article_id, kind, content,"
            " content_hash, parent_revision, producer, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (rev["revision_id"], rev["article_id"], rev["kind"], rev["content"],
             rev["content_hash"], rev.get("parent_revision"), rev.get("producer", ""),
             rev.get("created_at", now_iso())),
        )
        self.conn.commit()

    def latest_revision(self, article_id: str, kind: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM article_revisions WHERE article_id=? AND kind=?"
            " ORDER BY created_at DESC, rowid DESC LIMIT 1",
            (article_id, kind)).fetchone()
        return dict(row) if row else None

    # ------------------------------------------------------------ 任务
    def create_job(self, job: dict[str, Any]) -> None:
        ts = now_iso()
        self.conn.execute(
            "INSERT INTO jobs (job_id, article_id, workflow, state, current_node, mode,"
            " lease, model_route_snapshot, limits_json, pause_reason, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (job["job_id"], job["article_id"], job["workflow"], job["state"],
             job["current_node"], job["mode"], None,
             json.dumps(job.get("model_route_snapshot", {}), ensure_ascii=False),
             json.dumps(job.get("limits", {}), ensure_ascii=False), "", ts, ts),
        )
        self.conn.commit()

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["model_route_snapshot"] = json.loads(d["model_route_snapshot"] or "{}")
        d["limits"] = json.loads(d["limits_json"] or "{}")
        return d

    def update_job(self, job_id: str, **fields: Any) -> None:
        _reject_unknown_columns("jobs", self._JOB_COLS, fields)
        if "state" in fields:
            self.conn.execute(
                "UPDATE jobs SET state=? WHERE job_id=?", (fields["state"], job_id))
        if "current_node" in fields:
            self.conn.execute(
                "UPDATE jobs SET current_node=? WHERE job_id=?",
                (fields["current_node"], job_id))
        if "mode" in fields:
            self.conn.execute(
                "UPDATE jobs SET mode=? WHERE job_id=?", (fields["mode"], job_id))
        if "lease" in fields:
            self.conn.execute(
                "UPDATE jobs SET lease=? WHERE job_id=?", (fields["lease"], job_id))
        if "pause_reason" in fields:
            self.conn.execute(
                "UPDATE jobs SET pause_reason=? WHERE job_id=?",
                (fields["pause_reason"], job_id))
        self.conn.execute(
            "UPDATE jobs SET updated_at=? WHERE job_id=?", (now_iso(), job_id))
        self.conn.commit()

    # ------------------------------------------------------------ 步骤
    def upsert_step(self, step: dict[str, Any], *, commit: bool = True) -> None:
        self.conn.execute(
            "INSERT INTO steps (step_id, job_id, node_key, attempt, input_hash, status,"
            " output_refs, error, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(step_id) DO UPDATE SET status=excluded.status,"
            " output_refs=excluded.output_refs, error=excluded.error,"
            " finished_at=excluded.finished_at",
            (step["step_id"], step["job_id"], step["node_key"], step.get("attempt", 1),
             step["input_hash"], step["status"],
             json.dumps(step.get("output_refs", {}), ensure_ascii=False),
             step.get("error"), step.get("started_at", now_iso()),
             step.get("finished_at")),
        )
        if commit:
            self.conn.commit()

    def save_checkpoint(self, job_id: str, state: dict, *, commit: bool = True) -> None:
        from .types import sha256_text
        text = json.dumps(state, ensure_ascii=False)
        self.conn.execute("INSERT INTO checkpoints VALUES (?,?,?) ON CONFLICT(job_id)"
                          " DO UPDATE SET state_json=excluded.state_json, content_hash=excluded.content_hash",
                          (job_id, text, sha256_text(text)))
        if commit:
            self.conn.commit()

    def load_checkpoint(self, job_id: str) -> dict | None:
        from .types import sha256_text
        row = self.conn.execute("SELECT state_json, content_hash FROM checkpoints WHERE job_id=?", (job_id,)).fetchone()
        if row:
            if sha256_text(row[0]) != row[1]:
                raise ValueError("任务检查点校验失败")
            return json.loads(row[0])
        return None

    def find_completed_step(self, job_id: str, node_key: str,
                            input_hash: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM steps WHERE job_id=? AND node_key=? AND input_hash=?"
            " AND status='completed' ORDER BY rowid DESC LIMIT 1",
            (job_id, node_key, input_hash)).fetchone()
        if row is None:
            return None
        d = dict(row)
        d["output_refs"] = json.loads(d["output_refs"] or "{}")
        return d

    # ------------------------------------------------------------ 审核
    def add_approval(self, ap: dict[str, Any]) -> str:
        self.conn.execute(
            "INSERT INTO approvals (approval_id, job_id, scope, revision, content_hash,"
            " payload, status, decision_note, decided_by, decided_at, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (ap["approval_id"], ap["job_id"], ap["scope"], ap["revision"],
             ap["content_hash"], json.dumps(ap["payload"], ensure_ascii=False),
             ap.get("status", "pending"), ap.get("decision_note", ""),
             ap.get("decided_by", ""), ap.get("decided_at"),
             ap.get("created_at", now_iso())),
        )
        self.conn.commit()
        return ap["approval_id"]

    def get_approval(self, approval_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM approvals WHERE approval_id=?", (approval_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["payload"] = json.loads(d["payload"])
        return d

    def pending_approval(self, job_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM approvals WHERE job_id=? AND status='pending'"
            " ORDER BY rowid DESC LIMIT 1", (job_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["payload"] = json.loads(d["payload"])
        return d

    def next_approval_revision(self, job_id: str, scope: str) -> int:
        row = self.conn.execute(
            "SELECT MAX(revision) AS r FROM approvals WHERE job_id=? AND scope=?",
            (job_id, scope)).fetchone()
        return (row["r"] or 0) + 1

    def decide_approval(self, approval_id: str, decision: str, note: str,
                        actor: str, expect_hash: str | None = None, *, commit: bool = True) -> bool:
        """带 hash 校验的审核决定：过期批准返回 False（§18.1 409 语义）。"""
        ap = self.get_approval(approval_id)
        if not ap or ap["status"] != "pending":
            return False
        if expect_hash is not None and ap["content_hash"] != expect_hash:
            return False
        status = "approved" if decision == "approve" else "rejected"
        if decision not in ("approve", "reject"):
            return False
        cursor = self.conn.execute(
            "UPDATE approvals SET status=?, decision_note=?, decided_by=?, decided_at=?"
            " WHERE approval_id=? AND status='pending' AND content_hash=?",
            (status, note, actor, now_iso(), approval_id, ap["content_hash"]))
        if commit:
            self.conn.commit()
        return cursor.rowcount == 1

    # ------------------------------------------------------------ 事件
    def append_event(self, job_id: str, event_type: str,
                     payload: dict[str, Any] | None = None,
                     sequence: int | None = None) -> int:
        with self.transaction():
            if sequence is None:
                row = self.conn.execute("SELECT MAX(sequence) AS s FROM events WHERE job_id=?", (job_id,)).fetchone()
                sequence = (row["s"] or 0) + 1
            self.conn.execute(
                "INSERT INTO events (job_id, sequence, event_type, payload, occurred_at) VALUES (?,?,?,?,?)",
                (job_id, sequence, event_type, json.dumps(payload or {}, ensure_ascii=False), now_iso()))
        return sequence

    def job_events(self, job_id: str, after: int = 0) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM events WHERE job_id=? AND sequence>? ORDER BY sequence",
            (job_id, after)).fetchall()
        return [dict(r) for r in rows]

    # ----------------------------------------------------- v2 持久事件流（M1-05）
    def append_stream_event(self, stream_id: str, account_id: str, event_type: str,
                            payload: dict[str, Any], event_id: str | None = None,
                            commit: bool = True) -> dict[str, Any]:
        """持久化一条流事件，sequence 在 (stream_id) 内严格单调。

        调用方应先提交状态再投递事件：commit=False 时沿用外层事务。
        """
        with self.transaction():
            row = self.conn.execute(
                "SELECT MAX(sequence) AS s FROM stream_events WHERE stream_id=?",
                (stream_id,)).fetchone()
            sequence = (row["s"] or 0) + 1
            event_id = event_id or f"evt-{stream_id}-{sequence}"
            self.conn.execute(
                "INSERT INTO stream_events (stream_id, sequence, event_id, account_id,"
                " event_type, payload, created_at) VALUES (?,?,?,?,?,?,?)",
                (stream_id, sequence, event_id, account_id, event_type,
                 json.dumps(payload or {}, ensure_ascii=False), now_iso()))
            if commit:
                self.conn.commit()
        return {"event_id": event_id, "stream_id": stream_id, "sequence": sequence,
                "account_id": account_id, "type": event_type, "payload": payload or {}}

    def stream_events_after(self, stream_id: str, after: int = 0,
                            limit: int = 200) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM stream_events WHERE stream_id=? AND sequence>?"
            " ORDER BY sequence LIMIT ?", (stream_id, after, limit)).fetchall()
        return [{"event_id": r["event_id"], "stream_id": r["stream_id"],
                 "sequence": r["sequence"], "account_id": r["account_id"],
                 "type": r["event_type"], "payload": json.loads(r["payload"]),
                 "created_at": r["created_at"]} for r in rows]

    def latest_stream_sequence(self, stream_id: str) -> int:
        row = self.conn.execute(
            "SELECT MAX(sequence) AS s FROM stream_events WHERE stream_id=?",
            (stream_id,)).fetchone()
        return row["s"] or 0

    # ------------------------------------------------------------ 资产
    def upsert_slot(self, slot: dict[str, Any]) -> None:
        self.conn.execute(
            "INSERT INTO asset_slots (slot_id, article_id, figure_no, prompt_no, slot_json)"
            " VALUES (?,?,?,?,?)"
            " ON CONFLICT(slot_id) DO UPDATE SET slot_json=excluded.slot_json,"
            " figure_no=excluded.figure_no, prompt_no=excluded.prompt_no",
            (slot["slot_id"], slot["article_id"], slot.get("figure_no"),
             slot.get("prompt_no"), json.dumps(slot, ensure_ascii=False)),
        )
        self.conn.commit()

    def article_slots(self, article_id: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT slot_json FROM asset_slots WHERE article_id=? ORDER BY figure_no",
            (article_id,)).fetchall()
        return [json.loads(r["slot_json"]) for r in rows]

    def add_candidate(self, cand: dict[str, Any]) -> None:
        self.conn.execute(
            "INSERT INTO asset_candidates (candidate_id, slot_id, source, file_path,"
            " sha256, review_status, created_at) VALUES (?,?,?,?,?,?,?)",
            (cand["candidate_id"], cand["slot_id"], cand.get("source", ""),
             cand.get("file_path", ""), cand.get("sha256", ""),
             cand.get("review_status", "pending"), cand.get("created_at", now_iso())),
        )
        self.conn.commit()

    def slot_candidates(self, slot_id: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT c.*, COALESCE(r.note,'') AS review_note FROM asset_candidates c"
            " LEFT JOIN asset_reviews r ON r.candidate_id=c.candidate_id WHERE c.slot_id=? ORDER BY c.rowid",
            (slot_id,)).fetchall()
        from .types import sha256_json
        return [{**dict(row),'content_hash':sha256_json(dict(row))} for row in rows]

    # ------------------------------------------------------------ 账本
    def insert_operation(self, op: dict[str, Any], *, commit: bool = True) -> None:
        """插入操作行；operation_key 唯一约束防止重复派发（§13.1）。"""
        self.conn.execute(
            "INSERT INTO operations (operation_id, operation_key, article_id, slot_id,"
            " candidate_index, provider, prompt_hash, settings_hash, status,"
            " provider_task_ref, provider_asset_refs, reserved_budget, observed_cost,"
            " error_code, created_at, last_checked_at, notes)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (op["operation_id"], op["operation_key"], op["article_id"], op["slot_id"],
             op["candidate_index"], op["provider"], op["prompt_hash"], op["settings_hash"],
             op["status"], op.get("provider_task_ref", ""),
             json.dumps(op.get("provider_asset_refs", [])),
             op.get("reserved_budget", 1), op.get("observed_cost", "unknown"),
             op.get("error_code", ""), op.get("created_at", now_iso()),
             op.get("last_checked_at", now_iso()), op.get("notes", "")),
        )
        if commit:
            self.conn.commit()

    def find_operation_by_key(self, operation_key: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM operations WHERE operation_key=?",
            (operation_key,)).fetchone()
        if row is None:
            return None
        return self._op_row(row)

    def get_operation(self, operation_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM operations WHERE operation_id=?",
            (operation_id,)).fetchone()
        if row is None:
            return None
        return self._op_row(row)

    @staticmethod
    def _op_row(row: sqlite3.Row) -> dict[str, Any]:
        d = dict(row)
        d["provider_asset_refs"] = json.loads(d.get("provider_asset_refs") or "[]")
        return d

    def update_operation(self, operation_id: str, **fields: Any) -> None:
        _reject_unknown_columns("operations", self._OPERATION_COLS, fields)
        if "status" in fields:
            self.conn.execute(
                "UPDATE operations SET status=? WHERE operation_id=?",
                (fields["status"], operation_id))
        if "provider_task_ref" in fields:
            self.conn.execute(
                "UPDATE operations SET provider_task_ref=? WHERE operation_id=?",
                (fields["provider_task_ref"], operation_id))
        if "provider_asset_refs" in fields:
            refs = fields["provider_asset_refs"]
            if not isinstance(refs, str):
                refs = json.dumps(refs)
            self.conn.execute(
                "UPDATE operations SET provider_asset_refs=? WHERE operation_id=?",
                (refs, operation_id))
        if "reserved_budget" in fields:
            self.conn.execute(
                "UPDATE operations SET reserved_budget=? WHERE operation_id=?",
                (fields["reserved_budget"], operation_id))
        if "observed_cost" in fields:
            self.conn.execute(
                "UPDATE operations SET observed_cost=? WHERE operation_id=?",
                (fields["observed_cost"], operation_id))
        if "error_code" in fields:
            self.conn.execute(
                "UPDATE operations SET error_code=? WHERE operation_id=?",
                (fields["error_code"], operation_id))
        if "notes" in fields:
            self.conn.execute(
                "UPDATE operations SET notes=? WHERE operation_id=?",
                (fields["notes"], operation_id))
        self.conn.execute(
            "UPDATE operations SET last_checked_at=? WHERE operation_id=?",
            (now_iso(), operation_id))
        self.conn.commit()

    def article_operations(self, article_id: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM operations WHERE article_id=? ORDER BY rowid",
            (article_id,)).fetchall()
        return [self._op_row(r) for r in rows]

    # ------------------------------------------------------- 证据/断言
    def add_source(self, src: dict[str, Any]) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO sources (source_id, article_id, url, title, tier,"
            " retrieved_at, content_hash, summary) VALUES (?,?,?,?,?,?,?,?)",
            (src["source_id"], src.get("article_id"), src["url"], src.get("title", ""),
             src.get("tier", 3), src.get("retrieved_at", now_iso()),
             src.get("content_hash", ""), src.get("summary", "")),
        )
        self.conn.commit()

    def add_claim(self, claim: dict[str, Any]) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO claims (claim_id, article_id, text, risk_type,"
            " source_ids, status, verified_at, publish_day_check_required, review_notes)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (claim["claim_id"], claim.get("article_id"), claim["text"],
             claim.get("risk_type", "stable"),
             json.dumps(claim.get("source_ids", [])), claim.get("status", "needs_check"),
             claim.get("verified_at"),
             1 if claim.get("publish_day_check_required") else 0,
             claim.get("review_notes", "")),
        )
        self.conn.commit()

    def article_claims(self, article_id: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM claims WHERE article_id=?", (article_id,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["source_ids"] = json.loads(d.get("source_ids") or "[]")
            d["publish_day_check_required"] = bool(d.get("publish_day_check_required"))
            out.append(d)
        return out

    # ------------------------------------------------------- 模型调用
    def add_invocation(self, inv: dict[str, Any], *, commit: bool = True) -> None:
        self.conn.execute(
            "INSERT INTO model_invocations (invocation_id, job_id, node_key, role,"
            " profile_id, model_id, adapter, attempt, status, request_hash, usage_json,"
            " finish_reason, error, conversation_id, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (inv["invocation_id"], inv.get("job_id"), inv.get("node_key"),
             inv.get("role"), inv.get("profile_id"), inv.get("model_id"),
             inv.get("adapter"), inv.get("attempt", 1), inv.get("status", "ok"),
             inv.get("request_hash", ""),
             json.dumps(inv.get("usage") or {"usage": "unknown"}, ensure_ascii=False),
             inv.get("finish_reason", ""), inv.get("error", ""),
             inv.get("conversation_id", ""), now_iso()),
        )
        if commit:
            self.conn.commit()

    def conversation_invocation_count(self, conversation_id: str) -> int:
        return self.conn.execute(
            "SELECT COUNT(*) FROM model_invocations WHERE conversation_id=?"
            " AND status != 'MODEL_CAPABILITY_MISMATCH'", (conversation_id,)).fetchone()[0]

    def job_invocations(self, job_id: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM model_invocations WHERE job_id=? ORDER BY rowid",
            (job_id,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["usage"] = json.loads(d.pop("usage_json") or "{}")
            out.append(d)
        return out

    # ------------------------------------------------------- artifacts
    def register_artifact(self, artifact_id: str, kind: str, path: Path | str,
                          sha256: str, producer_step: str = "") -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO artifacts (artifact_id, kind, path, sha256,"
            " producer_step, created_at) VALUES (?,?,?,?,?,?)",
            (artifact_id, kind, str(path), sha256, producer_step, now_iso()))
        self.conn.commit()

    def get_artifact(self, artifact_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM artifacts WHERE artifact_id=?", (artifact_id,)).fetchone()
        return dict(row) if row else None
