// 写操作回执（批次A-04）：后端写成功之后的列表刷新是第二件事，
// 刷新失败不能冒充写失败——否则用户会被诱导重复保存。统一在这里分隔，
// 刷新失败给"已完成但刷新失败"的警告回执和重试刷新入口。
import { toast } from "../components/toast";

export async function refreshAfterWrite(label: string, refresh: () => Promise<unknown>): Promise<void> {
  try {
    await refresh();
  } catch (error) {
    toast.warning({
      title: `${label}已完成，列表刷新失败`,
      detail: (error as Error).message,
      action: { label: "重试刷新", run: () => refreshAfterWrite(label, refresh) },
    });
  }
}
