"""路径安全与运行目录工具。

设计文档 §20.3：文件写入必须规范化并确认真实路径落在批准根目录内，
防止 ``..`` 与符号链接越界；演示代码与内部数据不落 C 盘（§17.1）。
"""
from __future__ import annotations

import os
from pathlib import Path

_FORBIDDEN_DRIVE = "c:"


def normalize(path: str | Path) -> Path:
    """返回绝对化、去 ``..`` 后的规范路径。"""
    return Path(path).expanduser().resolve()


def is_within(child: str | Path, root: str | Path) -> bool:
    """判断 child 规范化后是否位于 root 内（含 root 本身）。"""
    child = normalize(child)
    root = normalize(root)
    try:
        child.relative_to(root)
        return True
    except ValueError:
        return False


def assert_within(child: str | Path, root: str | Path, what: str = "路径") -> None:
    if not is_within(child, root):
        raise PermissionError(
            f"{what}越界：{child} 不在批准根目录 {root} 之内（已阻止）"
        )


def assert_not_c_drive(path: str | Path) -> None:
    """项目铁律：演示代码与内部运行数据不落 C 盘。"""
    drive = normalize(path).drive.lower()
    if drive == _FORBIDDEN_DRIVE:
        raise PermissionError(
            f"拒绝写入 C 盘路径 {path}：项目要求代码与数据保存在 G 盘等数据盘"
        )


def ensure_dir(path: str | Path) -> Path:
    p = normalize(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


def safe_dir_name(raw: str) -> str:
    """把模型产出的目录名清洗为 Windows 合法目录名（§17.1）。"""
    import re

    name = re.sub(r'[\\/:*?"<>|\r\n\t]', "", raw).strip().strip(".")
    reserved = {
        "CON", "PRN", "AUX", "NUL",
        *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }
    if name.upper() in reserved:
        name = name + "-renamed"
    # Windows 路径段上限 255，留余量给后缀
    return name[:120] or "unnamed"


def atomic_write_text(path: str | Path, text: str, encoding: str = "utf-8") -> Path:
    """临时文件写入 + 校验 + 原子替换（§17.4 文件提交协议）。"""
    target = normalize(path)
    import tempfile
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=target.parent)
    tmp = Path(name)
    try:
        with os.fdopen(fd, "w", encoding=encoding, newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)
    return target
