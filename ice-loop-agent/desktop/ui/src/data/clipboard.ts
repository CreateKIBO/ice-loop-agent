/** Copy through the existing desktop bridge; report failures instead of fake success. */
export async function copyPlainText(text: string): Promise<void> {
  if (!text.trim()) throw new Error("没有可复制的内容");
  const copy = window.ice?.copyText;
  if (typeof copy === "function" && text.length <= 30000) {
    const result = await (copy as (value: string) => Promise<unknown>)(text);
    // 桥接会做写后回读校验并返回 {ok:false,...}；不能把“剪贴板不可用”当成功
    // 展示（E2：剪贴板拒绝时仍显示成功是假反馈）。旧环境无返回值时保持原语义。
    if (result && typeof result === "object" && (result as { ok?: unknown }).ok === false) {
      throw new Error((result as { message?: string }).message
        ?? "当前系统剪贴板不可用，请手动选择并复制");
    }
    return;
  }
  if (!navigator.clipboard?.writeText) throw new Error("剪贴板不可用，请手动选择并复制");
  await navigator.clipboard.writeText(text);
}
