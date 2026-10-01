"""文章包导出器（§21 文章目录契约）。

- 目录：NNN-标题/ 下 00-阅读入口 / 01-公众号正文 / 02-发布信息与排版说明 /
  03-配图提示词（有生图需求时）+ code/ + images/；
- 编号扫描后事务预留（不认定同编号文件夹不存在）；
- 草稿包允许占位符与待办；就绪包要求 final_check 全绿；
- 写入走临时文件 + 原子替换；外部手改通过 hash 比对检测冲突（§17.4）。
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from ..domain.types import now_iso
from ..paths import atomic_write_text, ensure_dir, normalize, safe_dir_name
from ..workflow.nodes import NodeFailed, evidence_errors
from ..providers.tapnow import selected_asset


class ExportConflict(Exception):
    pass


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ArticleExporter:
    def __init__(self, article_root: Path, store, conflict_guard: bool = True):
        self.article_root = normalize(article_root)
        self.store = store
        self.conflict_guard = conflict_guard

    def __call__(self, ctx) -> dict[str, Any]:
        state = ctx.state
        article = ctx.article
        final_title = state.get("final_title") or state.get("working_title", "")
        readiness = article.get("readiness", "draft")
        final_report = state.get("final_check_report") or {}
        if readiness == "ready_for_publish" and not final_report.get("ready"):
            raise NodeFailed("export", "EXPORT_STATE_MISMATCH",
                             "就绪导出前 final_check 必须通过")
        if readiness == "ready_for_publish":
            integrity = evidence_errors(state.get("integrated_md", ""), state.get("runs", {}))
            if integrity:
                raise NodeFailed("export", "EVIDENCE_MISMATCH", "；".join(integrity))
        folder_no = article.get("folder_no")
        if folder_no is None:
            folder_no = self.store.reserve_folder(article["article_id"], self.article_root)
        folder_name = f"{folder_no:03d}-{safe_dir_name(final_title)}"
        target = ensure_dir(self.article_root / folder_name)
        code_dir = ensure_dir(target / "code")
        ensure_dir(target / "images")

        # 冲突守卫：上次导出后用户手改过则拒绝覆盖（§17.4）
        if self.conflict_guard:
            manifest_path = target / ".ice-export-manifest.json"
            if manifest_path.exists():
                old = json.loads(manifest_path.read_text(encoding="utf-8"))
                for rel, old_hash in old.get("files", {}).items():
                    f = target / rel
                    if f.exists() and _sha256_file(f) != old_hash:
                        raise ExportConflict(
                            f"导出冲突：{f} 在上次导出后被外部修改，"
                            "请先比对差异（另存候选或确认替换）")

        series = state.get("series", article.get("series", ""))
        episode = state["spec"].get("episode", 0)
        files: dict[str, str] = {}

        # 已采纳图片：复制进包并把正文占位符替换为真实引用（§21.2 就绪包）
        import shutil as _shutil
        figure_files: dict[int, str] = {}
        for slot in self.store.article_slots(article["article_id"]):
            selected = selected_asset(self.store, slot)
            if readiness == "ready_for_publish" and slot.get("required", True) and not selected:
                raise NodeFailed("export", "ASSET_MISSING", f"图{slot['figure_no']} 缺少有效的选中资产")
            if selected:
                src = Path(selected["file_path"])
                if src.exists():
                    dest_name = f"figure-{slot['figure_no']:02d}{src.suffix.lower()}"
                    _shutil.copy2(src, target / "images" / dest_name)
                    figure_files[slot["figure_no"]] = f"images/{dest_name}"

        files["01-公众号正文.md"] = _body_doc(state, final_title, figure_files)
        files["02-发布信息与排版说明.md"] = _publish_doc(ctx, state, final_title,
                                                        series, episode)
        files["00-阅读入口.md"] = _entry_doc(ctx, state, final_title, series,
                                             episode, readiness, figure_files)
        prompt_slots = [s for s in state.get("slots", [])
                        if s.get("prompt") or s.get("kind") == "cover"]
        if prompt_slots:
            files["03-配图提示词.md"] = _prompt_doc(state, prompt_slots, series)

        for name, content in files.items():
            atomic_write_text(target / name, content)
        for run_id, rec in (state.get("runs") or {}).items():
            src_name = rec.get("filename", f"{run_id}.py")
            atomic_write_text(code_dir / src_name, _code_source(state, run_id))
        (target / "images" / "README.md").write_text(
            "本目录存放经审核的发布图。实截类图片由用户截图后导入；"
            "生图类按 03 文件 P 编号提示词生成后导入（ice-agent import-asset）。\n",
            encoding="utf-8")

        manifest = {"folder_no": folder_no, "final_title": final_title,
                    "readiness": readiness,
                    "files": {str(file.relative_to(target)).replace("\\", "/"): _sha256_file(file)
                              for file in target.rglob("*") if file.is_file()
                              and file.name != ".ice-export-manifest.json"}}
        atomic_write_text(target / ".ice-export-manifest.json",
                          json.dumps(manifest, ensure_ascii=False, indent=2))
        self.store.update_article(article["article_id"], folder_no=folder_no,
                                  folder_name=folder_name)
        return {"folder": str(target), "files": sorted(files),
                "readiness": readiness, "folder_no": folder_no,
                "images": sorted(figure_files.values())}


def _code_source(state: dict[str, Any], run_id: str) -> str:
    """code/ 文件正文取自 draft 代码块（与 run 的 code_sha256 对应）。"""
    record = (state.get("runs") or {}).get(run_id, {})
    if record.get("source"):
        return record["source"]
    import re
    from ..rules import parse_markdown
    from ..rules.structural import executable_code_blocks
    draft = state.get("integrated_md", "")
    blocks = executable_code_blocks(parse_markdown(draft))
    ordered = sorted((state.get("runs") or {}).keys())
    idx = ordered.index(run_id) if run_id in ordered else None
    if idx is not None and idx < len(blocks):
        return "\n".join(blocks[idx].lines) + "\n"
    return (state.get("runs") or {}).get(run_id, {}).get("source", "")


# ------------------------------------------------------------- 文档模板


_PLACEHOLDER_LINE = re.compile(r"^!\[图(\d+)：(.+?)\]\(待配图：.+?\)\s*$")


def _body_doc(state: dict[str, Any], final_title: str,
              figure_files: dict[int, str] | None = None) -> str:
    text = state.get("integrated_md", "")
    figure_files = figure_files or {}

    def _replace(m):
        no = int(m.group(1))
        ref = figure_files.get(no)
        if ref:
            return f"![图{no}：{m.group(2)}]({ref})"
        return m.group(0)     # 未就绪图位保留占位符（草稿包）

    out = []
    for ln in text.splitlines():
        m = _PLACEHOLDER_LINE.match(ln)
        out.append(_replace(m) if m else ln)
    return "\n".join(out).strip() + "\n"


def _entry_doc(ctx, state: dict[str, Any], title: str, series: str,
               episode: int, readiness: str,
               figure_files: dict[int, str] | None = None) -> str:
    runs = state.get("runs") or {}
    todos = state.get("assets_todo") or []
    final = state.get("final_check_report") or {}
    figure_files = figure_files or {}
    lines = [
        f"# 阅读入口：{title}",
        "",
        f"- 栏目：{series} / {episode:03d}（{ctx.cfg.profile.get('series', {}).get(series, {}).get('name', series)}）",
        f"- 状态：{readiness}（{('可进入公众号预览' if final.get('ready') else '草稿/待补图')}）",
        f"- 导出时间：{now_iso()}",
        "",
        "## 事实与验证记录",
        "",
        "| 运行 | 文件 | 退出码 | 判定 | 输出摘要 |",
        "|---|---|---|---|---|",
    ]
    for rid, rec in sorted(runs.items()):
        excerpt = (rec.get("stdout") or "").strip().splitlines()
        first = excerpt[0][:30] if excerpt else ""
        lines.append(
            f"| {rid} | {rec.get('filename')} | {rec.get('exit_code')} | "
            f"{rec.get('verdict')} | {first} |")
    claims = ctx.store.article_claims(ctx.article["article_id"])
    if claims:
        lines += ["", "已登记断言："]
        for c in claims:
            lines.append(f"- [{c['status']}] {c['text'][:60]}")
    lines += ["", "## 待办", ""]
    if figure_files:
        lines.append(f"- 已就绪图片：{len(figure_files)} 张（正文引用 images/ 文件）")
    pending_todos = [t for t in todos
                     if int(str(t.get("figure", "图0")).replace("图", "") or 0)
                     not in figure_files]
    if pending_todos:
        for t in pending_todos:
            lines.append(f"- 图{t.get('figure', '')}：{t['action']}")
    else:
        lines.append("-（无）")
    blocking = (final.get("rules", {}).get("report", {}).get("blocking")) or []
    if blocking:
        lines += ["", "## 阻断项（就绪前必须修复）", ""]
        for b in blocking:
            lines.append(f"- {b['message']}")
    return "\n".join(lines) + "\n"


def _publish_doc(ctx, state: dict[str, Any], title: str, series: str,
                 episode: int) -> str:
    rows = state.get("titles_table") or []
    abstract = state.get("abstract", "")
    slots = state.get("slots") or []
    lines = [
        "# 发布信息与排版说明",
        "",
        "## 标题工坊评分表",
        "",
        "| 候选 | 机制 | 清晰度 | 点击理由 | 具体性 | 悬念质量 | 可信度 | 总分 |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for c in rows:
        s = c.get("scores", {})
        lines.append(
            f"| {c.get('title')} | {c.get('mechanism', '')} "
            f"| {s.get('清晰度', '-')} | {s.get('点击理由', '-')} "
            f"| {s.get('具体性', '-')} | {s.get('悬念质量', '-')} "
            f"| {s.get('可信度', '-')} | {c.get('total', '-')} |")
    rules = ctx.cfg.profile["article"]
    general = ctx.cfg.profile.get("profile") != "ice-loop"
    lines += [
        "",
        f"主选：{title}",
        f"主选理由：{state.get('titles_reason') or '与排期表预设、上篇预告、封面标题三重一致。'}",
        "",
        "## 摘要",
        "",
        abstract or "（待生成）",
        "",
        "## 配图方案表",
        "",
        "| 编号 | 插入位置 | 内容 | 类型 | 获取方式 |",
        "|---|---|---|---|---|",
    ]
    for s in slots:
        kind = {"cover": "氛围", "body_real": "实截",
                "body_diagram": "图示", "atmosphere": "氛围"}.get(s["kind"], s["kind"])
        obtain = {"cover_template": "品牌模板改字", "generate": "生图（P编号）",
                  "manual": "实截/手动"}.get(s.get("obtain"), s.get("obtain", ""))
        p_no = f"P{s['prompt_no']}" if s.get("prompt_no") else ""
        lines.append(
            f"| 图{s['figure_no']} | {s['position']} | {s['caption']} "
            f"| {kind} | {obtain}{p_no} |")
    lines += [
        "",
        "## 发稿前检查清单",
        "",
        f"- [ ] 标题 ≤{rules['title_max_chars']} 字，标题承诺与正文一致",
        f"- [ ] 摘要 {rules['abstract_chars'][0]}-{rules['abstract_chars'][1]} 字",
        f"- [ ] 正文唯一一级标题；开头段无小标题；结尾「{rules['required_ending_heading']}」",
        "- [ ] 如有演示代码，真实运行输出已核对" if general else "- [ ] 演示代码 1-3 块，单块 ≤20 行，真实运行输出已核对",
        "- [ ] 结尾符合当前公众号规范" if general else "- [ ] 文末三件套：ICE 循环回顾 + 下期预告（含参考答案承诺）+ 关注引导",
        f"- [ ] 配置的品牌句「{rules.get('brand_sentence_pattern', '')}」已核对" if rules.get('brand_sentence_pattern') else "- [ ] 关注引导按实际运营需要填写",
        "- [ ] 所有配图就位（占位符已替换为真实图片）",
    ]
    if series == "WK" and not general:
        lines += [
            "- [ ] 工具类零价格零额度数字，「以官网为准」已标注",
            "- [ ] 发文当天核验四个官网",
        ]
    lines += [
        "- [ ] 高风险字段（版本/价格/模型名）当天核验",
        "- [ ] mdnice/壹伴排版后手机预览，勾原创 + 合集标签",
        "",
        "## 排版参数",
        "",
        "16-17px、1.8 倍行高、段间空行、图片通栏原比例、代码块可复制。",
    ]
    return "\n".join(lines) + "\n"


def _prompt_doc(state: dict[str, Any], prompt_slots: list[dict[str, Any]],
                series: str) -> str:
    lines = ["# 配图提示词", ""]
    for s in prompt_slots:
        if s.get("kind") == "cover":
            lines += [f"## 封面（图{s['figure_no']}）", "",
                      "```text", state.get("cover_prompt", ""), "```", ""]
        elif s.get("prompt"):
            p = s["prompt_no"]
            lines += [f"## P{p}（图{s['figure_no']}：{s['caption']}）", "",
                      "```text", s["prompt"], "```", ""]
    lines += [
        "说明：提示词按 use case → 画布 → 配色/参考 → exactly 文字 → 布局 → 风格 → 禁止清单组织。"
        "配色和风格使用本篇创建时保存的公众号配置；头像仅作参考。",
    ]
    return "\n".join(lines) + "\n"
