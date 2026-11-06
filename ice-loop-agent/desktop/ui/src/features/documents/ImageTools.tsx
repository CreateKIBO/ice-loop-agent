// P1 图片增强：裁切 / 缩放 / 压缩另存为新图（原图不变），以及来源与权利说明。
import * as React from "react";

import { Button, Dialog, Input } from "../../components/ui";
import { ErrorNote } from "../../components/ErrorNote";
import { toast } from "../../components/toast";
import { queryClient, useCurrentAccount } from "../../data/client";
import { docRpc, formatBytes, formatTime, type ImageView } from "./documentsApi";

type Crop = { x: number; y: number; w: number; h: number };
const ASPECTS: Array<{ label: string; ratio: number | null }> = [
  { label: "自由", ratio: null }, { label: "16:9", ratio: 16 / 9 }, { label: "4:3", ratio: 4 / 3 },
  { label: "1:1", ratio: 1 }, { label: "3:4", ratio: 3 / 4 }, { label: "2.35:1", ratio: 2.35 },
];
const WIDTHS = [0, 1920, 1280, 1080, 720];
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 以图片中心取最大的指定比例区域（比例按像素计算）。 */
function centered(ratio: number, width: number, height: number): Crop {
  const imageRatio = width / height;
  if (ratio > imageRatio) { const h = imageRatio / ratio; return { x: 0, y: (1 - h) / 2, w: 1, h }; }
  const w = ratio / imageRatio; return { x: (1 - w) / 2, y: 0, w, h: 1 };
}

export function ImageEditDialog({ view, open, onClose, onDone }: {
  view: ImageView; open: boolean; onClose: () => void; onDone: (next: ImageView) => void;
}) {
  const account = useCurrentAccount();
  const [aspect, setAspect] = React.useState<number | null>(null);
  const [crop, setCrop] = React.useState<Crop | null>(null);
  const [maxWidth, setMaxWidth] = React.useState(view.width > 1920 ? 1920 : 0);
  const [format, setFormat] = React.useState<"keep" | "jpeg" | "png">("keep");
  const [quality, setQuality] = React.useState(85);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const frame = React.useRef<HTMLDivElement | null>(null);
  const drag = React.useRef<{ x: number; y: number } | null>(null);
  const jpeg = format === "jpeg" || (format === "keep" && view.mime === "image/jpeg") || (format === "keep" && view.mime === "image/webp");

  const point = (event: React.PointerEvent) => {
    const rect = frame.current!.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) / rect.width, 0, 1), y: clamp((event.clientY - rect.top) / rect.height, 0, 1) };
  };
  const draw = (start: { x: number; y: number }, end: { x: number; y: number }) => {
    let w = Math.abs(end.x - start.x), h = Math.abs(end.y - start.y);
    if (aspect) {
      // 比例按像素：归一化坐标下 h = w * (图宽/图高) / 比例。
      const k = view.width / view.height / aspect;
      if (w * k > h) h = w * k; else w = h / k;
      const maxW = end.x >= start.x ? 1 - start.x : start.x, maxH = end.y >= start.y ? 1 - start.y : start.y;
      const scale = Math.min(1, maxW / Math.max(w, 1e-6), maxH / Math.max(h, 1e-6));
      w *= scale; h *= scale;
    }
    const x = end.x >= start.x ? start.x : start.x - w, y = end.y >= start.y ? start.y : start.y - h;
    setCrop({ x: clamp(x, 0, 1), y: clamp(y, 0, 1), w: clamp(w, 0, 1 - clamp(x, 0, 1)), h: clamp(h, 0, 1 - clamp(y, 0, 1)) });
  };
  const chooseAspect = (ratio: number | null) => {
    setAspect(ratio);
    setCrop(ratio ? centered(ratio, view.width, view.height) : null);
  };
  const pixels = crop ? { w: Math.round(crop.w * view.width), h: Math.round(crop.h * view.height) } : { w: view.width, h: view.height };
  const outWidth = maxWidth && pixels.w > maxWidth ? maxWidth : pixels.w;
  const outHeight = Math.round(pixels.h * outWidth / Math.max(pixels.w, 1));
  const usable = !crop || (crop.w >= 0.02 && crop.h >= 0.02);

  const apply = async () => {
    setBusy(true); setError(null);
    try {
      const next = await docRpc<ImageView & { before?: { size: number } }>("documents.image_edit", {
        resource_id: view.resource_id, crop: crop && (crop.w < 0.999 || crop.h < 0.999) ? crop : null,
        max_width: maxWidth || null, format, quality,
      });
      queryClient.setQueryData(["ice", account, "documents.image_view", { resource_id: next.resource_id }], next);
      onDone(next);
      toast.success({ title: "已替换为处理后的图片", detail: `${next.width}×${next.height} · ${formatBytes(view.size)} → ${formatBytes(next.size)}。原图仍在素材库，Ctrl+Z 可换回。` });
      onClose();
    } catch (problem) { setError(problem); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }} title="裁切与压缩" width={720}
            description="处理结果另存为一张新图片并替换到正文，原图保持不变。来源与权利说明会随新图保留。"
            footer={<><span className="ice-doc-muted" style={{ flex: 1 }}>输出约 {outWidth}×{outHeight}{jpeg ? ` · JPEG 质量 ${quality}` : ""}</span>
              <Button onClick={onClose}>取消</Button>
              <Button variant="primary" loading={busy} disabled={!usable} onClick={() => void apply()}>生成并替换</Button></>}>
      <div className="ice-imgtool">
        <div className="ice-imgtool__aspects" role="radiogroup" aria-label="裁切比例">
          {ASPECTS.map(item => <button key={item.label} type="button" role="radio" aria-checked={aspect === item.ratio}
            className={aspect === item.ratio ? "is-on" : ""} onClick={() => chooseAspect(item.ratio)}>{item.label}</button>)}
          {crop && <button type="button" className="ice-link-btn" onClick={() => { setCrop(null); setAspect(null); }}>不裁切</button>}
        </div>
        <div className="ice-imgtool__frame" ref={frame} aria-label="在图片上拖动选择裁切区域" role="img"
             onPointerDown={event => { (event.target as HTMLElement).setPointerCapture?.(event.pointerId); drag.current = point(event); }}
             onPointerMove={event => { if (drag.current) draw(drag.current, point(event)); }}
             onPointerUp={() => { drag.current = null; }}>
          <img src={view.preview} alt="" draggable={false} />
          {crop && <div className="ice-imgtool__crop" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }} />}
        </div>
        <p className="ice-doc-muted">在图片上拖动框选裁切区域；选了比例后框会保持该比例。原图 {view.width}×{view.height} · {formatBytes(view.size)}。</p>
        <div className="ice-imgtool__opts">
          <label>最大宽度
            <select value={maxWidth} onChange={event => setMaxWidth(Number(event.target.value))} aria-label="最大宽度">
              {WIDTHS.map(value => <option key={value} value={value}>{value ? `${value}px` : "保持原尺寸"}</option>)}
            </select></label>
          <label>格式
            <select value={format} onChange={event => setFormat(event.target.value as "keep" | "jpeg" | "png")} aria-label="输出格式">
              <option value="keep">保持原格式</option><option value="jpeg">JPEG（照片，体积小）</option><option value="png">PNG（截图/文字，无损）</option>
            </select></label>
          {jpeg && <label>质量 {quality}
            <input type="range" min={50} max={95} step={5} value={quality} onChange={event => setQuality(Number(event.target.value))} aria-label="压缩质量" /></label>}
        </div>
        {error != null && <ErrorNote error={error} note="原图没有改变。" />}
      </div>
    </Dialog>
  );
}

