"""M4-10 离线评测：1000 篇合成文章索引与检索性能（脱敏数据，全部本地）。"""
from __future__ import annotations

import json
import statistics
import time
import unittest
from pathlib import Path

from ice_agent.desktop_service import DesktopService
from ice_agent.knowledge import import_source, search

from tests import temp_dir

ACCOUNTS = ["acct-a", "acct-b", "acct-c"]
SERIES = ["PY", "JV", "AI", "WK", "DS", "OS", "NET", "DB", "WEB", "ML", "TOOL", "GAME"]
ARTICLES_PER_SERIES = 84  # 12 栏目 × 84 篇 ≈ 1008 篇
QUERIES_LONG = ["九九乘法表", "变量与数据类型", "函数的参数传递", "列表切片操作",
                "字典遍历方法", "字符串格式化", "异常处理机制", "文件读写操作",
                "类的继承用法", "模块导入方式", "装饰器原理", "生成器表达式"] * 3
QUERIES_SHORT = ["变量", "循环", "函数", "列表", "字典"] * 6


class TestKnowledgeEval(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = temp_dir("v2-keval-")
        cls.service = DesktopService(cls.dir / "projects", runtime_root=cls.dir / "runtime")
        cls.account_id = "acct-a"
        cls.store = None
        _, _, store = cls.service._app()
        cls.store = store
        # 三账号域各放一份不同账号的样本，用于隔离断言
        t0 = time.perf_counter()
        cls.index_seconds = None
        for series in SERIES:
            for episode in range(1, ARTICLES_PER_SERIES + 1):
                body = cls._article_body(series, episode)
                target = cls.dir / f"{series}-{episode:03d}.md"
                target.write_text(body, encoding="utf-8")
                import_source(store, "acct-a", target)
        cls.index_seconds = time.perf_counter() - t0
        # 隔离样本挂在另外两个账号
        other = cls.dir / "other.md"
        other.write_text("账号B的独有内容：列表切片操作。", encoding="utf-8")
        import_source(store, "acct-b", other)
        third = cls.dir / "third.md"
        third.write_text("账号C的独有内容：装饰器原理。", encoding="utf-8")
        import_source(store, "acct-c", third)

    @classmethod
    def tearDownClass(cls):
        if cls.store:
            cls.store.close()
        cls.service.close()

    @staticmethod
    def _article_body(series: str, episode: int) -> str:
        topics = ["变量与数据类型", "九九乘法表", "函数的参数传递", "列表切片操作",
                  "字典遍历方法", "字符串格式化", "异常处理机制", "文件读写操作",
                  "类的继承用法", "模块导入方式", "装饰器原理", "生成器表达式"]
        topic = topics[episode % len(topics)]
        return (f"# {series} 第{episode:03d}篇：{topic}\n\n"
                f"## 一、概念\n\n{topic}是本篇核心。第 {episode} 期会用九九乘法表演示循环。\n\n"
                f"```python\n# {series}-{episode}\nprint('hello {episode}')\n```\n\n"
                f"## 二、练习\n\n用{topic}写一个小程序，注意变量命名。\n")

    def test_index_scale_and_latency(self):
        count = self.store.conn.execute(
            "SELECT COUNT(*) FROM knowledge_chunks WHERE account_id=?", (self.account_id,)).fetchone()[0]
        self.assertGreaterEqual(count, 1000, "1000+ 篇文章应产生至少千级分块")
        # 索引耗时随 G 盘 exFAT 负载波动大（专项实测 56.5s，全量高负载下 153s），
        # 不是验收目标本身——验收是查询 P95（见下）；此处只防灾难性回退。
        self.assertLess(self.index_seconds, 600, "索引构建出现灾难性回退")

        def measure(queries, min_hits=None):
            samples = []
            misses = 0
            for query in queries:
                t0 = time.perf_counter()
                result = search(self.store, self.account_id, query, limit=20)
                samples.append(time.perf_counter() - t0)
                if min_hits and not result["results"]:
                    misses += 1
            samples.sort()
            return {
                "p50_ms": round(statistics.median(samples) * 1000, 2),
                "p95_ms": round(samples[int(len(samples) * 0.95) - 1] * 1000, 2),
                "max_ms": round(samples[-1] * 1000, 2),
                "misses": misses,
            }

        long_stats = measure(QUERIES_LONG, min_hits=True)
        short_stats = measure(QUERIES_SHORT)
        report = {
            "articles": len(SERIES) * ARTICLES_PER_SERIES,
            "chunks": count,
            "index_seconds": round(self.index_seconds, 2),
            "long_query": long_stats,
            "short_query": short_stats,
            "accounts": ACCOUNTS,
            "dataset": "synthetic-offline",
        }
        # 验收目标：标准库 SQLite 上长查询 P95 ≤ 1s（报告 §18.1），本地实测应远低于该值
        self.assertLess(long_stats["p95_ms"], 1000)
        self.assertEqual(long_stats["misses"], 0, "固定正样例查询不应全部落空")
        out = Path(self.dir) / "knowledge-eval.json"
        out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    def test_account_isolation_at_scale(self):
        mine = search(self.store, "acct-a", "装饰器原理", limit=100)
        self.assertTrue(mine["results"])
        other = search(self.store, "acct-b", "装饰器原理", limit=100)
        for row in other["results"]:
            self.assertNotIn("装饰器原理", row["text"], "B 账号不应看到 A 的独有内容")
            self.assertEqual(row["account_id"], "acct-b")


if __name__ == "__main__":
    unittest.main()
