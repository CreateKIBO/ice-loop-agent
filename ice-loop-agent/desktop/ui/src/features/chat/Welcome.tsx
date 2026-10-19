// 未选会话时的中栏：首次使用引导（先配模型）+ 常用入口 + 快捷键。
import * as React from "react";
import { motion } from "motion/react";

import { Banner, Button } from "../../components/ui";
import { toast } from "../../components/toast";
import { createConversation } from "../../data/actions";
import { useBootstrap, useModelReadiness } from "../../app/ModelSettings";
import { editorialStore,paletteStore, publicationSettingsStore, settingsStore,openPublicationSetup } from "../../app/uiState";
import { useCurrentAccount } from '../../data/client';
import { loadComposerDraft,saveComposerDraft,type ComposerMode } from '../../data/composerDraft';

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
  const account=useCurrentAccount();
  return <WelcomeForAccount key={account} account={account}/>;
}

const GUIDE_DRAFT='getting-started';
function WelcomeForAccount({account}:{account:string}) {
  const readiness = useModelReadiness();
  const boot=useBootstrap(),publication=boot.data?.account,accountName=publication?.name;
  const [seed]=React.useState(()=>loadComposerDraft(window.localStorage,account,GUIDE_DRAFT));
  const [topic,setTopic]=React.useState(seed.text),[mode,setMode]=React.useState<ComposerMode>(seed.text?seed.mode:'draft');
  const [series,setSeries]=React.useState(''),[persisted,setPersisted]=React.useState(true);
  const columns=publication?.columns??[],selectedSeries=columns.some(row=>row.code===series)?series:columns[0]?.code||'';
  const writer=boot.data?.settings?.profiles.find(profile=>profile.profile_id===boot.data?.settings?.routes?.writer?.primary);
  const [requestId,setRequestId]=React.useState(()=>crypto.randomUUID());
  const processing=React.useRef(false);
  const [creating, setCreating] = React.useState(false);
  React.useEffect(()=>{setPersisted(saveComposerDraft(window.localStorage,account,GUIDE_DRAFT,{text:topic,mode}));},[account,topic,mode]);
  const changeTopic=(value:string)=>{setTopic(value);setRequestId(crypto.randomUUID());};
  const start = async (withIdea=false) => {
    if (processing.current||!publication||(withIdea&&!topic.trim())) return;
    processing.current=true;
    setCreating(true);
    try {
      await createConversation(requestId,{series:selectedSeries,...(withIdea?{title:topic.trim().slice(0,60),initialInput:{text:topic.trim(),mode}}:{})});
      if(withIdea)saveComposerDraft(window.localStorage,account,GUIDE_DRAFT,{text:'',mode:'discuss'});
    }
    catch (error) { toast.error({ title: "新建会话失败", detail: (error as Error).message }); }
    finally { processing.current=false;setCreating(false); }
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
        {readiness === "unrouted" && <motion.div variants={item}>
          <Banner tone="warning" title="已配置的模型尚未接入写作"
            actions={<Button onClick={()=>settingsStore.set(true)}>设置模型分工</Button>}>
            在「文字模型分工」中选择已配置Key的供应商，再保存分工。只配置Key不会自动替换写作模型。
          </Banner>
        </motion.div>}

        <motion.section variants={item} className="ice-start-guide" aria-label="开始指南">
          <div className="ice-start-guide__heading"><h2>从你的公众号开始</h2><span>资料保存在本地，随时可以回来调整</span></div>
          <ol>
            <li><span className="ice-start-guide__number" aria-hidden>1</span><div><strong>确认公众号与栏目</strong>
              <p>当前使用「{accountName||'正在载入…'}」{columns.length?` · ${columns.length} 个栏目`:''}。为其他公众号创作时，可新增或导入自己的品牌资料。</p>
              <div className="ice-start-guide__actions"><Button size="sm" disabled={!publication} onClick={()=>openPublicationSetup('identity')}>查看当前资料</Button>
                <Button size="sm" disabled={!publication} onClick={()=>openPublicationSetup('new')}>新增或导入公众号</Button></div></div></li>
            <li><span className="ice-start-guide__number" aria-hidden>2</span><div><strong>接入文字模型</strong>
              <p>当前写作主模型：{writer?`${writer.provider} · ${writer.model_id}`:'尚未读取'}。{readiness==='ready'?'写作链中已有通过连接测试的模型。':readiness==='untested'?'写作链已配置Key，可手动测试连接。':readiness==='unrouted'?'已有Key，但当前写作链未使用它。':'请配置Key，并保存文字模型分工。'}</p>
              <Button size="sm" onClick={()=>settingsStore.set(true)}>配置模型与分工</Button></div></li>
            <li><span className="ice-start-guide__number" aria-hidden>3</span><div><strong>关联已有文章 <span className="ice-start-guide__optional">可稍后</span></strong>
              <p>{publication?.library_root?'已设置历史目录，可打开检查原稿。':'关联Markdown原稿目录后，可用于历史分析与选题。没有旧文也可以直接开始。'}</p>
              <Button size="sm" disabled={!publication} onClick={()=>openPublicationSetup('history')}>关联历史文章</Button></div></li>
          </ol>
          <form onSubmit={event=>{event.preventDefault();void start(true);}}>
            <fieldset disabled={creating||!publication}>
              <label htmlFor="ice-first-idea"><strong>第一篇想写什么</strong></label>
              <textarea id="ice-first-idea" aria-label="第一篇创作要求" rows={3} maxLength={12000} value={topic}
                onChange={event=>changeTopic(event.target.value)} placeholder="写下选题、观点或素材。例如：结合本栏目前几篇文章，写一篇关于循环的入门教程。"/>
              <div className="ice-start-guide__form-row"><label>所属栏目<select aria-label="首次创作栏目" value={selectedSeries}
                onChange={event=>{setSeries(event.target.value);setRequestId(crypto.randomUUID());}}>{columns.map(column=><option key={column.code} value={column.code}>{column.code} · {column.name}</option>)}</select></label>
                <label>开始方式<select aria-label="首次创作方式" value={mode} onChange={event=>{setMode(event.target.value as ComposerMode);setRequestId(crypto.randomUUID());}}>
                  <option value="draft">准备初稿</option><option value="discuss">先讨论方向</option></select></label>
                <Button variant="primary" loading={creating} disabled={!topic.trim()} type="submit">带入创作对话 →</Button></div>
            </fieldset>
            <p className={persisted?'ice-start-guide__hint':'ice-error-text'}>{persisted?'要求会带入输入框，由你检查后发送；此处不会自动调用模型。':'本地保存不可用，请保留此窗口或复制创作要求。'}</p>
          </form>
        </motion.section>

        <motion.div variants={item} className="ice-quick-grid">
          <button type="button" className="ice-quick" onClick={()=>editorialStore.set(true)}>
            <strong>选题与排期</strong><span>前五篇正文、全部标题与预设期题</span><span aria-hidden>↗</span>
          </button>
          <button type="button" className="ice-quick" onClick={()=>publicationSettingsStore.set(true)}>
            <strong>公众号与品牌</strong><span>新增公众号、导入品牌与关联历史</span><span aria-hidden>↗</span>
          </button>
          <button type="button" className="ice-quick" onClick={()=>void start(false)} disabled={creating||!publication}>
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
