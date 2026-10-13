# v2.0 HANDOFF

更新时间：2026-10-11（B/C1/C2/C3/D 完成，未打包、未提交）

```text
当前基线/应用版本/协议/schema：
  发行包：release/ICE-Loop-Studio-2.0.0-beta.2-{Setup.exe,x64.zip}
  SQLite MAX_KNOWN_VERSION=19（v19 运行截图溯源 capture_assets）；契约层 PROTOCOL_VERSION=2
  版本同步：desktop=2.0.0-beta.2 / ui=2.0.0-beta.2 / pyproject=2.0.0-beta.2 / __version__=2.0.0-beta.2
当前阶段：
  验收 R01–R16 全部有修复+回归（部分标注详见修复批次报告）。
  全量 Python 497/497 独立 ID、Node 90/90、beta.2 EXE 三路 smoke 全绿。
  批次A 队列生产接线完成；批次B 核心完成；C3 假费用修正；D ContextPack 确认在。
剩余待做（如实）：
  迁移/冻结专项（任务单第 7 节）未动；未打 beta.3 包
  C2 仍部分：资源箱放大/原图查看沿用既有资源预览，未在新 UI 重做；
  TapNow 固定站点入口与各公众号独立登录沿用 browser.cjs，未改
  截图失效提示目前经 assets.capture_status 返回 stale，新 UI 尚未单独展示该状态
已完成（beta.2 之后）：主包分包——启动包 1136 KB → 337 KB（index 286 + client 51）；
  编辑器 648 KB 与流程图 178 KB 改为按需加载（点"编辑正文"/展开状态图时才下载）
  新工作台前端第二轮：富文本模式下正文溢出盖住"修改提案"的布局 bug 已修；改稿审阅改为字符级差异
  （inlineDiff.ts）；命令面板分组/新建会话；左栏最近/归档/回收站分段与时间；知识检索引用切换；
  行动卡自适应轮询；分栏计算抽到 paneLayout.ts（中等宽度优先保中栏 480px）。Node 测试 102 项
  发行可用性一轮（2026-10-11，未打包）：
    默认启动新工作台；选择存 runtime/ui-preference.json，双向一键切换（经典顶栏"新工作台"/
    新界面左栏底部与命令面板"经典界面"，IPC ice:switch-ui / ice:relaunch）；
    --classic-ui / --new-ui 强制；依赖 window.__ICE_*__ 的冒烟固定走经典页；ui/dist 缺失回落经典。
    选择逻辑在 ui-mode.cjs（已加入 electron-builder files），tests/ui-mode.test.cjs 覆盖
    新界面内补齐"模型与 Key"设置（保存 Key/测试连接/正文使用标记，Ctrl+,）、欢迎引导页
    （未配置/未测试横幅、快捷入口）、引擎退出横幅+重启、credential_warning 改由 bootstrap 提示
    交互动效：全局 toast（可撤销归档/删除）、对话框进出场、骨架屏、消息入场与流式光标/打字点、
    分段控件滑块、列表增删布局动画、行动卡展开收起；prefers-reduced-motion 全部关闭
    Node 107/107、ui-smoke、dpi-smoke（1/1.25/1.5/2 无横向溢出）通过；启动包 index ≈ 488 KB
    （motion 进主包，gzip 153 KB）
待办完成一轮（2026-10-11，未打包、未提交、未动 release/ 与用户工作区）：
  B 最终交付审阅：articles.delivery_snapshot / delivery_confirm，审阅哈希与 ready 导出对齐；
    新 UI 交付审阅对话框（阻断项、图位、规则、声明、确认后导出）
  C1 事件进度：创作会话与工具循环把真实步骤写入 stream_events（chat:{会话}），
    新 UI 按账号|流缓存游标、分页补缺、去重；生成中显示真实步骤与已用时间，
    不再把 progress 对象直接渲染；turn.finished 立即刷新会话，工具事件立即刷新行动卡
  C2 下载归档：内嵌浏览器下载完成后进 download_staging（不默认采纳），
    新 UI 待归档箱选文章与图位后 downloads.bind，或判定不采用；
    同内容重复下载复用原记录；运行截图登记 capture_assets（账户/任务/图位/运行/源码 hash），
    运行证据变化后 capture_status 返回 stale；顺手补上 bind_download 缺失的 find_slot_for_figure 导入
  C3 预算面板：budgets.get 增会话已用/剩余与是否显式配置；0 为显式不限制，未配置按默认 24；
    新 UI 模型设置内展示全局/补图/会话/当前会话，保存走 budgets.save；
    发送遇"模型调用已达上限"给出打开预算设置的入口；计数仍由后端账本执行
  D 摘要注入：chat.summary 只覆盖较早轮次（最近 6 条留原文）；请求构建时按账号重读摘要，
    范围不符或内容 hash 不符则标记失效并退回原文；覆盖范围与 hash 写入消息 summary_manifest
  验证：Python 全量 520 通过；Node 113 通过；tsc 与 vite build 通过；
    ui-smoke、dpi-smoke（1/1.25/1.5/2 无横向溢出）通过；
    模拟桥接视觉检查覆盖预算面板、真实步骤进度、待归档箱，无控制台错误
回退方案：1.5.3/beta.1/beta.2 包均保留于 release/；新版 schema(v19) 拒旧引擎
下一步：迁移/冻结专项；再打 beta.3 前重跑全量+EXE 旅程
```
