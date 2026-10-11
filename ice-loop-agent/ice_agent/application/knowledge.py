"""知识检索 RPC handler（M4-01/02/03/04/05/06/09）。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .. import knowledge
from . import Handler, register


@register
class KnowledgeHandler(Handler):
    METHODS = frozenset({
        "knowledge.import", "knowledge.search", "knowledge.sources",
        "knowledge.source_delete", "knowledge.reindex", "knowledge.context_pack",
        "knowledge.duplicate_topics", "knowledge.chunk",
    })

    def handle(self, method: str, params: dict) -> Any:
        return getattr(self, "_" + method.replace(".", "_"))(params)

    def _account(self) -> dict:
        return self.service._account()

    def _store(self):
        _, _, store = self.service._app()
        return store

    def _knowledge_import(self, params: dict) -> dict:
        file_path = params.get("file_path")
        if not isinstance(file_path, str) or not file_path.strip():
            raise ValueError("请选择要导入的文件")
        store = self._store()
        try:
            result = knowledge.import_source(
                store, self._account()["id"], Path(file_path),
                display_name=params.get("display_name"))
        finally:
            store.close()
        return result

    def _knowledge_search(self, params: dict) -> dict:
        store = self._store()
        try:
            return knowledge.search(
                store, self._account()["id"], str(params.get("query", "")),
                limit=int(params.get("limit", 20)), offset=int(params.get("offset", 0)),
                source_id=params.get("source_id"), origin=params.get("origin"))
        finally:
            store.close()

    def _knowledge_sources(self, _params: dict) -> list[dict]:
        store = self._store()
        try:
            return knowledge.sources_list(store, self._account()["id"])
        finally:
            store.close()

    def _knowledge_source_delete(self, params: dict) -> dict:
        source_id = params.get("source_id")
        if not isinstance(source_id, str) or not source_id:
            raise ValueError("请选择要删除的来源")
        store = self._store()
        try:
            knowledge.delete_source(store, self._account()["id"], source_id)
            return {"deleted": True}
        finally:
            store.close()

    def _knowledge_reindex(self, _params: dict) -> dict:
        store = self._store()
        try:
            return {"rebuilt": knowledge.reindex_pending(store)}
        finally:
            store.close()

    def _knowledge_chunk(self, params: dict) -> dict:
        chunk_id = params.get("chunk_id")
        if not isinstance(chunk_id, str) or not chunk_id:
            raise ValueError("缺少引文标识")
        store = self._store()
        try:
            return knowledge.get_chunk(store, self._account()["id"], chunk_id)
        finally:
            store.close()

    def _knowledge_context_pack(self, params: dict) -> dict:
        account = self._account()
        store = self._store()
        try:
            rules = account.get("article") or {}
            import json as _json
            rules_text = _json.dumps(rules, ensure_ascii=False) if isinstance(rules, dict) else str(rules)
            history_context = ""
            series = params.get("series")
            if series:
                history = self.service._history(store)
                context = history.context(str(series), params.get("episode"))
                history_context = _json.dumps({
                    "series": context["series"],
                    "next_episode": context["next_episode"],
                    "body_history_count": context["body_history_count"],
                    "title_history_count": context["title_history_count"],
                    "previous_exercise": context["previous_exercise"][:300],
                    "previous_preview": context["previous_preview"][:300],
                }, ensure_ascii=False)
            return knowledge.build_context_pack(
                store, account["id"],
                brief=str(params.get("brief", ""))[:4000],
                citations=params.get("citations"),
                retrieval=params.get("retrieval"),
                history_context=history_context,
                account_rules=rules_text)
        finally:
            store.close()

    def _knowledge_duplicate_topics(self, params: dict) -> dict:
        """重复选题检查（M4-09）：确定性规则+检索命中，解释原因，不阻止用户。"""
        title = str(params.get("title", "")).strip()
        if not title or len(title) > 200:
            raise ValueError("请提供要检查的标题")
        account_id = self._account()["id"]
        store = self._store()
        try:
            from ..publication_history import PublicationHistory
            history = PublicationHistory(store, self._account())
            records = history.records(bodies=True)
            existing = [(row["history_id"], row["title"], row["series"], row["episode"])
                        for row in records if row["title"]]
            # 历史正文先入知识索引（origin=article，hash 不变跳过），检索才有依据。
            for row in records:
                if row.get("body", "").strip():
                    knowledge.sync_article_source(
                        store, account_id, "history:" + row["history_id"], row["body"],
                        revision_id=row.get("content_hash"),
                        display_name=f"{row['title']}"[:200])
            hits: list[dict[str, Any]] = []
            for history_id, existing_title, series, episode in existing:
                reason = None
                if existing_title.strip() == title:
                    reason = "完全同名"
                elif len(title) >= 4 and title in existing_title:
                    reason = "已有标题包含该题目"
                elif len(existing_title) >= 4 and existing_title in title:
                    reason = "该题目包含已有标题"
                if reason:
                    hits.append({"reason": reason, "history_id": history_id,
                                 "title": existing_title, "series": series, "episode": episode})
            retrieval = knowledge.search(store, account_id, title, limit=5)["results"]
            for item in retrieval:
                if not any(h.get("chunk_id") == item["chunk_id"] for h in hits):
                    hits.append({"reason": "检索命中相似内容", "chunk_id": item["chunk_id"],
                                 "title": item["display_name"], "series": "",
                                 "section": item["section"], "snippet": item["marked"][:200]})
            return {"title": title, "hits": hits[:12],
                    "note": "相似提示仅供参考，你可以坚持选题"}
        finally:
            store.close()
