"""批次一可信导出回归（R05/R06/R13）：selected_asset、MIME 扩展、相对路径、ready 门。"""
from __future__ import annotations

import io
import json
import unittest
from pathlib import Path

from ice_agent.desktop_service import DesktopService
from ice_agent.export.bundle import (
    export_bundle, export_markdown_with_images, plain_text_with_images,
)
from PIL import Image

from tests import REPO, temp_dir
from tests.test_workflow import demo_spec


def _png_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (16, 16), "#2448DB").save(buffer, format="PNG")
    return buffer.getvalue()


def _jpeg_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (16, 16), "#C23B33").save(buffer, format="JPEG")
    return buffer.getvalue()


class TestTrustedExport(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir("v2-texport-")
        self.service = DesktopService(REPO, self.root / "runtime", self.root / "articles")
        engine, _, store = self.service._app(demo=True)
        try:
            job, article = engine.create_job({**demo_spec(), 'demo': True,
                                              'account_id': 'ice-loop',
                                              'article_root': str(self.root / 'articles')})
            for _ in range(8):
                result = engine.run(job)
                if result['state'] == 'completed':
                    break
                approval = store.pending_approval(job)
                if approval is None:
                    continue
                engine.decide(job, approval['approval_id'], 'approve',
                              expect_hash=approval['content_hash'])
            self.job = job
            self.article_id = article if isinstance(article, str) else article['article_id']
        finally:
            store.close()
        # 导入两张真实已采纳图片（图2、图3）到对应图位。
        self.png_file = self.root / "shot.png"
        self.png_file.write_bytes(_png_bytes())
        self.jpg_file = self.root / "shot.jpg"
        self.jpg_file.write_bytes(_jpeg_bytes())
        engine, _, store = self.service._app(demo=True)
        try:
            slots = sorted(store.article_slots(self.article_id), key=lambda s: s["figure_no"])
            body_slots = [s for s in slots if s.get("kind") == "body_real"] or slots[1:]
            engine.import_asset(self.job, body_slots[0]["figure_no"], self.png_file)
            engine.import_asset(self.job, body_slots[1]["figure_no"], self.jpg_file)
            view = self.service.call("jobs.get", {"job_id": self.job})
            self.view_slots = view["slots"]
            self.body = view["body"]
            self.runs = view["runs"]
        finally:
            store.close()

    def tearDown(self):
        self.service.close()

    def _resolve_figures(self):
        """与 handler 相同的领域解析路径（selected_asset）。"""
        from ice_agent.providers.tapnow import selected_asset, validate_image_file
        figures = []
        _, _, store = self.service._app(demo=True)
        try:
            for slot in sorted(store.article_slots(self.article_id),
                               key=lambda s: s["figure_no"]):
                candidate = selected_asset(store, slot)
                if candidate is None:
                    continue
                ok, mime, _ = validate_image_file(Path(candidate["file_path"]))
                if not ok:
                    continue
                figures.append({"figure_no": slot["figure_no"], "slot_id": slot["slot_id"],
                                "candidate_id": candidate["candidate_id"],
                                "path": candidate["file_path"], "mime": mime,
                                "sha256": candidate["sha256"],
                                "caption": slot.get("caption", "")})
        finally:
            store.close()
        for order, figure in enumerate(figures, start=1):
            figure["order"] = order
        return figures

    def test_real_selected_assets_export_with_mime_extensions(self):
        figures = self._resolve_figures()
        self.assertEqual(len(figures), 2, "两张已采纳图片应被领域解析")
        mimes = {f["figure_no"]: f["mime"] for f in figures}
        self.assertIn("image/png", mimes.values())
        self.assertIn("image/jpeg", mimes.values())
        target = self.root / "005-导出"
        result = export_bundle(
            job_id=self.job, title="示例", body=self.body,
            content_hash="hash-0", figures=figures,
            runs=self.runs, run_refs_status={k: {"ok": True} for k in self.runs},
            allow_ready=False, blocking=[],
            destination=target, mode="draft")
        self.assertTrue((target / "文本" / "01-公众号正文.md").is_file())
        images = sorted((target / "图片").iterdir())
        names = [p.name for p in images]
        self.assertTrue(any(n.endswith(".png") for n in names), names)
        self.assertTrue(any(n.endswith(".jpg") for n in names), names)
        # 正文相对链接：两张已采纳图位替换为 ../图片/xx；其余占位符如实保留
        md = (target / "文本" / "01-公众号正文.md").read_text(encoding="utf-8")
        for name in names:
            self.assertIn(f"../图片/{name}", md)
        self.assertEqual(md.count("../图片/"), 2)
        manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
        remaining = manifest["checks"]["pending_placeholders"]
        self.assertEqual(remaining, md.count("待配图："),
                         "checks 中的占位计数与正文实际一致")
        # manifest：candidate/slot/hash 记录
        manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(len(manifest["images"]), 2)
        for image in manifest["images"]:
            self.assertIn(image["mime"], ("image/png", "image/jpeg"))
            self.assertTrue(image["candidate_id"])

    def test_markdown_rewrite_is_code_fence_safe(self):
        body = (self.body + "\n\n## 附录：图位文本示例\n\n正文里讲解占位符写法：\n\n"
                "```markdown\n![图9：讲解示例](待配图：图示｜仅作演示)\n```\n")
        figures = self._resolve_figures()
        names = {f["figure_no"]: f"{f['order']:02d}-{f['figure_no']:02d}.png" for f in figures}
        exported = export_markdown_with_images(body, names)
        self.assertIn("../图片/", exported)
        # 代码围栏内的同形文本不被替换
        self.assertIn("![图9：讲解示例](待配图：图示｜仅作演示)", exported)
        # 代码内容原样
        self.assertIn("print(", exported)

    def test_txt_notes_images_and_keeps_code(self):
        figures = self._resolve_figures()
        names = {f["figure_no"]: f"{f['order']:02d}-{f['figure_no']:02d}.png" for f in figures}
        txt = plain_text_with_images(self.body, names)
        self.assertIn("见 图片/", txt)
        self.assertIn("print(", txt)

    def test_ready_blocked_by_unresolved_run_reference(self):
        figures = self._resolve_figures()
        body = self.body + "\n\n<!--RUN_OUTPUT:run-not-real-->\n"
        with self.assertRaises(Exception) as ctx:
            export_bundle(
                job_id=self.job, title="t", body=body, content_hash="h",
                figures=figures, runs=self.runs,
                run_refs_status={}, allow_ready=False,
                blocking=["运行证据 run-not-real 失效"],
                destination=self.root / "ready-block", mode="ready")
        self.assertIn("统一校验", str(ctx.exception))

    def test_ready_gate_handler_blocks_unverified_claims(self):
        """handler 层 ready 门：未核验事实/审批基线过期/代码改后证据失效。"""
        _, _, store = self.service._app(demo=True)
        try:
            store.conn.execute(
                "INSERT INTO claims (claim_id, article_id, text, risk_type, status)"
                " VALUES ('cl-x', ?, '额度上限为每月 100 次', 'quota', 'needs_check')",
                (self.article_id,))
            store.conn.commit()
        finally:
            store.close()
        handler_result = self._call_export(mode="ready", expect_error=True)
        self.assertIn("统一校验", str(handler_result))

    def _call_export(self, mode: str, expect_error: bool):
        from ice_agent.export.bundle import ExportBlocked
        target = self.root / f"handler-export-{mode}"
        try:
            return self.service.call("articles.export_bundle", {
                "job_id": self.job, "destination": str(target), "mode": mode})
        except ExportBlocked as exc:
            if expect_error:
                return exc
            raise

    def test_handler_draft_export_uses_domain_assets(self):
        target = self.root / "handler-draft"
        result = self.service.call("articles.export_bundle", {
            "job_id": self.job, "destination": str(target), "mode": "draft"})
        self.assertEqual(result["images"], 2, "handler 必须经 selected_asset 导出已采纳图")
        self.assertTrue((target / "图片").is_dir())

    def test_relative_destination_rejected(self):
        with self.assertRaises(ValueError):
            self.service.call("articles.export_bundle", {
                "job_id": self.job, "destination": "relative/dir", "mode": "draft"})


if __name__ == "__main__":
    unittest.main()
