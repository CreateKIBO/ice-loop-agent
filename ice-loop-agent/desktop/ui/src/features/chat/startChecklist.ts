// 批A6（2026-10-23 体验完善）：可收起的入门任务清单。
// 完成状态只来自可观察的真实数据（栏目数/模型就绪/历史目录），不伪造"已配置完成"；
// 收起偏好按账号持久化，损坏/存储失败安全回退；不保存任何正文或凭据。
export type StartChecklistInput = {
  hasAccount: boolean; columnCount: number;
  readiness: "missing" | "untested" | "unrouted" | "ready" | "unknown";
  hasLibrary: boolean;
};
export type StartChecklistItem = { key: string; label: string; done: boolean; note: string };

/** 三步完成状态：全部由现有只读数据推导。 */
export function checklistStatus(input: StartChecklistInput): StartChecklistItem[] {
  return [
    { key: "account", label: "确认公众号与栏目", done: input.hasAccount && input.columnCount > 0,
      note: input.columnCount > 0 ? `已读取到 ${input.columnCount} 个栏目` : "还没有栏目，先补一个栏目再开始" },
    { key: "model", label: "接入文字模型", done: input.readiness === "ready",
      note: input.readiness === "ready" ? "写作链已有通过连接测试的模型"
        : input.readiness === "untested" ? "Key 已保存，但还没有通过连接测试"
        : input.readiness === "unrouted" ? "有可用 Key，写作链尚未使用它"
        : input.readiness === "unknown" ? "正在读取配置状态" : "尚未配置 Key" },
    { key: "history", label: "关联历史文章（可稍后）", done: input.hasLibrary,
      note: input.hasLibrary ? "已关联历史目录" : "没有旧文也可以直接开始" },
  ];
}

const KEY = (account: string) => `ice.ui.startcheck.v1.${account}`;

export function loadStartChecklistDismissed(storage: Pick<Storage, "getItem">, account: string): boolean {
  try { return storage.getItem(KEY(account)) === "dismissed"; } catch { return false; }
}

export function saveStartChecklistDismissed(storage: Pick<Storage, "setItem" | "removeItem">,
                                             account: string, dismissed: boolean): boolean {
  try {
    if (dismissed) storage.setItem(KEY(account), "dismissed");
    else storage.removeItem(KEY(account));
    return true;
  } catch { return false; } // 存储不可用时退化为会话内状态
}
