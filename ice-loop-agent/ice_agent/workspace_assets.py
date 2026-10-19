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
from .image_memory import IMAGE_DECODE_GATE, serialized_image_decode, thumbnail_data_url


@serialized_image_decode
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
        return [self.with_hash(json.loads(row[0])) for row in rows]

    def style_context(self):
        selected = [r for r in self.resources() if r.get('style_reference')]
        if len(selected)>8:
            raise ValueError('风格参考最多8张，请取消部分参考标记')
        result=[]
        for r in selected:
            report=r.get('visual_analysis') or {}
            result.append({'resource_id':r['resource_id'],'sha256':r['sha256'],'title':r['title'],
                'description':r.get('description',''),'usage':r.get('usage','reference'),'preset_asset':r.get('preset_asset',''),
                'style':report.get('style',''),'composition':report.get('composition',''),
                'palette':r['palette'],'aspect_ratio':round(r['width']/r['height'],3)})
        return result

    @staticmethod
    def with_hash(resource):
        data = {key:value for key,value in resource.items() if key != 'content_hash'}
        return {**data,'content_hash':sha256_json(data)}

    def resource(self, resource_id):
        row = self.store.conn.execute("SELECT metadata_json FROM publication_resources WHERE resource_id=? AND account_id=?", (resource_id, self.account_id)).fetchone()
        if not row:
            raise ValueError("当前公众号没有这项配图资源")
        return self.with_hash(json.loads(row[0]))

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
        with IMAGE_DECODE_GATE:
            with Image.open(io.BytesIO(content)) as image:
                palette = extract_palette(image)
                width, height = image.size
        target.write_bytes(content)
        resource = {"resource_id": new_id("resource"), "title": source.stem[:100], "file_path": str(target),
                    "sha256": digest, "mime": mime, "size": size, "width": width, "height": height,
                    "palette": palette, "analysis": None, "created_at": now_iso()}
        self.save_resource(resource)
        return self.resource(resource['resource_id'])

    def save_resource(self, resource, *, commit=True):
        resource = {key:value for key,value in resource.items() if key != 'content_hash'}
        self.store.conn.execute("INSERT OR REPLACE INTO publication_resources VALUES (?,?,?,?)",
            (resource["resource_id"], self.account_id, json.dumps(resource, ensure_ascii=False), now_iso()))
        if commit:
            self.store.conn.commit()

    def save_resource_if_current(self, resource, expected_hash):
        with self.store.transaction():
            if self.resource(resource['resource_id'])['content_hash'] != expected_hash:
                raise ValueError('资源已更新，请重新打开后修改或分析')
            self.save_resource(resource,commit=False)
        return self.resource(resource['resource_id'])

    def preview(self, resource_id, original=False):
        resource = self.resource(resource_id)
        path = self.checked_path(resource)
        if original:
            return {'data_url':'data:'+resource['mime']+';base64,'+base64.b64encode(path.read_bytes()).decode(),
                    'width':resource['width'],'height':resource['height']}
        return {"data_url": thumbnail_data_url(path)}

    def checked_path(self, resource):
        path = normalize(resource["file_path"])
        assert_within(path, self.runtime / "resources" / self.account_id)
        if hashlib.sha256(path.read_bytes()).hexdigest() != resource["sha256"]:
            raise ValueError("配图资源文件已改变，请重新导入")
        return path

    def update_resource(self, params):
        resource = self.resource(params['resource_id'])
        if resource['content_hash'] != params.get('content_hash'):
            raise ValueError('资源已更新，请重新打开后修改')
        title, description, tags = params.get('title'),params.get('description',''),params.get('tags',[])
        usage = params.get('usage','reference')
        if not isinstance(title,str) or not 1<=len(title.strip())<=100 or not isinstance(description,str) or len(description)>1000:
            raise ValueError('名称需为1–100字，说明最多1000字')
        if not isinstance(tags,list) or len(tags)>12 or any(not isinstance(tag,str) or not 1<=len(tag.strip())<=30 for tag in tags):
            raise ValueError('最多12个标签，每个标签1–30字')
        if usage not in ('cover','illustration','screenshot','reference'):
            raise ValueError('请选择正确的资源用途')
        reference=params.get('style_reference',resource.get('style_reference',False))
        if type(reference) is not bool:
            raise ValueError('风格参考标记需为布尔值')
        if reference and not resource.get('style_reference') and sum(bool(r.get('style_reference')) for r in self.resources())>=8:
            raise ValueError('最多设置8张风格参考')
        resource['style_reference']=reference
        resource.update(title=title.strip(),description=description.strip(),tags=list(dict.fromkeys(tag.strip() for tag in tags)),usage=usage,metadata_source='user')
        return self.save_resource_if_current(resource,params['content_hash'])

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
