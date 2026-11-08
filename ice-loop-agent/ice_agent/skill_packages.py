"""v3.15 写作技能的导入与导出（可插拔技能方案 §4）。

只处理文本：单个 Markdown 文件，或包含 SKILL.md（可选 skill.json）的 ZIP 包。
不安装依赖、不运行包里的脚本；引用文件与示例首期不导入，会在预览里逐个列出。
技能文本里关于权限、密钥的内容不会变成任何授权。
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import posixpath
import re
import stat
import zipfile

from .domain.types import now_iso
from .skills import RULE_KEYS, validate_rules

FORMAT = 'ice-writing-skill/1'
MAX_TEXT = 200_000           # 单个 Markdown 文件（字符）
MAX_INSTRUCTIONS = 12_000    # 与 WritingSkills.save 一致
MAX_ZIP = 1_000_000          # ZIP 原始字节
MAX_ZIP_ENTRIES = 100
MAX_ZIP_UNPACKED = 4_000_000
MAX_PACKAGE_FILES = 10           # v3.19 参考资料与示例：与单个技能的上限一致
MAX_PACKAGE_FILE_CHARS = 20_000
MAX_PACKAGE_TOTAL_CHARS = 60_000
RULES_FENCE = re.compile(r'(?:<!--[^\n]*-->\n)?```json ice-skill-rules\n(.*?)\n```\n?', re.S)
SCRIPT_EXT = {'.py', '.js', '.mjs', '.cjs', '.ts', '.sh', '.ps1', '.bat', '.cmd', '.exe', '.dll', '.so', '.rb', '.pl'}
TEXT_EXT = {'.md', '.markdown', '.txt'}
# 外部 SKILL.md 常见的前置字段：不会生效的声明在预览里说明。
INERT_FIELDS = {'allowed-tools', 'allowed_tools', 'tools', 'permissions', 'license', 'metadata', 'model', 'hooks'}
SENSITIVE = re.compile(r'忽略(?:以上|之前|所有|系统)|绕过|越权|api[ _-]?key|密钥|令牌|token|上传|ignore (?:all|previous|the above)', re.I)


class SkillPackageError(ValueError):
    pass


# ------------------------------------------------------------------ export
def _safe_name(name: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', '-', name).strip(' .-') or '写作技能'
    return cleaned[:60]


def to_markdown(skill: dict, *, version: int | None = None) -> dict:
    """导出为 Markdown：前置信息 + 指令正文 + 可选的检查规则 JSON 块。可原样再导入。"""
    name = str(skill['name'])
    lines = ['---', f'name: {json.dumps(name, ensure_ascii=False)}', f'version: {int(version or skill.get("version") or 1)}',
             f'format: {FORMAT}', f'kind: {skill.get("kind") or "main"}', f'exported_at: {now_iso()}', f'source_id: {skill.get("id", "")}', '---', '',
             str(skill['instructions']).strip(), '']
    rules = skill.get('rules') or {}
    if rules:
        lines += ['<!-- 以下为检查规则（JSON），导入时读取；不需要时可整段删除 -->', '```json ice-skill-rules',
                  json.dumps(rules, ensure_ascii=False, indent=2), '```', '']
    text = '\n'.join(lines)
    return {'file_name': f'{_safe_name(name)}-v{int(version or skill.get("version") or 1)}.md', 'markdown': text,
            'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest()}


def to_zip(skill: dict, files: list[tuple[dict, str]], *, version: int | None = None) -> dict:
    """v3.19 带参考文件的技能导出为 ZIP：SKILL.md、skill.json、references/、examples/。可原样再导入。"""
    exported = to_markdown(skill, version=version)
    number = int(version or skill.get('version') or 1)
    buffer = io.BytesIO()
    used: set[str] = set()
    entries = []
    for meta, text in files:
        folder = 'examples' if meta['kind'] == 'example' else 'references'
        base = _safe_name(posixpath.splitext(meta['name'])[0]) or 'file'
        ext = posixpath.splitext(meta['name'])[1].lower() if posixpath.splitext(meta['name'])[1].lower() in TEXT_EXT else '.md'
        path, n = f'{folder}/{base}{ext}', 2
        while path in used:
            path, n = f'{folder}/{base}-{n}{ext}', n + 1
        used.add(path)
        entries.append((path, text, {'path': path, 'kind': meta['kind'], 'stages': meta['stages']}))
    manifest = {'format': FORMAT, 'name': skill['name'], 'version': number, 'kind': skill.get('kind') or 'main',
                'instructions': 'SKILL.md', 'rules': skill.get('rules') or {}, 'files': [e[2] for e in entries]}
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('SKILL.md', exported['markdown'])
        archive.writestr('skill.json', json.dumps(manifest, ensure_ascii=False, indent=2))
        for path, text, _ in entries:
            archive.writestr(path, text)
    raw = buffer.getvalue()
    return {'file_name': f'{_safe_name(skill["name"])}-v{number}.zip', 'data_base64': base64.b64encode(raw).decode(),
            'sha256': hashlib.sha256(raw).hexdigest(), 'files': len(entries)}


# ------------------------------------------------------------------ parse
def _front_matter(text: str) -> tuple[dict, str]:
    if not text.startswith('---\n'):
        return {}, text
    end = text.find('\n---', 4)
    if end < 0 or end > 8000:
        return {}, text
    after = text.find('\n', end + 4)
    head, body = text[4:end], (text[after + 1:] if after >= 0 else '')
    fields: dict[str, str] = {}
    for line in head.split('\n'):
        if not line.strip() or line[0] in ' \t-#':
            continue  # 嵌套/列表/注释：不解析
        key, sep, value = line.partition(':')
        if not sep:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
            try:
                value = json.loads(value) if value[0] == '"' else value[1:-1]
            except ValueError:
                value = value[1:-1]
        fields[key.strip().lower()] = str(value)
    return fields, body


def _decode(raw: bytes, label: str, warnings: list[str]) -> str:
    if raw.startswith(b'\xef\xbb\xbf'):
        raw = raw[3:]
    try:
        return raw.decode('utf-8')
    except UnicodeDecodeError:
        try:
            text = raw.decode('gb18030')
        except UnicodeDecodeError as error:
            raise SkillPackageError(f'{label} 不是 UTF-8 或 GBK 文本') from error
        warnings.append(f'{label} 按 GBK 编码读取，请核对有无乱码')
        return text


def _clean_rules(raw: object, warnings: list[str]) -> dict:
    if raw in (None, ''):
        return {}
    if not isinstance(raw, dict):
        warnings.append('检查规则不是 JSON 对象，已忽略')
        return {}
    unknown = sorted(set(raw) - RULE_KEYS)
    if unknown:
        warnings.append('不认识的检查规则已忽略：' + '、'.join(unknown[:12]))
    kept = {}
    for key in sorted(set(raw) & RULE_KEYS):
        try:
            kept.update(validate_rules({key: raw[key]}))
        except ValueError as error:
            warnings.append(f'检查规则 {key} 无效，已忽略（{error}）')
    return kept


def parse_markdown(text: str, file_name: str = '', *, warnings: list[str] | None = None,
                   meta: dict | None = None) -> dict:
    warnings = [] if warnings is None else warnings
    if len(text) > MAX_TEXT:
        raise SkillPackageError(f'文件过大（{len(text)} 字），单个技能文件最多 {MAX_TEXT} 字')
    text = text.replace('\r\n', '\n').replace('\r', '\n').lstrip('﻿')
    fields, body = _front_matter(text)
    fields = {**fields, **{k: str(v) for k, v in (meta or {}).items() if isinstance(v, (str, int)) and not isinstance(v, bool)}}
    rules_raw: object = None
    match = RULES_FENCE.search(body)
    if match:
        try:
            rules_raw = json.loads(match.group(1))
        except ValueError:
            warnings.append('检查规则 JSON 无法解析，已忽略')
        body = body[:match.start()] + body[match.end():]
        if RULES_FENCE.search(body):
            warnings.append('文件里有多段检查规则，只读取了第一段')
            body = RULES_FENCE.sub('', body)
    if isinstance((meta or {}).get('rules'), dict):
        rules_raw = meta['rules']
    rules = _clean_rules(rules_raw, warnings)
    instructions = body.strip()
    if not instructions and fields.get('description'):
        instructions = fields['description'].strip()
        warnings.append('文件没有正文，已用 description 作为写作指令')
    if not instructions:
        raise SkillPackageError('没有找到可导入的写作指令')
    if len(instructions) > MAX_INSTRUCTIONS:
        raise SkillPackageError(f'写作指令有 {len(instructions)} 字，超过单个技能 {MAX_INSTRUCTIONS} 字的上限；请先精简后再导入')
    heading = re.match(r'#\s+(.{1,80})\n', instructions + '\n')
    stem = posixpath.splitext(posixpath.basename(file_name.replace('\\', '/')))[0]
    name = (fields.get('name') or (heading.group(1) if heading else '') or stem or '导入的写作技能').strip()[:80]
    inert = sorted(set(fields) & INERT_FIELDS)
    if inert:
        warnings.append('以下声明不会生效：' + '、'.join(inert) + '（技能只影响写作与检查，不授予工具、模型或文件权限）')
    if SENSITIVE.search(instructions):
        warnings.append('指令里出现了关于权限、密钥或上传的文字；技能不会因此获得任何权限，请确认内容可信')
    source = {'kind': 'import', 'file_name': (file_name or name)[-200:], 'imported_at': now_iso(),
              'format': FORMAT if fields.get('format') == FORMAT else 'markdown'}
    if fields.get('version', '').isdigit():
        source['original_version'] = int(fields['version'])
    kind = fields.get('kind', 'main') if fields.get('kind') in ('main', 'addon') else 'main'  # v3.16 主技能 / 辅助技能
    return {'skill': {'name': name, 'instructions': instructions, 'rules': rules, 'source': source, 'kind': kind}, 'warnings': warnings}


def _zip_entries(raw: bytes) -> dict[str, bytes]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as error:
        raise SkillPackageError('不是有效的 ZIP 文件') from error
    with archive:
        infos = [i for i in archive.infolist() if not i.is_dir()]
        if len(infos) > MAX_ZIP_ENTRIES:
            raise SkillPackageError(f'ZIP 内文件过多（{len(infos)} 个），最多 {MAX_ZIP_ENTRIES} 个')
        if sum(i.file_size for i in infos) > MAX_ZIP_UNPACKED:
            raise SkillPackageError('ZIP 解压后过大，技能包最多 4MB')
        files: dict[str, bytes] = {}
        for info in infos:
            name = info.filename.replace('\\', '/')
            parts = name.split('/')
            if name.startswith('/') or re.match(r'^[A-Za-z]:', name) or '..' in parts or '\x00' in name:
                raise SkillPackageError(f'ZIP 里有不安全的路径：{info.filename[:80]}')
            if stat.S_ISLNK(info.external_attr >> 16):
                raise SkillPackageError(f'ZIP 里有链接文件，已拒绝：{info.filename[:80]}')
            if parts[0] == '__MACOSX' or parts[-1] in ('.DS_Store', 'Thumbs.db'):
                continue
            if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise SkillPackageError('ZIP 使用了不支持的压缩方式')
            files[name] = archive.read(info)
        return files


def parse_zip(raw: bytes, file_name: str = '') -> dict:
    if len(raw) > MAX_ZIP:
        raise SkillPackageError('技能包过大，ZIP 最多 1MB')
    files = _zip_entries(raw)
    tops = {name.split('/')[0] for name in files}
    if len(tops) == 1 and all('/' in name for name in files):
        prefix = next(iter(tops)) + '/'
        files = {name[len(prefix):]: data for name, data in files.items()}
    warnings: list[str] = []
    meta: dict = {}
    manifest_name = next((n for n in files if n.lower() == 'skill.json'), None)
    if manifest_name:
        try:
            meta = json.loads(_decode(files[manifest_name], 'skill.json', warnings))
        except ValueError as error:
            raise SkillPackageError('skill.json 不是有效的 JSON') from error
        if not isinstance(meta, dict):
            raise SkillPackageError('skill.json 需为 JSON 对象')
    entry = meta.get('instructions') or meta.get('entry')
    if isinstance(entry, str) and entry.replace('\\', '/') in files:
        main = entry.replace('\\', '/')
    else:
        if entry:
            warnings.append(f'skill.json 指定的指令文件 {str(entry)[:80]} 不在包里，改用 SKILL.md')
        roots = [n for n in files if '/' not in n and posixpath.splitext(n)[1].lower() in TEXT_EXT]
        main = next((n for n in roots if n.lower() == 'skill.md'), None) or (roots[0] if len(roots) == 1 else None)
    if not main:
        raise SkillPackageError('技能包里没有 SKILL.md')
    rest = sorted(n for n in files if n not in (main, manifest_name))
    scripts = [n for n in rest if posixpath.splitext(n)[1].lower() in SCRIPT_EXT]
    if scripts:
        warnings.append(f'包含 {len(scripts)} 个脚本或程序文件，不会导入，也不会运行')
    # v3.19：文本类的参考资料与示例一起导入（只取文字；类型与阶段来自 skill.json，否则按目录推断）
    declared = {str(f.get('path', '')).replace('\\', '/'): f for f in meta.get('files') or [] if isinstance(f, dict)}
    materials, ignored, total = [], list(scripts), 0
    for name in (n for n in rest if n not in scripts):
        if posixpath.splitext(name)[1].lower() not in TEXT_EXT:
            ignored.append(name)
            continue
        if len(materials) >= MAX_PACKAGE_FILES:
            ignored.append(name)
            warnings.append(f'参考文件超过 {MAX_PACKAGE_FILES} 个，{name} 未导入')
            continue
        try:
            text = _decode(files[name], name, warnings).replace('\r\n', '\n').strip()
        except SkillPackageError:
            ignored.append(name)
            warnings.append(f'{name} 不是可读的文本，未导入')
            continue
        if not text:
            ignored.append(name)
            continue
        if len(text) > MAX_PACKAGE_FILE_CHARS or total + len(text) > MAX_PACKAGE_TOTAL_CHARS:
            ignored.append(name)
            warnings.append(f'{name} 有 {len(text)} 字，超过单个 {MAX_PACKAGE_FILE_CHARS} 字或合计 {MAX_PACKAGE_TOTAL_CHARS} 字的上限，未导入')
            continue
        spec = declared.get(name, {})
        lowered = name.lower()
        kind = spec.get('kind') if spec.get('kind') in ('reference', 'example') else \
            'example' if lowered.startswith(('examples/', 'example/', 'samples/')) or '/examples/' in lowered else 'reference'
        stages = spec.get('stages') if isinstance(spec.get('stages'), list) and spec['stages'] and \
            not set(spec['stages']) - {'plan', 'write', 'review'} else (['write'] if kind == 'example' else ['plan', 'write', 'review'])
        total += len(text)
        materials.append({'name': posixpath.basename(name)[:120], 'path': name, 'kind': kind,
                          'stages': [x for x in ('plan', 'write', 'review') if x in stages], 'text': text, 'chars': len(text)})
    others = [n for n in ignored if n not in scripts]
    if others:
        warnings.append(f'{len(others)} 个非文本或超限文件未导入')
    fields = {k: meta[k] for k in ('name', 'version', 'description', 'format', 'kind') if isinstance(meta.get(k), (str, int))}
    if 'rules' in meta:
        fields['rules'] = meta['rules'] if isinstance(meta['rules'], dict) else None
        if not isinstance(meta['rules'], dict):
            warnings.append('skill.json 的 rules 不是对象，已忽略')
    for key in INERT_FIELDS & set(meta):
        fields[key] = '1'
    result = parse_markdown(_decode(files[main], main, warnings), file_name or main, warnings=warnings, meta=fields)
    result['skill']['source']['format'] = 'zip'
    result['ignored_files'] = sorted(ignored)[:100]
    result['files'] = materials
    return result


def parse(params: dict) -> dict:
    """skills.import_parse：只解析、不写入。返回技能草稿、提示与未导入的文件。"""
    file_name = str(params.get('file_name') or '')[:200]
    text, data = params.get('text'), params.get('data_base64')
    if isinstance(data, str):
        try:
            raw = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError) as error:
            raise SkillPackageError('文件数据无效') from error
        digest = hashlib.sha256(raw).hexdigest()
        if raw[:4] == b'PK\x03\x04' or file_name.lower().endswith('.zip'):
            result = parse_zip(raw, file_name)
        else:
            if len(raw) > MAX_TEXT * 4:
                raise SkillPackageError('文件过大')
            warnings: list[str] = []
            result = parse_markdown(_decode(raw, file_name or '文件', warnings), file_name, warnings=warnings)
    elif isinstance(text, str):
        digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
        result = parse_markdown(text, file_name)
    else:
        raise SkillPackageError('请选择要导入的 Markdown 或 ZIP 文件')
    result['skill']['source']['sha256'] = digest
    result.setdefault('ignored_files', [])
    result.setdefault('files', [])
    return result
