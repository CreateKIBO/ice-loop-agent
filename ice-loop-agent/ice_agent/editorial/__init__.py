"""统一文章编辑器领域模块（M3，报告 §9；04-对照 §3.1）。

职责与边界：
- Markdown 是唯一长期规范值（ADR-005）；这里产出可版本化的 ArticleDocument
  派生模型（稳定块 ID + 图位节点 + raw 块），并可在同一规范化链上把
  受校验 ArticleIR 转为 document/markdown。
- parse 复用 rules.markdown_ast（代码围栏感知、旧图位占位符正则），
  不另写一套正则贯穿整文。
- 未知结构（表格/HTML 等）保留 raw 块原文，不静默重排。
- `<!--RUN_OUTPUT:run-N-->` 兼容保留为 run_output 块，首次迁移不重编号。

本模块不做审批/预算/执行；那是 workflow 与 revisions.save_body 的边界。
"""
from __future__ import annotations

import json
import re
from hashlib import sha256
from typing import Any

from ..rules.markdown_ast import parse_markdown

DOCUMENT_SCHEMA_VERSION = 1

_RUN_OUTPUT_RE = re.compile(r"^<!--RUN_OUTPUT:(run-[A-Za-z0-9_-]+)-->\s*$")
_LIST_ITEM_RE = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$")
_QUOTE_RE = re.compile(r"^\s{0,3}>")


def _block_id(index: int, kind: str, source: str) -> str:
    digest = sha256(f"{kind}\x1f{source}".encode("utf-8")).hexdigest()[:12]
    return f"b{index + 1}-{digest}"


def _slot_from_placeholder(text: str) -> dict[str, Any] | None:
    m = re.match(r"^!\[图(\d+)：(.+?)\]\(待配图：(.+?)｜(.+?)\)\s*$", text.strip())
    if not m:
        return None
    return {"figure_no": int(m.group(1)), "caption": m.group(2),
            "kind": m.group(3).strip(), "obtain": m.group(4).strip()}


def _classify_lines(source: str) -> tuple[str, dict[str, Any]]:
    """多行/单行段落块（非代码）的分类：quote / list / raw / paragraph。"""
    lines = source.split("\n")
    if all(_QUOTE_RE.match(line) for line in lines):
        return "quote", {"lines": lines,
                         "text": "\n".join(line.lstrip().lstrip(">").strip() for line in lines)}
    if all(_LIST_ITEM_RE.match(line) for line in lines):
        items = []
        ordered = True
        for line in lines:
            m = _LIST_ITEM_RE.match(line)
            if not m:
                ordered = False
                break
            items.append(m.group(3))
            if not re.fullmatch(r"\d+[.)]", m.group(2)):
                ordered = False
        if items:
            return "list", {"items": items, "ordered": ordered,
                            "text": "\n".join(items)}
    # 水平分隔线（--- *** ___），与前端 remark thematicBreak 对齐。
    if len(lines) == 1 and re.fullmatch(r"([-*_])\1{2,}\s*", source.strip()):
        return "hr", {"text": source.strip()}
    # 表格/HTML 等未知结构保留 raw（序列化原样返回，不重排）。
    if any(line.lstrip().startswith(("|", "<")) for line in lines):
        return "raw", {"text": source}
    return "paragraph", {"text": source}


def parse_document(markdown: str) -> dict[str, Any]:
    """Markdown → ArticleDocument（块列表；每块带稳定 ID 与原文 source）。"""
    ast = parse_markdown(markdown)
    blocks: list[dict[str, Any]] = []
    for index, block in enumerate(ast.blocks):
        source = block.text if block.kind in ("heading", "paragraph", "image") else "\n".join(block.lines)
        if not source.strip():
            continue
        item: dict[str, Any] = {"block_id": _block_id(index, block.kind, source), "source": source}
        if block.kind == "heading":
            item["type"] = "heading"
            item["level"] = block.level
            item["text"] = block.text
        elif block.kind == "image":
            slot = _slot_from_placeholder(source)
            if slot:
                item["type"] = "image_slot"
                item.update(slot)
            else:
                item["type"] = "image"
                item["text"] = source
        elif block.kind == "code":
            item["type"] = "code"
            item["lang"] = block.lang
            item["lines"] = block.lines
            item["text"] = "\n".join(block.lines)
        elif block.kind == "paragraph":
            run = _RUN_OUTPUT_RE.match(source.strip())
            if run:
                item["type"] = "run_output"
                item["run_ref"] = run.group(1)
            else:
                kind, extra = _classify_lines(source)
                item["type"] = kind
                item.update(extra)
                if "text" not in item:
                    item["text"] = source
        else:
            item["type"] = "raw"
        blocks.append(item)
    return {"schema_version": DOCUMENT_SCHEMA_VERSION, "blocks": blocks}


