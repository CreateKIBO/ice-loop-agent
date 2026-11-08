// v3.23 封面裁切：公众号封面有 2.35:1（消息列表大图）与 1:1（转发卡片、小图）两种显示。
// 只记录裁切位置（0–1 归一化坐标），不改原图；同步到草稿箱时作为 pic_crop_235_1 / pic_crop_1_1 传给后台。

import { useAccountQuery } from "../../data/client";
import type { DocInfo, ImageView } from "./documentsApi";

type Crop = NonNullable<DocInfo["coverCrop"]>;
const RATIOS = [{ key: "235" as const, ratio: 2.35, label: "2.35:1 大图" }, { key: "11" as const, ratio: 1, label: "1:1 小图" }];

/** 按位置 p（0–1）在宽 w、高 h 的图里取比例为 ratio 的最大裁切框。 */
export function cropBox(w: number, h: number, ratio: number, p: number): [number, number, number, number] {
  const round = (v: number) => Math.round(v * 10000) / 10000;
  if (w / h >= ratio) { const bw = (h * ratio) / w; const x = p * (1 - bw); return [round(x), 0, round(x + bw), 1]; }
  const bh = (w / ratio) / h; const y = p * (1 - bh); return [0, round(y), 1, round(y + bh)];
}
/** 裁切框 → 位置 p（用于回显滑块）。 */
export function cropPosition(box: number[] | undefined): number {
  if (!box) return 0.5;
  const [x1, y1, x2, y2] = box;
  const free = x2 - x1 < 1 ? 1 - (x2 - x1) : 1 - (y2 - y1);
  return free <= 0 ? 0.5 : Math.min(1, Math.max(0, (x2 - x1 < 1 ? x1 : y1) / free));
}

export function CoverCrop({ resourceId, crop, onChange }: { resourceId: string; crop?: Crop; onChange: (crop: Crop | undefined) => void }) {
  const view = useAccountQuery<ImageView>("documents.image_view", { resource_id: resourceId }, { staleTime: 60_000, retry: false });
  const image = view.data?.ok ? view.data : null;
  const mine = crop && crop.for === resourceId ? crop : undefined;  // 换了封面就不再套用旧裁切
  if (!image || !image.width || !image.height) return null;
  const set = (key: "235" | "11", ratio: number, p: number) => {
    const base: Crop = mine ? { ...mine } : { for: resourceId };
    onChange({ ...base, [key]: cropBox(image.width, image.height, ratio, p) });
  };
  return (
    <div className="ice-doc-crop" role="group" aria-label="封面裁切">
      {RATIOS.map(({ key, ratio, label }) => {
        const p = cropPosition(mine?.[key]);
        const wide = image.width / image.height >= ratio;  // 图更宽：左右移动；更高：上下移动
        return <div key={key} className="ice-doc-crop__item">
          <div className="ice-doc-crop__preview" style={{ aspectRatio: String(ratio), backgroundImage: `url("${image.preview}")`,
            backgroundSize: wide ? "auto 100%" : "100% auto", backgroundPosition: wide ? `${p * 100}% 0` : `0 ${p * 100}%` }}
               aria-label={`${label}预览`} role="img" />
          <label className="ice-doc-crop__slider">{label}{mine?.[key] ? "" : "（默认居中）"}
            <input type="range" min={0} max={100} value={Math.round(p * 100)} aria-label={`${label}裁切位置`}
                   onChange={event => set(key, ratio, Number(event.target.value) / 100)} /></label>
        </div>;
      })}
      {mine && <button type="button" className="ice-link-btn" onClick={() => onChange(undefined)}>恢复默认居中</button>}
    </div>
  );
}