export function ImageSourceDialog({ view, open, onClose, pastedFrom }: {
  view: ImageView; open: boolean; onClose: () => void; pastedFrom?: string;
}) {
  const account = useCurrentAccount();
  const source = view.source;
  const [url, setUrl] = React.useState(source?.source_url || pastedFrom || "");
  const [note, setNote] = React.useState(source?.rights_note ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const next = await docRpc<ImageView>("documents.image_source_update", { resource_id: view.resource_id, source_url: url.trim(), rights_note: note.trim() });
      queryClient.setQueryData(["ice", account, "documents.image_view", { resource_id: view.resource_id }], next);
      toast.success({ title: "来源已保存" }); onClose();
    } catch (problem) { setError(problem); }
    finally { setBusy(false); }
  };
  const op = source?.operation;
  return (
    <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }} title="图片来源" width={520}
            description="记录图片从哪里来、是否获得授权。来源记录不等于使用许可，发布前请自行确认权利。"
            footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" loading={busy} onClick={() => void save()}>保存</Button></>}>
      <div className="ice-doc-form">
        <dl className="ice-imgtool__facts">
          <dt>获取方式</dt><dd>{source?.label ?? "素材库"}{source?.converted_from ? `（由 ${source.converted_from} 转为 PNG）` : ""}</dd>
          {source?.original_name && <><dt>原文件</dt><dd>{source.original_name}</dd></>}
          {source?.imported_at && <><dt>导入时间</dt><dd>{formatTime(source.imported_at)}</dd></>}
          {source?.derived_from && <><dt>处理自</dt><dd>另一张原图{op ? `（${op.crop ? "裁切、" : ""}${op.max_width ? `缩到 ${op.max_width}px 宽、` : ""}${String(op.format).toUpperCase()}${op.quality ? ` 质量 ${op.quality}` : ""}）` : ""}</dd></>}
          <dt>当前尺寸</dt><dd>{view.width}×{view.height} · {formatBytes(view.size)}</dd>
        </dl>
        <label className="ice-doc-field">来源链接
          <Input value={url} maxLength={2000} placeholder="https://…（可选）" aria-label="来源链接" onChange={event => setUrl(event.target.value)} /></label>
        <label className="ice-doc-field">权利说明
          <Input value={note} maxLength={200} placeholder="例如：自摄 / 作者授权 / CC BY 4.0（可选）" aria-label="权利说明" onChange={event => setNote(event.target.value)} /></label>
        {error != null && <ErrorNote error={error} note="来源没有保存。" />}
      </div>
    </Dialog>
  );
}
