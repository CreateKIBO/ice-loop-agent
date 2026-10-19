/** Copy through the existing desktop bridge; report failures instead of fake success. */
export async function copyPlainText(text: string): Promise<void> {
  if (!text.trim()) throw new Error("没有可复制的内容");
  const copy = window.ice?.copyText;
  if (typeof copy === "function" && text.length <= 30000) {
    await (copy as (value: string) => Promise<unknown>)(text);
    return;
  }
  if (!navigator.clipboard?.writeText) throw new Error("剪贴板不可用，请手动选择并复制");
  await navigator.clipboard.writeText(text);
}
