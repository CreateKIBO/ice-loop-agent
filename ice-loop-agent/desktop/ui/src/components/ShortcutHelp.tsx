// 快捷键与操作帮助（批次2-10 / 批次7-43,45）：只列真实实现的键位与真实存在的
// 排障条目；可搜索过滤。键位与 app/CommandPalette.tsx、features/editor/
// ArticleEditor.tsx、app/WorkbenchShell.tsx、features/chat/ChatPane.tsx 的
// 实际注册一一对应；排障文案与 components/errorText.ts 的已知码同源。
import * as React from "react";
import "../styles/help.css";

import { Button, Dialog, Input, Tabs, TabsList, TabsTrigger, TabsContent } from "./ui";
import { editorialStore, openPublicationSetup, settingsStore } from "../app/uiState";

export interface ShortcutEntry {
  keys: string;
  label: string;
  /** 作用范围：工作台全局 / 对话输入 / 编辑器 / 阅读窗口 / 分栏。 */
  scope: string;
}

/** 帮助跳转白名单（批次D-17）：只允许打开既有界面开关，不开任意 RPC。
 *  跳转只打开对应面板，不测试 Key、不发送内容、不改动当前会话与稿件。 */
type HelpTarget = "model-settings" | "editorial" | "publication-history" | "publication-identity";
interface HelpJump { label: string; target: HelpTarget }
const JUMP: Record<HelpTarget, () => void> = {
  "model-settings": () => settingsStore.set(true),
  "editorial": () => editorialStore.set(true),
  "publication-history": () => openPublicationSetup("history"),
  "publication-identity": () => openPublicationSetup("identity"),
};

export const SHORTCUTS: readonly ShortcutEntry[] = [
  { keys: "Ctrl + K", label: "打开命令面板", scope: "工作台全局" },
  { keys: "Ctrl + N", label: "新建会话", scope: "工作台全局" },
  { keys: "Ctrl + ,", label: "打开设置", scope: "工作台全局" },
  { keys: "Ctrl + S", label: "保存（编辑器内）", scope: "编辑器" },
  { keys: "Enter", label: "发送消息（输入法组词时为候选确认，不发送）", scope: "对话输入" },
  { keys: "Shift + Enter", label: "输入内换行", scope: "对话输入" },
  { keys: "Esc", label: "退出单面板专注布局 / 关闭弹窗", scope: "工作台全局" },
  { keys: "← / →", label: "调整分栏宽度（分栏分隔条聚焦时）", scope: "分栏" },
  { keys: "Home 或 Enter", label: "分栏恢复默认宽度（分隔条聚焦时）", scope: "分栏" },
  { keys: "↑ ↓ PgUp PgDn Home End 空格", label: "滚动历史阅读窗口", scope: "阅读窗口" },
  { keys: "↑ / ↓", label: "命令面板内移动选择", scope: "命令面板" },
];

export function ShortcutHelp({ open, onOpenChange }: {
  open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [tab, setTab] = React.useState("guide");
  React.useEffect(() => { if (open) { setQuery(""); setTab("guide"); } }, [open]);
  const needle = query.trim().toLowerCase();
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);
  const entries = SHORTCUTS.filter(row => matches(row.keys + " " + row.label + " " + row.scope));
  const problems = TROUBLESHOOTING.filter(row => matches([row.symptom, row.cause, row.next, ...row.keywords].join(" ")));
  const guides = GUIDES.filter(row => matches(row.title + " " + row.body));
  // 跳转前先关闭帮助：避免帮助弹窗与目标弹窗叠层抢焦点；未保存编辑不受影响。
  const jump = (go: HelpJump) => { onOpenChange(false); JUMP[go.target](); };
  const jumpButton = (go?: HelpJump) => go
    ? <Button size="sm" className="ice-help-jump" onClick={() => jump(go)} title="打开对应设置，不发送内容、不测试 Key">{go.label}</Button>
    : null;
  return <Dialog open={open} onOpenChange={onOpenChange} title="帮助：使用流程、快捷键与排障"
    initialFocus='input[aria-label="搜索帮助"]'
    footer={<><span className="ice-help-note" style={{flex:1}}>帮助仅说明操作，不会自动发送模型请求、执行代码或发布文章。</span><Button onClick={() => onOpenChange(false)}>关闭帮助</Button></>}>
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList aria-label="帮助分类" className="ice-help-tabs">
        <TabsTrigger value="guide">使用流程</TabsTrigger>
        <TabsTrigger value="shortcuts">快捷键</TabsTrigger>
        <TabsTrigger value="troubleshooting">常见问题排障</TabsTrigger>
      </TabsList>
      <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索当前分类的操作、键位或问题…" aria-label="搜索帮助" className="ice-help-search" />
      <TabsContent value="guide">
        <ul className="ice-help-list">{guides.map(row => <li key={row.title}><strong>{row.title}</strong><p>{row.body}</p>{row.go && <p className="ice-help-note">{jumpButton(row.go)}</p>}</li>)}</ul>
        {!guides.length && <p role="status">没有匹配的操作说明，请清除搜索或切换分类。</p>}
      </TabsContent>
      <TabsContent value="shortcuts">
        <ul className="ice-help-list">{entries.map(row => <li key={row.keys} className="ice-help-shortcut"><kbd>{row.keys}</kbd><span>{row.label}</span><small>{row.scope}</small></li>)}</ul>
        {!entries.length && <p role="status">没有匹配的快捷键。</p>}
      </TabsContent>
      <TabsContent value="troubleshooting">
        <ul className="ice-help-list">{problems.map(row => <li key={row.symptom}><strong>{row.symptom}</strong><p>原因：{row.cause}</p><p>下一步：{row.next}</p>{row.go && jumpButton(row.go)}</li>)}</ul>
        {!problems.length && <p role="status">没有匹配的排障条目。</p>}
      </TabsContent>
    </Tabs>
  </Dialog>;
}

