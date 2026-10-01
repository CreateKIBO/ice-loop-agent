"""Account-scoped drafts, managed image resources and measured image palettes."""
import base64
import hashlib
import io
import json
from pathlib import Path

from PIL import Image, ImageOps

from .domain.types import new_id, now_iso, sha256_json
from .paths import assert_within, ensure_dir, normalize
from .providers.tapnow import validate_image_file


def extract_palette(image):
    sample = ImageOps.exif_transpose(image).convert("RGBA")
    sample.thumbnail((160, 160))
    pixels = [color[:3] for count, color in sample.getcolors(25600) or []
              if color[3] >= 16 for _ in range(count)]
    if not pixels:
        raise ValueError("图片没有可分析的可见像素")
    strip = Image.new("RGB", (len(pixels), 1))
    strip.putdata(pixels)
    quantized = strip.quantize(colors=128)
    colors = quantized.getpalette()
    # Merge nearby neutrals so large white backgrounds do not consume all slots.
    # Keep a representative measured color; do not invent accent colors.
    clusters = []
    for count, index in sorted(quantized.getcolors() or [], reverse=True):
        rgb = colors[index*3:index*3+3]
        match = next((group for group in clusters if sum((a-b)**2 for a,b in zip(group[1],rgb)) < 30**2), None)
        if match is None:
            clusters.append([count,rgb])
        else:
            match[0] += count
    return [{"hex": "#" + "".join(f"{v:02X}" for v in rgb),
             "share": round(count / len(pixels), 4)}
            for count, rgb in sorted(clusters, key=lambda c:c[0], reverse=True)[:8]]


class WorkspaceAssets:
    def __init__(self, store, runtime, account_id):
        self.store, self.runtime, self.account_id = store, runtime, account_id

    def resources(self):
        rows = self.store.conn.execute("SELECT metadata_json FROM publication_resources WHERE account_id=? ORDER BY updated_at DESC", (self.account_id,))
        return [json.loads(row[0]) for row in rows]

    def resource(self, resource_id):
        row = self.store.conn.execute("SELECT metadata_json FROM publication_resources WHERE resource_id=? AND account_id=?", (resource_id, self.account_id)).fetchone()
        if not row:
            raise ValueError("当前公众号没有这项配图资源")
        return json.loads(row[0])

    def import_image(self, file_path):
        source = normalize(file_path)
        ok, mime, size = validate_image_file(source)
        if not ok:
            raise ValueError("请选择有效的 PNG/JPEG/WebP 图片（最大 32MB）")
        content = source.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        extension = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[mime]
        folder = ensure_dir(self.runtime / "resources" / self.account_id)
        target = folder / (digest + extension)
        with Image.open(io.BytesIO(content)) as image:
            palette = extract_palette(image)
            width, height = image.size
        target.write_bytes(content)
        resource = {"resource_id": new_id("resource"), "title": source.stem[:100], "file_path": str(target),
                    "sha256": digest, "mime": mime, "size": size, "width": width, "height": height,
                    "palette": palette, "analysis": None, "created_at": now_iso()}
        self.save_resource(resource)
        return resource

    def save_resource(self, resource):
        self.store.conn.execute("INSERT OR REPLACE INTO publication_resources VALUES (?,?,?,?)",
            (resource["resource_id"], self.account_id, json.dumps(resource, ensure_ascii=False), now_iso()))
        self.store.conn.commit()

    def preview(self, resource_id):
        resource = self.resource(resource_id)
        path = normalize(resource["file_path"])
        assert_within(path, self.runtime / "resources" / self.account_id)
        if hashlib.sha256(path.read_bytes()).hexdigest() != resource["sha256"]:
            raise ValueError("配图资源文件已改变，请重新导入")
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source).convert("RGBA")
            image.thumbnail((1000, 700))
            output = io.BytesIO()
            image.save(output, format="PNG")
        return {"data_url": "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()}

    def drafts(self):
        rows = self.store.conn.execute("SELECT draft_id,title,content_hash,updated_at FROM publication_drafts WHERE account_id=? ORDER BY updated_at DESC", (self.account_id,))
        return [dict(row) for row in rows]

    def draft(self, draft_id):
        row = self.store.conn.execute("SELECT * FROM publication_drafts WHERE draft_id=? AND account_id=?", (draft_id, self.account_id)).fetchone()
        if not row:
            raise ValueError("当前公众号没有这篇草稿")
        return dict(row)

    def save_draft(self, params):
        title, body = params.get("title", "未命名草稿"), params.get("body", "")
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 300 or not isinstance(body, str) or len(body) > 200000:
            raise ValueError("草稿标题需为 1–300 字，正文最多 20 万字")
        draft_id = params.get("draft_id")
        with self.store.transaction():
            if draft_id:
                previous = self.draft(draft_id)
                if previous["content_hash"] != params.get("content_hash"):
                    raise ValueError("草稿已更新，请重新打开后保存")
            else:
                draft_id = new_id("draft")
            content_hash = sha256_json({"title": title.strip(), "body": body})
            self.store.conn.execute("INSERT OR REPLACE INTO publication_drafts VALUES (?,?,?,?,?,?)",
                (draft_id, self.account_id, title.strip(), body, content_hash, now_iso()))
        return self.draft(draft_id)
