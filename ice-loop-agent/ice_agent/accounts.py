"""Portable, non-secret publication profiles and their deterministic rule adapter."""
from __future__ import annotations

import copy
import re
from pathlib import Path

from .config import load_profile
from .domain.types import new_id
from .paths import assert_not_c_drive, normalize


def default_account(root: Path, runtime: Path, article_root: str) -> dict:
    return {"id": "ice-loop", "preset": "ice-loop", "name": "ICE Loop",
            "positioning": "用 Python、Java 与 AI，把想法做成可运行作品的学习品牌",
            "audience": "零基础在校学生", "persona": "冷静、准确、开放、有耐心",
            "slogan": "可执行的想象。", "colors": "#2448DB, #15191F, #F3F2ED",
            "image_style": "restrained flat editorial; no 3D, gradients or shadows",
            "ending_heading": "写在最后", "closing_sentence": "**可执行的想象，从{X}开始。**",
            "words_range": [1800, 2600], "banned_words": load_profile()["banned_brand_words"],
            "columns": [{"code": code, "name": value["name"]} for code, value in load_profile()["series"].items()],
            "brand_document": "", "article_root": article_root,
            "library_root": str(root.parent.parent / "output" / "文章")}


def normalize_account(data: dict, runtime: Path, *, account_id: str | None = None) -> dict:
    if not isinstance(data, dict):
        raise ValueError("公众号配置必须是对象")
    aid = account_id or new_id("account")
    result = {"id": aid, "preset": "ice-loop" if aid == "ice-loop" and data.get("preset") == "ice-loop" else "general"}
    defaults = {"name": "", "positioning": "", "audience": "", "persona": "自然、准确、清晰",
                "slogan": "", "colors": "#2448DB, #15191F, #F3F2ED", "image_style": "flat editorial",
                "ending_heading": "写在最后", "closing_sentence": "", "brand_document": ""}
    for key, default in defaults.items():
        value = data.get(key, default)
        maximum = 20000 if key == "brand_document" else 2000 if key == "positioning" else 500
        if not isinstance(value, str) or len(value) > maximum:
            raise ValueError(f"{key} 需为不超过 {maximum} 字的文本")
        result[key] = value.strip()
    if not result["name"] or not result["audience"]:
        raise ValueError("请填写公众号名称和目标读者")
    if result["preset"] == "ice-loop" and result["name"] != "ICE Loop":
        result["preset"] = "general"
    if not result["ending_heading"] or len(result["ending_heading"]) > 50:
        raise ValueError("结尾标题需为 1–50 字")
    if not re.fullmatch(r"#[0-9a-fA-F]{6}(?:\s*,\s*#[0-9a-fA-F]{6}){0,5}", result["colors"]):
        raise ValueError("品牌色请填写 1–6 个 HEX 色值，以逗号分隔，如 #2448DB, #15191F")
    words = data.get("words_range", [1200, 2400])
    if not isinstance(words, list) or len(words) != 2 or any(type(n) is not int for n in words) or not 300 <= words[0] <= words[1] <= 10000:
        raise ValueError("字数区间需为 300–10000 内的两个整数，最小值不大于最大值")
    result["words_range"] = words
    columns = data.get("columns", [{"code": "ART", "name": "日常文章"}])
    if not isinstance(columns, list) or not 1 <= len(columns) <= 12:
        raise ValueError("请设置 1–12 个栏目")
    result["columns"] = []
    for column in columns:
        if not isinstance(column, dict) or not isinstance(column.get("code"), str) or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,11}", column["code"]):
            raise ValueError("栏目代码需为 1–12 位大写字母、数字或下划线，并以字母开头")
        name = column.get("name", "")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60:
            raise ValueError("栏目名称需为 1–60 字")
        result["columns"].append({"code": column["code"], "name": name.strip()})
    if len({c["code"] for c in result["columns"]}) != len(columns):
        raise ValueError("栏目代码不能重复")
    banned = data.get("banned_words", [])
    if not isinstance(banned, list) or len(banned) > 100 or any(not isinstance(w, str) or not 1 <= len(w) <= 60 for w in banned):
        raise ValueError("禁用词需为最多 100 项的文字列表，单项 1–60 字")
    result["banned_words"] = banned
    for key in ("article_root", "library_root"):
        value = data.get(key, "")
        if not isinstance(value, str) or len(value) > 1000:
            raise ValueError("目录路径无效")
        value = value.strip()
        if not value and key == "article_root":
            value = str(runtime / "articles" / aid)
        if value:
            if not Path(value).is_absolute():
                raise ValueError("目录请填写绝对路径")
            path = normalize(value)
            assert_not_c_drive(path)
            value = str(path)
        result[key] = value
    return result


def profile_from_account(account: dict) -> dict:
    profile = copy.deepcopy(load_profile())
    profile["profile_version"] = 2
    profile["brand"] = {"name": account["name"], "persona": account["persona"],
                        "slogan": account["slogan"], "colors": [c.strip() for c in account["colors"].split(",")],
                        "positioning": account["positioning"], "audience": account["audience"],
                        "image_style": account["image_style"], "document": account["brand_document"]}
    profile["series"] = {c["code"]: {"name": c["name"], "cover_template": ""} for c in account["columns"]}
    profile["article"]["words_range"] = account["words_range"]
    profile["article"]["required_ending_heading"] = account["ending_heading"]
    profile["article"]["brand_sentence_pattern"] = account["closing_sentence"]
    profile["banned_brand_words"] = account["banned_words"]
    if account["preset"] == "ice-loop":
        for code, value in load_profile()["series"].items():
            if code in profile["series"]:
                profile["series"][code]["cover_template"] = value["cover_template"]
        return profile
    profile["profile"] = "publication"
    profile["banned_ai_phrases"] = []
    profile["banned_patterns"] = []
    profile["banned_punctuation"] = {"dash": "——", "curly_quotes": [], "emotional": []}
    profile["wk_extra_rules"] = {}
    profile["article"].update(code_blocks=[0, 12], code_block_max_lines=200, key_comment_lines=[0, 200],
                              ending_triad={key: "" for key in profile["article"]["ending_triad"]},
                              numbered_headings=False, max_dash=10000, max_not_but_is_pattern=10000,
                              min_short_paragraphs=0)
    return profile
