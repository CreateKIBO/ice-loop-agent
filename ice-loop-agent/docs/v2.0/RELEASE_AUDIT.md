# v2.0 发行审计（M9-10）

日期：2026-10-08。run_id: v2-run001。

## 交付物与 SHA256

| 文件 | 大小 | SHA256 |
|---|---|---|
| release/ICE-Loop-Studio-1.5.3-Setup.exe | 194,933,884 B | 7db80b1770afb74621bc9e6bd0f3b3bb145c420543e4342c04d7974a38e3ef9b |
| release/ICE-Loop-Studio-1.5.3-x64.zip | 194,501,735 B | 1285df16375334a26418193e29fd80a7443bce0b17f1fc334a3dfbc49ad2e32f |

（版本号沿用 desktop/package.json=1.5.3；v2.0 功能以源码与本审计为准，版本号变更属用户发布决策。）

## 同源核对（build/verify_release.py + verify-release.cjs 双审计通过）

- ZIP ↔ win-unpacked：选定二进制（主 EXE/app.asar/引擎/teaching-python/engine-project）逐一 hash 一致。
- Setup ↔ win-unpacked：7z 流式抽取同 hash 一致。
- 引擎 ↔ 最新冻结：dist/ice-engine 与发行内一致（非旧引擎）。
- 用户数据：ZIP 无 credentials.json/app.db/settings.json/Cookies/.desktop-runtime/.test-tmp。
- 新 UI：app.asar 含 ui/dist/index.html 与主 bundle（build/check-asar-ui.cjs → ASAR_UI_OK）。
- 生成缓存审计：verify_release 规则更新——PyInstaller 6 onedir 托管字节码
  （__pycache__/x.pyc.<magic>）为标准布局放行；裸 .pyc/.pyo（源码树漏收形态）仍拦截。

## EXE 原生验收（M9-07，全部在打包版运行）

| smoke | 结果 |
|---|---|
| ui-smoke（--ui-smoke，新工作台挂载+真实 RPC） | ok=true，ice://app/ui/index.html |
| chat-smoke（写作全旅程 85 检查） | exit 0（firstMessageHandoff=true 等） |
| prompt-smoke（提示词工坊 32 检查） | exit 0（singleReusableViewer=true 等） |
| dpi-smoke（打包版新 UI，150% 屏 + 4 档 zoom） | 4 档全部 overflowX=false，几何+截图落盘 |

## 隔离安装演练（M9-08，本轮专属身份）

1. **停进程边界**：installer/stop-agent.ps1 -DiscoverOnly 实跑——仅发现当前会话内
   已验证的 ICE Loop 进程；本轮无残留进程（discovered=[]，failures=[]）。真实安装时只
   关闭本安装已验证进程，不杀其他 Python/Electron（v1.5.3 机制未改动）。
2. **ZIP 隔离解压**：854 文件解压到 .test-tmp/v2-run001/isolated-unpack/；
   主 EXE/app.asar/引擎 EXE 三方 hash 与 win-unpacked **全 MATCH**（可独立运行态）。
3. NSIS 静默覆盖安装到真实机器位置涉及注册表/开始菜单与用户真实安装实例——
   按授权边界不在本轮自动执行；用户可手动运行 Setup.exe（流程与 v1.5.3 相同，
   数据目录不受影响，preserve-workspaces 脚本保留工作区）。

## 测试统计（去重后）

- Python：全量 460 项（含 v1.5.3 全部回归 + v2.0 新增 138 项），round10 exit 0。
- Node：81 项（62 既有 + 19 新增），exit 0。
- EXE 原生：4 路 smoke（ui/chat/prompt/dpi）全绿。
- 离线 eval：7 样例 exit 0。
- 分类：mock/本地真实 = 上述全部；原生打包 = 4 路 smoke + 双审计；**云端未测 =
  真实模型 API 分项探测、TapNow 真实生图、公众号真实发布（无授权，不在自动范围）**。

## 清理边界

本轮临时目录：.test-tmp/v2-run001/（含 ui-smoke-*/dpi-smoke-*/isolated-unpack/等）
与 .test-tmp/ui-smoke-*、.test-tmp/dpi-smoke-*、.test-tmp/electron-*、.test-tmp/v2-*。
全部为本轮 owner 产物，保留待用户检查后可整体删除；未触碰任何历史版本目录、
release 历史包、正式图片与运行证据。

## 未完成/需授权

- M8-04 预算 UX（金额估算需用户价格表）与真实 Key 分项探测——需用户提供。
- M6-10/M7-10 的 J04/J05/J06 全链 UI 人工旅程、200 轮会话性能项——列最终人工验收清单。
- 真实云端生图/发布/模型探测——需单独授权。