def _serialize_block(block: dict[str, Any]) -> str:
    kind = block["type"]
    if kind == "heading":
        return "#" * int(block.get("level", 1)) + " " + block["text"]
    if kind in ("paragraph", "image", "raw", "list", "quote"):
        return block["source"]
    if kind == "code":
        lang = block.get("lang") or ""
        return "```" + lang + "\n" + "\n".join(block["lines"]) + "\n```"
    if kind == "image_slot":
        return (f"![图{block['figure_no']}：{block['caption']}]"
                f"(待配图：{block['kind']}｜{block.get('obtain', '见配图方案表')})")
    if kind == "run_output":
        return f"<!--RUN_OUTPUT:{block['run_ref']}-->"
    if block.get("source"):
        return block["source"]
    raise ValueError(f"无法序列化的文档块类型：{kind}")


def _block_fingerprint(block: dict[str, Any]) -> str:
    return sha256(json.dumps({k: v for k, v in block.items() if k != "block_id"},
                             ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def serialize_document(document: dict[str, Any], original_markdown: str | None = None) -> str:
    """ArticleDocument → Markdown。

    未编辑（块与原文一致）时返回原文字节；已编辑时按块确定性地序列化。
    """
    blocks = document.get("blocks") or []
    if original_markdown is not None:
        reparsed = parse_document(original_markdown)
        if [b.get("block_id") for b in reparsed["blocks"]] == [b.get("block_id") for b in blocks] \
                and all(_block_fingerprint(a) == _block_fingerprint(b)
                        for a, b in zip(reparsed["blocks"], blocks)):
            return original_markdown
    return "\n\n".join(_serialize_block(block) for block in blocks)


def block_hashes(document: dict[str, Any]) -> dict[str, str]:
    """block_id → 内容指纹（提案基线校验用）。"""
    return {block["block_id"]: _block_fingerprint(block) for block in document["blocks"]}


# ---------------------------------------------------------------- ArticleIR
IR_BLOCK_TYPES = frozenset({"heading", "paragraph", "list", "quote", "code",
                            "image_slot", "run_output"})


def normalize_ir(ir: dict[str, Any]) -> dict[str, Any]:
    """受校验 ArticleIR → ArticleDocument（同一规范化链；不建第二份正文）。

    校验失败抛 ValueError；调用方（生成路径）在预算内可做一次格式修复，
    随后降级为现有 Markdown 路径，但不得跳过规则/事实/审批检查。
    只接纳已注册节点类型；路径/shell 等键由合同层 extra-forbid 拒绝。
    """
    if not isinstance(ir, dict) or ir.get("ir_version") != 1:
        raise ValueError("ArticleIR 版本不受支持")
    title = ir.get("title")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("IR 缺少标题")
    raw_blocks = ir.get("blocks")
    if not isinstance(raw_blocks, list) or not raw_blocks:
        raise ValueError("IR 缺少正文块")
    blocks: list[dict[str, Any]] = [{
        "block_id": _block_id(0, "heading", title),
        "type": "heading", "level": 1, "text": title.strip(), "source": "# " + title.strip(),
    }]
    for index, raw in enumerate(raw_blocks, start=1):
        blocks.append(_ir_block(raw, index))
    document = {"schema_version": DOCUMENT_SCHEMA_VERSION, "blocks": blocks}
    abstract = ir.get("abstract")
    if isinstance(abstract, str) and abstract.strip():
        document["abstract"] = abstract.strip()
    return document


def _ir_block(raw: Any, index: int) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError(f"IR 第 {index} 块必须是对象")
    kind = raw.get("type")
    if kind not in IR_BLOCK_TYPES:
        raise ValueError(f"IR 第 {index} 块类型未注册：{kind!r}")
    item: dict[str, Any] = {"block_id": _block_id(index, kind, json.dumps(raw, ensure_ascii=False, sort_keys=True))}
    if kind == "heading":
        level = raw.get("level", 2)
        if not isinstance(level, int) or not 2 <= level <= 6:
            raise ValueError("IR 标题层级必须是 2–6（1 级保留给全文标题）")
        text = raw.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("IR 标题文本不能为空")
        item.update({"type": "heading", "level": level, "text": text.strip(),
                     "source": "#" * level + " " + text.strip()})
    elif kind == "paragraph":
        text = raw.get("text")
        if not isinstance(text, str) or not text.strip() or "\n" in text:
            raise ValueError("IR 段落必须是单行非空文本")
        item.update({"type": "paragraph", "text": text, "source": text})
    elif kind == "list":
        ordered = bool(raw.get("ordered", False))
        items = raw.get("items")
        if not isinstance(items, list) or not items or not all(isinstance(i, str) and i.strip() for i in items):
            raise ValueError("IR 列表项不能为空")
        lines = [f"{i + 1}. " + text if ordered else "- " + text
                 for i, text in enumerate(items)]
        item.update({"type": "list", "ordered": ordered, "items": items,
                     "text": "\n".join(items), "source": "\n".join(lines)})
    elif kind == "quote":
        lines = raw.get("lines")
        if not isinstance(lines, list) or not lines or not all(isinstance(i, str) for i in lines):
            raise ValueError("IR 引用内容不能为空")
        quoted = ["> " + line for line in lines]
        item.update({"type": "quote", "text": "\n".join(lines), "source": "\n".join(quoted)})
    elif kind == "code":
        lines = raw.get("lines")
        if not isinstance(lines, list) or not lines or not all(isinstance(i, str) for i in lines):
            raise ValueError("IR 代码行不能为空")
        lang = raw.get("lang", "")
        if not isinstance(lang, str):
            raise ValueError("IR 代码语言必须是字符串")
        item.update({"type": "code", "lang": lang, "lines": lines,
                     "text": "\n".join(lines), "source": "\n".join(lines)})
    elif kind == "image_slot":
        figure_no = raw.get("figure_no")
        caption = raw.get("caption")
        if not isinstance(figure_no, int) or figure_no < 1:
            raise ValueError("IR 图位编号必须是正整数")
        if not isinstance(caption, str) or not caption.strip():
            raise ValueError("IR 图位说明不能为空")
        item.update({"type": "image_slot", "figure_no": figure_no,
                     "caption": caption.strip(), "kind": str(raw.get("kind", "生图")).strip(),
                     "obtain": str(raw.get("obtain", "见配图方案表"))})
    elif kind == "run_output":
        run_ref = raw.get("run_ref")
        if not isinstance(run_ref, str) or not re.fullmatch(r"run-[A-Za-z0-9_-]+", run_ref):
            raise ValueError("IR 运行输出引用必须是 run-xxx")
        item.update({"type": "run_output", "run_ref": run_ref})
    return item


def accept_model_draft(text: str) -> tuple[str, bool]:
    """M6-01：模型草稿可以是 Markdown 或受校验 ArticleIR。

    IR（```json 包裹或纯 JSON，含 ir_version=1）→ normalize_ir → 同一规范化链
    转 Markdown；解析/校验失败 → 原文按 Markdown 处理（安全回退，不跳过
    后续规则/事实/执行/审批检查）。返回 (markdown, ir_used)。
    """
    candidate = (text or "").strip()
    if "ir_version" not in candidate:
        return candidate, False
    extracted = candidate
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", candidate, re.S)
    if fenced:
        extracted = fenced.group(1)
    try:
        ir = json.loads(extracted)
        document = normalize_ir(ir)
        return serialize_document(document), True
    except (ValueError, json.JSONDecodeError):
        return candidate, False


# ---------------------------------------------------------------- Patch 应用
def _match_blocks(base_blocks: list[dict[str, Any]], current_blocks: list[dict[str, Any]]) -> dict[int, int]:
    """SequenceMatcher 对块指纹做对齐：base 序号 → current 序号。"""
    import difflib
    base_fp = [_block_fingerprint(b) for b in base_blocks]
    cur_fp = [_block_fingerprint(b) for b in current_blocks]
    matcher = difflib.SequenceMatcher(a=base_fp, b=cur_fp, autojunk=False)
    mapping: dict[int, int] = {}
    for tag, a1, a2, b1, b2 in matcher.get_opcodes():
        if tag in ("equal", "replace"):
            for offset in range(min(a2 - a1, b2 - b1)):
                mapping[a1 + offset] = b1 + offset
    return mapping


def _make_block(spec: dict[str, Any], index: int) -> dict[str, Any]:
    return _ir_block({"type": spec.get("type", "paragraph"), **spec}, index)


def _rewrite_block(block: dict[str, Any], text: str) -> dict[str, Any]:
    """把块改写为给定文本（保持类型；列表/引用/代码按行拆分）。"""
    kind = block["type"]
    new_block = dict(block)
    new_block["block_id"] = _block_id(0, kind, text)
    if kind == "heading":
        level = block.get("level", 2)
        new_block.update({"text": text.strip(), "source": "#" * level + " " + text.strip()})
    elif kind == "code":
        lines = text.split("\n")
        new_block.update({"lines": lines, "text": text, "source": text})
    elif kind == "quote":
        quoted = ["> " + line for line in text.split("\n")]
        new_block.update({"text": text, "source": "\n".join(quoted)})
    elif kind == "list":
        lines = text.split("\n")
        items = [re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", line) for line in lines]
        new_block.update({"items": items, "text": "\n".join(items), "source": text})
    elif kind == "image_slot":
        slot = _slot_from_placeholder(text)
        if slot:
            new_block.update(slot)
        else:
            # 文本不再是合法占位符 → 退化为普通段落（图位被显式移除）
            new_block = {"block_id": _block_id(0, "paragraph", text), "type": "paragraph",
                         "text": text, "source": text}
    else:
        new_block.update({"text": text, "source": text})
    return new_block


def apply_proposal_ops(base_document: dict[str, Any], current_document: dict[str, Any],
                       ops: list[dict[str, Any]], decisions: list[dict[str, Any]]) -> dict[str, Any]:
    """按逐项决定把提案应用到当前文档；返回 {document, applied, conflicts}。

    冲突规则（M3-07）：基线块在当前稿仍存在且内容未变 → 安全应用；
    块被人工改过（指纹不同）、被删除或找不到 → 记 conflict 交用户处理，
    不无条件覆盖人工新改稿。基线与当前一致时（proposal.base_revision 即
    当前稿）全部匹配，直接应用。
    """
    base_by_id = {b["block_id"]: (i, b) for i, b in enumerate(base_document["blocks"])}
    current_blocks = [dict(b) for b in current_document["blocks"]]
    mapping = _match_blocks(base_document["blocks"], current_blocks)
    applied: list[dict[str, Any]] = []
    conflicts: list[dict[str, Any]] = []

    def decide(entry_ops: list[tuple[int, dict[str, Any], dict[str, Any]]]) -> None:
        for op_index, op, decision in entry_ops:
            entry = {"op_index": op_index, "decision": decision["decision"]}
            if decision["decision"] == "reject":
                applied.append({**entry, "result": "rejected"})
                continue
            base_pos = base_by_id.get(op["block_id"])
            if base_pos is None:
                conflicts.append({**entry, "reason": "基线块不存在"})
                continue
            cur_index = mapping.get(base_pos[0])
            if cur_index is None:
                conflicts.append({**entry, "reason": "目标块已从当前稿删除"})
                continue
            if _block_fingerprint(current_blocks[cur_index]) != op["old_hash"]:
                conflicts.append({**entry, "reason": "目标块已被人工修改，不能覆盖"})
                continue
            if op.get("op") == "delete":
                # 删除图位块只移除正文引用，不动资源候选与原图。
                removed = current_blocks.pop(cur_index)
                applied.append({**entry, "result": "applied",
                                "block_id": removed.get("block_id"), "deleted": True})
                continue
            replacement = dict(current_blocks[cur_index])
            text = decision.get("text", "") if decision["decision"] == "new_text" else op.get("text", "")
            replacement = _rewrite_block(replacement, text)
            current_blocks[cur_index] = replacement
            applied.append({**entry, "result": "applied", "block_id": replacement["block_id"]})

    replace_ops = [(i, op, decisions[i]) for i, op in enumerate(ops) if op.get("op") != "insert_after"]
    decide(replace_ops)
    insert_ops = [(i, op, decisions[i]) for i, op in enumerate(ops) if op.get("op") == "insert_after"]
    # 插入按基线位置倒序处理，避免前插影响后续锚点序号。
    for op_index, op, decision in sorted(insert_ops, key=lambda pair: -pair[0]):
        entry = {"op_index": op_index, "decision": decision["decision"]}
        if decision["decision"] == "reject":
            applied.append({**entry, "result": "rejected"})
            continue
        base_pos = base_by_id.get(op["block_id"])
        if base_pos is None:
            conflicts.append({**entry, "reason": "锚点块不存在"})
            continue
        cur_index = mapping.get(base_pos[0])
        if cur_index is None:
            conflicts.append({**entry, "reason": "锚点块已删除"})
            continue
        new_block = _make_block(op.get("new_block", {}), len(current_blocks))
        if decision["decision"] == "new_text":
            new_block = _rewrite_block(new_block, decision.get("text", ""))
        current_blocks.insert(cur_index + 1, new_block)
        applied.append({**entry, "result": "applied", "block_id": new_block["block_id"]})
    return {"document": {"schema_version": DOCUMENT_SCHEMA_VERSION, "blocks": current_blocks},
            "applied": applied, "conflicts": conflicts}
