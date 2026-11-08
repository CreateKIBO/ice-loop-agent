// 选图导入（编辑器与文章设置共用）。
import { toast } from "../../components/toast";
import { accountStore } from "../../data/client";
import type { ImageView } from "./documentsApi";

/** 选图导入：显式带上发起时的公众号，选择框打开期间切号也不会导入到新公众号。 */
export async function pickDocumentImage(accountId = accountStore.get()): Promise<ImageView | null> {
  const pick = window.ice?.pickDocumentImage as undefined | ((accountId: string) => Promise<ImageView | null>);
  if (typeof pick !== "function") { toast.warning({ title: "请在桌面应用中插入图片", detail: "也可以直接粘贴或拖入图片。" }); return null; }
  try { return await pick(accountId); }
  catch (error) { if (accountStore.get() === accountId) toast.error({ title: "图片没有导入", detail: (error as Error).message }); return null; }
}
