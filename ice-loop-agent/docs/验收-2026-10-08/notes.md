# 初步审查记录

日期：2026-10-08。仅检查当前GLM改动与隔离fixture，不修改产品源码或用户安装。

已跑：123项v2专项Python测试通过（331.33秒）、81项Node通过、TypeScript通过、Vite构建通过。当前发行JS/Python同源审计通过，但版本仍1.5.3。

原生源码/打包EXE均复现：点击已有会话TypeError n.some is not a function；点击编辑正文报无效请求。原因分别是chat.get被错误当数组、新增RPC未进main方法白名单。新UI没有新建会话按钮，草稿箱显示占位文字。

独立离线backend-repro已复现：已选图valid但导出images=0；补齐形状后JPG复制命名PNG，正文仍占位无相对图路径；有needs_check断言却接受ready；models.probe_capabilities错误相对导入；staging.mkdir失败后finally删了本轮预先存在的模拟未知目录；同幂等key跨账号返回错账号任务/同账号换输入不冲突；空稿patch不能创建初稿。

静态定位：真实chat工具循环每轮返回同一个envelope、不向模型回传工具结果；TaskQueue只在工具注册表enqueue/list，未发现生产claim/consumer；EventBroker没有业务接入引用，useEventStream未被页面使用；自动截图automation.cjs仍是内存attempted和全部runs，bind_slot_run未被capture消费。

环境/审批记录：默认sandbox无法读G盘，require_escalated核对与隔离测试经审核允许。第一版backend-repro包含能力探测，被自动审查以可能使用本机凭据真实外部调用/费用拒绝；已清空非必要环境并在socket.connect/urllib opener阻断网络，只读核对后离线版本获准并执行。没有真实模型网络请求。

本轮所有审查脚本是独立fixture复现，未用于修补产品或放宽既有测试。后续正式报告区分原生复现、后端复现、静态确认和未测项。