interface GuideEntry { title: string; body: string; go?: HelpJump }
interface TroubleshootingEntry {
  symptom: string;
  cause: string;
  next: string;
  keywords: string[];
  go?: HelpJump;
}

const GUIDES: readonly GuideEntry[] = [
  {title:"1. 公众号与历史",body:"从公众号与品牌建立自己的档案，核对读者、栏目、品牌配色与文章目录。导入历史后确认期号和已发布状态，草稿不能计为已发布。",go:{label:"打开公众号与品牌",target:"publication-identity"}},
  {title:"2. 模型与预算",body:"在模型与 Key 设置中保存可用模型，再将其选入写作主模型或已配置的备用链。模型配置和调用预算是全局设置。普通文章/补图任务上限为1–100；仅创作会话预算允许0表示不限制，未配置会话预算时默认24。已有任务保留自己的预算。",go:{label:"打开模型与 Key 设置",target:"model-settings"}},
  {title:"3. 选题与排期",body:"选择栏目和期号，参考该期之前最近五期正文与全部历史标题；也可导入MD/TXT/DOCX大纲，预览修改后确认指定期题。确认只带入对话，不会自动发送。可复制的示例见 docs/栏目选题大纲-示例.md（随应用仓库提供，不是你的发布历史）。",go:{label:"打开选题与排期",target:"editorial"}},
  {title:"4. 生成初稿与讨论",body:"在创作对话中选择讨论、初稿、改稿或配图，再发送需求。初稿候选可展开、保存为草稿、继续修改及提交审阅。保存不等于采纳或发布。查找仅覆盖当前已加载消息窗口。"},
  {title:"5. 修改与审阅",body:"修改正文后观察保存回执；离开前处理未保存修改。保存冲突时先保留本地文本，再载入最新版本核对。文章事实、代码运行证据和最终审阅均以当前版本为准。"},
  {title:"6. 配图与TapNow",body:"在配图资源箱核对图位、品牌提示词及参考图顺序，复用已有资源或查看真实运行截图。内嵌TapNow由你登录、上传参考图、粘贴提示词并生图；下载后导入、审核并选用。"},
  {title:"7. 候选对照阅读",body:"在「历史/最近候选稿」中点击「加入对照」选择当前页的两份候选（同名也可，按内容区分），再点「打开对照」并排阅读：可切阅读排版或完整 Markdown 原文、按各自标题目录跳转、分别复制本份原文。对照是只读的，不保存、不采纳、不提交；翻页或切换会话后选择自动清空。阅读预览只是阅读排版，与公众号后台最终排版不同。"},
  {title:"8. 复制失败怎么办",body:"复制按钮依赖系统剪贴板。若提示「复制失败」，说明系统剪贴板暂不可用：错误提示会给出原因，可稍后重试同按钮，或从展开的原文/文件名区域手动选择文字复制。复制内容始终是当前完整文本，不含图片文件。"},
  {title:"9. 参考图上传顺序",body:"配图工作台的「品牌参考图」显示当前图位的参考数量与图片编号；展开后按编号顺序上传到 TapNow（图片 1 先传）。每张参考显示完整文件名并可单独复制，也可一键复制「文件名清单」。折叠时缩略图会释放，重新展开再读取。"},
  {title:"10. 保存草稿与视图复位",body:"保存草稿只把当前候选存入左栏「草稿箱」，不等于采纳或提交审阅；发布前仍需提交审阅并通过交付检查。任务列表右上「恢复默认视图」只重置当前公众号的显示偏好（筛选/紧凑/搜索/含归档），不影响文章、草稿或其他公众号。"},
  {title:"7. 导出与手动发布",body:"草稿导出和就绪发布包各有检查条件；按阻断清单核验事实、正文和图片。导出文本与图片后在内嵌公众号后台排版、上传及预览，由你最终发布，再登记发布进度。"},
  {title:"8. 备份与恢复",body:"先预览备份内容，再明确确认恢复到新目录；凭据跨机器恢复存在系统限制。未完成任务会暂停，需要显式选择接续。不要直接删原工作目录或凭据来排障。"},
];

