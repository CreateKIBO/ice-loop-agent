// 未选会话时的中栏：首次使用引导（先配模型）+ 常用入口 + 快捷键。
import * as React from "react";
import { motion } from "motion/react";

import { Banner, Button } from "../../components/ui";
import { toast } from "../../components/toast";
import { createConversation } from "../../data/actions";
import { useBootstrap, useModelReadiness } from "../../app/ModelSettings";
import { paletteStore, settingsStore } from "../../app/uiState";

const container = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };
const item = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.2, 0, 0, 1] as const } } };

function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 6) return "夜深了";
  if (hour < 12) return "早上好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

export function Welcome() {
  const readiness = useModelReadiness();
  const accountName = useBootstrap().data?.account?.name;
  const [creating, setCreating] = React.useState(false);
  const start = async () => {
    if (creating) return;
    setCreating(true);
    try { await createConversation(); }
    catch (error) { toast.error({ title: "新建会话失败", detail: (error as Error).message }); }
    finally { setCreating(false); }
  };

  return (
    <div className="ice-welcome">
      <motion.div className="ice-welcome__inner" variants={container} initial="hidden" animate="show">
        <motion.div variants={item} style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="ice-welcome__mark" aria-hidden>i</span>
          <div>
            <h1>{greeting()}{accountName ? `，${accountName}` : ""}</h1>
            <p>和 Agent 讨论选题、出初稿、改稿，满意后交给制作流水线。</p>
          </div>
        </motion.div>

        {readiness === "missing" && (
          <motion.div variants={item}>
            <Banner tone="warning" title="还没有配置模型"
                    actions={<Button variant="primary" onClick={() => settingsStore.set(true)}>配置模型</Button>}>
              保存任一供应商的 API Key 并测试连接后，就可以开始生成内容。
            </Banner>
          </motion.div>
        )}
        {readiness === "untested" && (
          <motion.div variants={item}>
            <Banner tone="info" title="Key 已保存，建议测试一次连接"
                    actions={<Button onClick={() => settingsStore.set(true)}>去测试</Button>}>
              测试会发送一条很短的请求，确认 Key 和模型 ID 都可用。
            </Banner>
          </motion.div>
        )}

        <motion.div variants={item} className="ice-quick-grid">
          <button type="button" className="ice-quick" onClick={start} disabled={creating}>
            <strong>{creating ? "正在新建…" : "新建会话"}</strong>
            <span>从一个想法或选题开始</span>
            <kbd>Ctrl N</kbd>
          </button>
          <button type="button" className="ice-quick" onClick={() => paletteStore.set(true)}>
            <strong>命令面板</strong>
            <span>搜会话、打开文章、执行操作</span>
            <kbd>Ctrl K</kbd>
          </button>
          <button type="button" className="ice-quick" onClick={() => settingsStore.set(true)}>
            <strong>模型设置</strong>
            <span>{readiness === "ready" ? "模型已就绪，可随时调整" : "配置供应商与 API Key"}</span>
            <kbd>Ctrl ,</kbd>
          </button>
        </motion.div>

        <motion.div variants={item} className="ice-shortcuts" aria-label="快捷键">
          <span><span className="ice-kbd">Enter</span> 发送</span>
          <span><span className="ice-kbd">Shift Enter</span> 换行</span>
          <span><span className="ice-kbd">Ctrl S</span> 保存文章版本</span>
          <span><span className="ice-kbd">Esc</span> 清空搜索 / 关闭弹窗</span>
        </motion.div>
      </motion.div>
    </div>
  );
}
