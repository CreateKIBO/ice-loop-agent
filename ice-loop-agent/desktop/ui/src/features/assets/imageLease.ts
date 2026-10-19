/** Large original images live only in the open viewer, outside Query caches. */
export function imageLease(data: string): { url: string; release: () => void } {
  if (data.length > 46 * 1024 * 1024) throw Error('图片数据无效或超出可预览大小');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(data);
  if (!match) throw Error('图片数据无效或超出可预览大小');
  const raw = atob(match[2]);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type: match[1] }));
  let released = false;
  return { url, release() { if (!released) { released = true; URL.revokeObjectURL(url); } } };
}

export function fitImage(image: { width: number; height: number }, area: { width: number; height: number }): number {
  if (![image.width, image.height, area.width, area.height].every(value => Number.isFinite(value) && value > 0)) return 1;
  return Math.min(1, Math.max(.01, Math.min((area.width - 24) / image.width, (area.height - 24) / image.height)));
}
export const boundedZoom = (value: number) => Number.isFinite(value) ? Math.min(4, Math.max(.01, value)) : 1;
