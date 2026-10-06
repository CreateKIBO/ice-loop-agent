"""Read-only source indexing and explicit, account-scoped publication records."""
from __future__ import annotations

import re
from datetime import date
from pathlib import Path

from .domain.types import new_id, now_iso, sha256_json, sha256_text
from .paths import assert_within, normalize


def section_excerpt(body: str, keywords: str, limit: int = 1400) -> str:
    lines = body.splitlines()
    for i, line in enumerate(lines):
        heading = re.match(r"^(#{2,4})\s+(.+)", line)
        if heading and re.search(keywords, heading[2]):
            end = next((j for j in range(i+1, len(lines)) if re.match(r"^#{1," + str(len(heading[1])) + r"}\s", lines[j])), len(lines))
            return "\n".join(lines[i:end])[:limit]
    return ""


class PublicationHistory:
    def __init__(self, store, account: dict):
        self.store, self.account = store, account
        self.columns = {c["code"] for c in account["columns"]}

    def _index(self, key: str, title: str, body: str, series: str = "", episode=None) -> None:
        row = self.store.conn.execute("SELECT * FROM publication_history WHERE account_id=? AND source_key=?", (self.account["id"], key)).fetchone()
        if row:
            if row["status"] == "published":
                return  # Preserve the content snapshot explicitly registered as published.
            if row["manual_metadata"]:
                series, episode, title = row["series"], row["episode"], row["title"]
            if (row["title"], row["body"], row["series"], row["episode"]) != (title, body, series, episode):
                self.store.conn.execute("UPDATE publication_history SET title=?,body=?,series=?,episode=?,updated_at=? WHERE history_id=?", (title,body,series,episode,now_iso(),row["history_id"]))
        else:
            self.store.conn.execute("INSERT INTO publication_history (history_id,account_id,source_key,series,episode,title,body,updated_at) VALUES (?,?,?,?,?,?,?,?)", (new_id("history"),self.account["id"],key,series,episode,title,body,now_iso()))

    def sync(self) -> None:
        # A local file or a completed workflow is not evidence of publication.
        root_value = self.account.get("library_root", "")
        with self.store.transaction():
            if root_value and Path(root_value).is_dir():
                root = normalize(root_value)
                from .article_library import library_entries
                for entry in library_entries(self.account):
                    folder = Path(entry['file_path']).parent
                    if not folder.is_dir():
                        continue
                    try:
                        assert_within(folder, root)
                        file = next((folder/name for name in ("01-公众号正文-v2.md","01-公众号正文.md","正文.md") if (folder/name).is_file()), None)
                        if not file:
                            continue
                        assert_within(file, root)
                        if file.stat().st_size > 600000:
                            continue
                        body = file.read_text(encoding="utf-8-sig")[:200000]
                        title = next((line[2:].strip() for line in body.splitlines() if line.startswith("# ")), folder.name)
                        headers = [body.splitlines()[0] if body else "", folder.name]
                        for name in ("00-阅读入口.md","02-发布信息与排版说明.md"):
                            info = folder/name
                            if info.is_file() and info.stat().st_size <= 600000:
                                assert_within(info, root)
                                with info.open(encoding="utf-8-sig") as stream:
                                    headers.append(stream.readline()[:500])
                        pattern = r"^\s*(?:#\s*)?(" + "|".join(re.escape(code) for code in sorted(self.columns)) + r")\s*[/／_-]\s*(\d{1,4})(?!\d)"
                        match = next((m for header in headers if (m := re.search(pattern,header))), None)
                        series, episode = (match[1],int(match[2])) if match else (entry['series'],entry['episode'])
                        self._index("library:"+sha256_text(str(file)),title,body,series,episode)
                    except (OSError, UnicodeError, ValueError):
                        # Damaged or escaping files are not included in model context.
                        continue
            import json
            rows = self.store.conn.execute("SELECT * FROM articles ORDER BY created_at").fetchall()
            for row in rows:
                spec = json.loads(row["spec_json"])
                if spec.get("account_id","ice-loop") != self.account["id"] or spec.get("demo") or spec.get('image_only'):
                    continue
                revision = self.store.conn.execute("SELECT content FROM article_revisions WHERE article_id=? AND kind IN ('restore','manual','final','integrated','draft') ORDER BY rowid DESC LIMIT 1", (row["article_id"],)).fetchone()
                body = revision[0] if revision else ""
                self._index("article:"+row["article_id"],row["final_title"] or row["working_title"] or row["topic"],body,row["series"],row["episode"])
            for row in self.store.conn.execute("SELECT * FROM publication_drafts WHERE account_id=?", (self.account["id"],)).fetchall():
                metadata = None
                if self.store.conn.execute("SELECT 1 FROM sqlite_master WHERE name='creative_article_metadata'").fetchone():
                    metadata = self.store.conn.execute('SELECT series,episode FROM creative_article_metadata WHERE account_id=? AND draft_id=?',(self.account['id'],row['draft_id'])).fetchone()
                self._index("draft:"+row["draft_id"],row["title"],row["body"],metadata['series'] if metadata else '',metadata['episode'] if metadata else None)

    def records(self, *, bodies: bool = False) -> list[dict]:
        self.sync()
        rows = self.store.conn.execute("SELECT * FROM publication_history WHERE account_id=? ORDER BY COALESCE(episode,0) DESC,history_id", (self.account["id"],)).fetchall()
        return [{**dict(row), "body":row["body"] if bodies else None,
                 "content_hash":sha256_json(dict(row))} for row in rows]

    def update(self, params: dict) -> dict:
        self.sync()
        row = self.store.conn.execute("SELECT * FROM publication_history WHERE history_id=? AND account_id=?", (params["history_id"],self.account["id"])).fetchone()
        if not row or sha256_json(dict(row)) != params.get("content_hash"):
            raise ValueError("历史记录已变化或不属于当前公众号，请刷新后再登记")
        series, episode, status = params.get("series"), params.get("episode"), params.get("status")
        if series not in self.columns or type(episode) is not int or not 1 <= episode <= 9999 or status not in ("draft","published"):
            raise ValueError("请选择栏目、填写1–9999期号和正确的发布状态")
        title = params.get("title",row["title"])
        if not isinstance(title,str):
            raise ValueError("标题必须是文本")
        title = title.strip()
        if not title or len(title)>300:
            raise ValueError("标题需为1–300字")
        published_at = params.get("published_at", "") if status == "published" else ""
        if status == "published":
            try:
                if date.fromisoformat(published_at) > date.today():
                    raise ValueError()
            except (ValueError,TypeError):
                raise ValueError("请填写实际发布日期，不能晚于今天") from None
        with self.store.transaction():
            current = self.store.conn.execute("SELECT * FROM publication_history WHERE history_id=?",(row["history_id"],)).fetchone()
            if sha256_json(dict(current)) != params["content_hash"]:
                raise ValueError("记录已变化，请刷新")
            self.store.conn.execute("UPDATE publication_history SET series=?,episode=?,title=?,status=?,published_at=?,manual_metadata=1,updated_at=? WHERE history_id=?", (series,episode,title,status,published_at,now_iso(),row["history_id"]))
        return {"ok":True}

    def progress(self, series: str, episode: int) -> dict:
        if series not in self.columns or type(episode) is not int or not 0 <= episode <= 9999:
            raise ValueError("请选择栏目，已发布期号需为0–9999（0表示尚未发布）")
        self.store.conn.execute("INSERT INTO publication_progress VALUES (?,?,?) ON CONFLICT(account_id,series) DO UPDATE SET published_episode=excluded.published_episode", (self.account["id"],series,episode))
        self.store.conn.commit()
        return self.context(series)

    def context(self, series: str, episode: int | None = None) -> dict:
        if series not in self.columns:
            raise ValueError("请选择当前公众号的栏目")
        records = self.records(bodies=True)
        relevant = [row for row in records if row["series"] == series]
        published = sorted((row for row in relevant if row["status"]=="published"),key=lambda row:(row["episode"],row["published_at"]),reverse=True)
        progress = self.store.conn.execute("SELECT published_episode FROM publication_progress WHERE account_id=? AND series=?", (self.account["id"],series)).fetchone()
        maximum = max([row["episode"] for row in published]+[progress[0] if progress else 0])
        target = episode if episode is not None else maximum+1
        if type(target) is not int or not 1 <= target <= 10000:
            raise ValueError('拟题期号需为1–9999')
        # Only preceding articles in this series. Published snapshots win over
        # alternate drafts for the same issue; do not pass future bodies.
        preceding = sorted((row for row in relevant if row['episode'] is not None and row['episode']<target and row['body'].strip()),
                           key=lambda row:(row['episode'],row['status']=='published',row['updated_at'],row['history_id']),reverse=True)
        chosen=[];seen=set()
        for row in preceding:
            if row['episode'] not in seen:
                chosen.append(row);seen.add(row['episode'])
            if len(chosen)==5:break
        latest = next((row for row in chosen if row['episode']==target-1),None)
        history = [{"history_id":row["history_id"],"title":row["title"],"series":row["series"],"episode":row["episode"],"status":row["status"],
                    "body_excerpt":row["body"],"ending_excerpt":section_excerpt(row["body"],"写在最后|结语|总结|下期",1400)} for row in chosen]
        context_hash = sha256_json({"account":self.account,"series":series,"progress":maximum,
                                   "records":[(r["history_id"],r["content_hash"]) for r in relevant]})
        return {"account_id":self.account["id"],"series":series,"last_published_episode":maximum,
                "next_episode":maximum+1 if maximum<9999 else None,"context_hash":context_hash,
                "reference_episode":target,"history":history,
                "known_titles":[{"history_id":r["history_id"],"title":r["title"],"series":r["series"],"episode":r["episode"],"status":r["status"]} for r in relevant],
                "body_history_count":len(history),"title_history_count":len(relevant),
                "previous_status":latest['status'] if latest else '',
                "previous_exercise":section_excerpt(latest["body"],"动手|练习|挑战|试一试") if latest else "",
                "previous_preview":section_excerpt(latest["body"],"写在最后|结语|总结|下期") if latest else "",
                "published_count":len(published),"draft_count":sum(row["status"]!="published" for row in relevant),
                "same_episode_drafts":sum(row["status"]!="published" and row["episode"]==target for row in relevant)}