/** 排障表（批次7-45 / 批次D-17,20）：与 errorText.ts 已知码同源；只写可执行下一步。
 *  有界面入口的条目附白名单跳转；没有全局入口的写清操作路径，不造假链接。 */
export const TROUBLESHOOTING: readonly TroubleshootingEntry[] = [
  {
    symptom: "找不到以前的文章，或下一期期号与预期不一致",
    cause: "当前公众号关联的历史目录、栏目或已发布记录需要核对；草稿不计入已发布期号。",
    next: "在历史与目录核对当前公众号的文章目录与已关联存稿，再到选题与排期检查栏目和期号。",
    keywords: ["历史", "旧文", "期号", "目录"],
    go: { label: "打开历史与目录", target: "publication-history" },
  },
  {
    symptom: "发送时提示「模型调用已达上限」",
    cause: "当前任务或会话的调用预算用完。文章/补图上限为1–100；仅会话预算允许0表示不限制，未配置会话预算默认24。",
    next: "查看全局预算；已有文章还需在配图工作台或任务里检查当前任务预算，处理后再继续。",
    keywords: ["model_budget_exceeded", "预算", "上限", "budget"],
    go: { label: "打开预算设置", target: "model-settings" },
  },
  {
    symptom: "提示「模型凭据未配置或已失效」",
    cause: "供应商 API Key 缺失、错误、过期，或该端点/模型权限不足。分享诊断前仍应检查敏感信息。",
    next: "在模型与 Key 设置重新保存该供应商的 Key；保存后直接重试，无需重启。",
    keywords: ["auth_failed", "key", "凭据", "api"],
    go: { label: "打开模型设置", target: "model-settings" },
  },
  {
    symptom: "「未配置写作路由」/ 发送无响应",
    cause: "当前账号没有为 writer 角色选择主模型，或所选模型 Key 未保存。",
    next: "在模型与 Key 设置的模型分工中，为写作选择一个已配置 Key 的模型。",
    keywords: ["路由", "writer", "route", "模型分工"],
    go: { label: "打开模型分工", target: "model-settings" },
  },
  {
    symptom: "保存正文时提示「内容已被更新」",
    cause: "你编辑的版本之后已有新的保存（可能是另一窗口或上一次保存晚到）。",
    next: "先复制或保留本地修改，再按当前编辑器提供的冲突操作载入最新版本核对。",
    keywords: ["revision_conflict", "冲突", "已变化"],
  },
  {
    symptom: "切公众号后看不到刚才的文章/会话",
    cause: "内容按公众号隔离；延迟返回的旧账号响应不会写入当前账号。",
    next: "在左栏顶部的账号选择器切回原公众号查看；当前输入不会被清空。",
    keywords: ["account_mismatch", "公众号已切换", "账号"],
  },
  {
    symptom: "配图位提示图片缺失/丢失",
    cause: "已采纳图片的文件被移动或内容变化，hash 校验不再匹配。",
    next: "路径：打开该文章编辑器 →「准备配图」，在配图工作台重新导入或绑定候选；「发布就绪包」导出会继续阻断直到图位有效。",
    keywords: ["图片", "缺失", "asset", "hash"],
  },
  {
    symptom: "发布就绪导出被阻断",
    cause: "就绪门检查规则、未核验事实、运行证据、人审 delivery hash 与图位，任一不满足即阻断。",
    next: "路径：打开该文章编辑器 →「交付审阅」，按阻断清单逐项处理；事实核验与代码运行在经典界面对应页面完成。草稿导出允许部分未完成项，但仍有资源和目录校验。",
    keywords: ["ready", "导出", "阻断", "就绪"],
  },
  {
    symptom: "点了停止但界面仍显示生成中",
    cause: "停止请求已发出；本地停止不等于远端立即结束，远端请求可能仍产生费用。",
    next: "观察任务是否已结束；持续未结束时保留错误码再排查网络。停止前已处理的部分仍可能计费。",
    keywords: ["cancelled", "停止", "取消"],
  },
  {
    symptom: "想导入选题大纲但没有现成文档",
    cause: "大纲导入支持 MD/TXT/DOCX，按栏目、期号组织即可，不需要先有发布历史。",
    next: "复制 docs/栏目选题大纲-示例.md 的格式（示例数据仅作演示，不会计入你的已发布历史），在选题与排期里导入并预览。",
    keywords: ["大纲", "导入", "outline", "示例"],
    go: { label: "打开选题与排期", target: "editorial" },
  },
];

