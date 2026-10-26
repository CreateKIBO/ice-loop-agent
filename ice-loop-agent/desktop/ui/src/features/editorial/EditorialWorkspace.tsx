import * as React from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { Banner,Button,Dialog,ErrorPanel,Input,SkeletonRows,Spinner } from '../../components/ui';
import { CopyButton } from '../../components/CopyButton';
import { MarkdownContent } from '../../components/MarkdownContent';
import { toast } from '../../components/toast';
import { editorialStore } from '../../app/uiState';
import { useBootstrap } from '../../app/modelBootstrap';
import { accountStore,dirtyStore,registerDirtyFlush,rpc,useAccountQuery,useCurrentAccount } from '../../data/client';
import { createConversation } from '../../data/actions';
import { analyzePreview,editorialInput,issueNumber,outlinePage,outlinePayload,topicFields } from './editorialModel';
import type { DataPage,HistoryRow,OutlinePage,OutlinePreview,PlanningContext,PlanFields,Topic,TopicMatch,TopicRow } from './editorialModel';
import '../../styles/editorial.css';

const modes={outline:'采用预设标题',manual:'自己填写标题',ai:'先和 AI 讨论选题'} as const;
export function EditorialWorkspace() {
  const account=useCurrentAccount(),boot=useBootstrap(),columns=boot.data?.account?.columns??[];
  const [series,setSeries]=React.useState(columns[0]?.code||'');
  const [issue,setIssue]=React.useState(''),issueTouched=React.useRef(false);
  const number=issueNumber(issue),[tab,setTab]=React.useState('create');
  const [busy,setBusy]=React.useState(''),busyRef=React.useRef(false),[error,setError]=React.useState('');
  const [mode,setMode]=React.useState<PlanFields['title_mode']>('manual');
  const [title,setTitle]=React.useState(''),[angle,setAngle]=React.useState(''),[benefit,setBenefit]=React.useState(''),[next,setNext]=React.useState('');
  const [basis,setBasis]=React.useState<Topic|null>(null),[formDirty,setFormDirty]=React.useState(false);
  const [text,setText]=React.useState(''),[source,setSource]=React.useState('手动粘贴');
  const [preview,setPreview]=React.useState<OutlinePreview|null>(null),[replace,setReplace]=React.useState(false),[page,setPage]=React.useState(0);
  const [search,setSearch]=React.useState(''),[savedPage,setSavedPage]=React.useState(0);
  const [progress,setProgress]=React.useState(''),progressTouched=React.useRef(false);
  const [record,setRecord]=React.useState<HistoryRow|null>(null),[historyPage,setHistoryPage]=React.useState(0);
  const [historySearch,setHistorySearch]=React.useState(''),[status,setStatus]=React.useState('');
  const [reading,setReading]=React.useState<(HistoryRow&{body:string})|null>(null);
  const outlineQuery=useSearch(search),historyQuery=useSearch(historySearch);
  const outlines=useAccountQuery<OutlinePage>('outlines.list',{series,query:outlineQuery,page:savedPage,page_size:10},{enabled:tab==='outline'&&Boolean(series),gcTime:0});
  const context=useAccountQuery<PlanningContext>('planning.context',{series,include_titles:false,...(issueTouched.current&&number?{episode:number}:{})},{enabled:Boolean(series)&&(!issue||Boolean(number)),gcTime:0});
  const matching=useAccountQuery<TopicMatch>('outlines.match',{series,episode:number,include_available:false},{enabled:Boolean(series&&number),gcTime:0});
  const history=useAccountQuery<DataPage<HistoryRow>>('history.list',{series,query:historyQuery,status,page:historyPage,page_size:10,include_unclassified:true,refresh:false},{enabled:tab==='history'&&Boolean(series),gcTime:0});
  const pending=React.useRef<(()=>void)|null>(null),[discard,setDiscard]=React.useState('');
  const request=React.useRef<{signature:string;id:string;confirmation?:{plan_id:string;confirmation_hash:string}}>({signature:'',id:crypto.randomUUID()});
  const matched=matching.data?.topic;
  const progressDirty=progressTouched.current&&progress!==String(context.data?.last_published_episode??'');
  const dirty=Boolean(text.trim())||formDirty||progressDirty||Boolean(record),dirtyRef=React.useRef(dirty);dirtyRef.current=dirty;
  const dirtyKey=`editorial:${account}`;
  React.useEffect(()=>{if(!series&&columns[0])setSeries(columns[0].code);},[series,columns]);
  React.useEffect(()=>{if(context.data?.series!==series)return;
    if(!issueTouched.current)setIssue(context.data.next_episode===null?'':String(context.data.next_episode));
    if(!progressTouched.current)setProgress(String(context.data.last_published_episode));
  },[context.data,series]);
  React.useEffect(()=>{if(dirty)dirtyStore.markDirty(dirtyKey);else dirtyStore.markClean(dirtyKey);},[dirty,dirtyKey]);
  React.useEffect(()=>{
    const off=registerDirtyFlush(dirtyKey,()=>{if(dirtyRef.current)throw Error('选题与排期有未确认修改，请先保存、带入对话或放弃修改');});
    return()=>{off();dirtyStore.markClean(dirtyKey);};
  },[dirtyKey]);
  const run=async(label:string,action:()=>Promise<void>)=>{
    if(busyRef.current)return;busyRef.current=true;setBusy(label);setError('');
    try{if(accountStore.get()!==account)throw Error('公众号已切换，请重新打开');await action();}
    catch(cause){setError((cause as Error).message||'操作未完成');}
    finally{busyRef.current=false;setBusy('');}
  };
  const ask=(when:boolean,action:()=>void,reason='有修改尚未确认。放弃这些修改后再继续？')=>{
    if(busyRef.current)return;if(!when){action();return;}pending.current=action;setDiscard(reason);
  };
  const resetForm=()=>{setTitle('');setAngle('');setBenefit('');setNext('');setBasis(null);setMode('manual');setFormDirty(false);};
  const install=(row:Topic,nextTitle='')=>{const fields=topicFields(row,[]);setBasis(row);setMode('outline');setTitle(fields.title);setAngle(fields.content_angle);setBenefit(fields.core_benefit);setNext(fields.next_episode_plan||nextTitle);setFormDirty(false);};
  const choose=(row:Topic)=>ask(formDirty||progressDirty,()=>void run('正在读取对应期题…',async()=>{
    const result=await rpc<TopicMatch>('outlines.match',{account_id:account,series:row.series,episode:row.episode,include_available:false});
    if(!result.topic||result.topic.content_hash!==row.content_hash)throw Error('期题已变化，请刷新后重新选择');
    if(accountStore.get()!==account)throw Error('公众号已切换，请重新打开');
    setSeries(row.series);setIssue(String(row.episode));issueTouched.current=true;progressTouched.current=false;install(result.topic,result.next_title);setTab('create');
  }));
  const refresh=async()=>{await context.refetch();await Promise.all([...(number?[matching.refetch()]:[]),...(tab==='outline'?[outlines.refetch()]:[]),...(tab==='history'?[history.refetch()]:[])]);};
  const start=()=>run('正在确认选题并准备创作对话…',async()=>{
    if(text.trim()||progressDirty||record)throw Error('请先保存或放弃大纲、发布记录的修改，再带入本期创作');
    if(!number||!context.data||context.isFetching)throw Error('请填写1–9999期号并等待历史载入');
    if(mode==='outline'&&(!basis||basis.series!==series||basis.episode!==number))throw Error('请重新选择对应期的预设标题');
    const fields:PlanFields={series,episode:number,title_mode:mode,topic:mode==='ai'?`${series}第${number}期选题讨论`:title.trim(),content_angle:angle.trim(),core_benefit:benefit.trim(),next_episode_plan:next.trim()};
    if(!fields.topic)throw Error('请填写或选择本期标题');
    const values={account_id:account,fields,context_hash:context.data.context_hash,...(mode==='outline'?{outline_topic_id:basis!.topic_id,outline_topic_hash:basis!.content_hash}:{})};
    const signature=JSON.stringify(values);
    if(request.current.signature!==signature)request.current={signature,id:crypto.randomUUID()};
    if(!request.current.confirmation)request.current.confirmation=await rpc('planning.confirm',values);
    // The selected form has now been explicitly confirmed. Other unpublished
    // forms were checked above; navigation can flush unrelated editors safely.
    setFormDirty(false);dirtyRef.current=false;dirtyStore.markClean(dirtyKey);
    try{
      await createConversation(request.current.id,{series,title:fields.topic,editorialPlan:request.current.confirmation,
        initialInput:{mode:mode==='ai'?'discuss':'draft',text:editorialInput(fields)}});
      editorialStore.set(false);
    }catch(cause){setFormDirty(true);dirtyRef.current=true;dirtyStore.markDirty(dirtyKey);
      // Preserve both IDs on a transport failure: a committed create whose
      // reply was lost must retry the exact same confirmed request.
      if(/历史|发布进度|大纲题目|确认已变化/.test((cause as Error).message))request.current={signature:'',id:crypto.randomUUID()};
      throw cause;}
  });
  const parse=()=>run('正在识别大纲与对应期题…',async()=>{
    const result=await rpc<OutlinePreview>('outlines.preview',{account_id:account,text,source_name:source});
    if(accountStore.get()!==account)throw Error('公众号已切换，未覆盖当前输入');
    setPreview({...result,rows:result.rows.map(row=>({...row,include:true}))});setReplace(false);setPage(0);
  });
  const read=()=>ask(Boolean(text.trim()),()=>void run('请选择大纲文档…',async()=>{
    if(!window.ice?.importOutline)throw Error('请在桌面程序中读取文档，或直接粘贴文本');
    const result=await window.ice.importOutline(account);
    if(result&&accountStore.get()===account){setText(result.text);setSource(result.source_name);setPreview(null);setPage(0);}
  }),'读取新文档会替换当前大纲文本，尚未保存的内容将丢弃。');
  const save=()=>run('正在保存已确认的期题…',async()=>{
    if(!preview)throw Error('请先识别并预览题目');
    const rows=outlinePayload(preview.rows);
    if(!rows.length)throw Error('至少保留一条题目');
    const result=await rpc<{saved:number}>('outlines.save',{account_id:account,text,source_name:source,rows,return_rows:false,replace_existing:replace,base_hash:preview.base_hash,preview_hash:preview.preview_hash});
    setText('');setPreview(null);setSource('手动粘贴');setReplace(false);await Promise.all([outlines.refetch(),...(number?[matching.refetch()]:[])]);toast.success(`已保存 ${result.saved} 条预设期题`);
  });
  const saveProgress=()=>run('正在登记本地发布进度…',async()=>{
    if(!context.data||!/^(0|[1-9]\d{0,3})$/.test(progress))throw Error('已发布期号需为0–9999');
    await rpc('history.progress',{account_id:account,series,episode:Number(progress),context_hash:context.data.context_hash});
    progressTouched.current=false;issueTouched.current=false;setFormDirty(false);resetForm();await context.refetch();toast.success('本地发布进度已保存');
  });
  const previewPage=outlinePage(preview?.rows??[],page);
  const previewStats=React.useMemo(()=>analyzePreview(preview?.rows??[]),[preview?.rows]);
  const savedWindow=outlines.data??{rows:[],total:0,page:0,pages:1,page_size:10};
  const historyWindow=history.data??{rows:[],total:0,page:0,pages:1,page_size:10};
  const pendingOutline=outlines.isFetching||search!==outlineQuery,pendingHistory=history.isFetching||historySearch!==historyQuery;
  const rowChange=(index:number,key:keyof TopicRow,value:string|number|boolean)=>setPreview(old=>old&&({...old,rows:old.rows.map((row,i)=>i===index?{...row,[key]:value}:row)}));
  return <>
    <Dialog open onOpenChange={nextOpen=>{if(!nextOpen)ask(dirtyRef.current,()=>editorialStore.set(false));}} title="选题与排期" width={940}
      description="先核对历史与期号，再确认本期方向。已确认的要求带入创作对话，由你检查后发送。"
      footer={<Button disabled={Boolean(busy)} onClick={()=>ask(dirtyRef.current,()=>editorialStore.set(false))}>关闭</Button>}>
      <div className="ice-editorial" onKeyDownCapture={event=>{if(busy&&(event.ctrlKey||event.metaKey))event.stopPropagation();}}>
        <div className="ice-editorial__top"><label>当前栏目<select aria-label="排期栏目" disabled={Boolean(busy)} value={series}
          onChange={e=>{const nextSeries=e.target.value;ask(formDirty||progressDirty,()=>{setSeries(nextSeries);setIssue('');issueTouched.current=false;progressTouched.current=false;setSearch('');setSavedPage(0);setHistorySearch('');setStatus('');setHistoryPage(0);resetForm();});}}>
          {columns.map(c=><option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}</select></label>
          <Button size="sm" disabled={Boolean(busy)||context.isFetching} onClick={()=>void run('正在重新读取历史…',refresh)}>刷新历史与题目</Button>
        </div>
        {busy&&<div role="status" className="ice-editorial__progress"><Spinner />{busy}</div>}
        {error&&<ErrorPanel title="操作未完成" detail={error} onDismiss={()=>setError('')} />}
        {context.error&&<ErrorPanel title="历史分析载入失败" detail={context.error.message} onRetry={()=>void context.refetch()} />}
        {outlines.error&&<ErrorPanel title="预设期题载入失败" detail={outlines.error.message} onRetry={()=>void outlines.refetch()} />}
        {matching.error&&<ErrorPanel title="本期期题读取失败" detail={matching.error.message} onRetry={()=>void matching.refetch()} />}
        <Tabs.Root value={tab} onValueChange={setTab}>
          <Tabs.List className="ice-editorial__tabs" aria-label="选题与排期功能"><Tabs.Trigger value="create">本期创作</Tabs.Trigger><Tabs.Trigger value="outline">选题大纲</Tabs.Trigger><Tabs.Trigger value="history">发布记录</Tabs.Trigger></Tabs.List>
          <Tabs.Content value="create" className="ice-editorial__section">
            <fieldset disabled={Boolean(busy)} className="ice-editorial__fields">
              <div className="ice-editorial__row"><Field label="本期期号"><Input aria-label="本期期号" type="number" min={1} max={9999} value={issue}
                onChange={e=>{setIssue(e.target.value);issueTouched.current=true;setBasis(null);setFormDirty(true);}} /></Field>
                <div className="ice-editorial__hint">{context.data?<>本栏已发布到第 {context.data.last_published_episode} 期 · 默认下一期 {context.data.next_episode??'已达9999期上限'}<br />{number!==context.data.next_episode&&'当前使用你选择的期号。'}{context.data.same_episode_drafts>0&&`本期已有 ${context.data.same_episode_drafts} 篇草稿，可先检查避免重复。`}</>:<SkeletonRows rows={2} />}</div></div>
              {context.isFetching&&<span role="status" className="ice-editorial__hint"><Spinner size={12} />正在读取本期之前的历史…</span>}
              {!issueNumber(issue)&&<p className="ice-error-text">请选择1–9999期号；每栏目不限十篇。</p>}
              <div className="ice-editorial__mode" role="group" aria-label="标题来源">{Object.entries(modes).map(([value,label])=><Button key={value} size="sm" variant={mode===value?'primary':'secondary'} aria-pressed={mode===value}
                disabled={value==='outline'&&(!matched||matching.isFetching)} onClick={()=>ask(formDirty,()=>{setMode(value as PlanFields['title_mode']);if(value==='outline'&&matched)install(matched,matching.data?.next_title);else{setBasis(null);setTitle('');setAngle('');setBenefit('');setNext('');setFormDirty(false);}})}>{label}</Button>)}</div>
              {matched&&mode!=='outline'&&<p className="ice-editorial__hint">本期有预设标题：{matched.title}。可点击“采用预设标题”并修改本次创作要求。</p>}
              {mode==='ai'?<Banner title="在创作对话中拟题">将固定本期期号，并把本栏前五篇正文、全部历史标题交给写作模型。先讨论候选方向，再由你决定是否生成初稿。</Banner>:<Field label="确认本期标题"><Input aria-label="确认本期标题" maxLength={30} value={title} onChange={e=>{setTitle(e.target.value);setFormDirty(true);}} /></Field>}
              <Area label="本期内容要点" value={angle} max={300} onChange={v=>{setAngle(v);setFormDirty(true);}} />
              <div className="ice-editorial__row"><Area label="本期读者收益" value={benefit} max={1000} onChange={v=>{setBenefit(v);setFormDirty(true);}} /><Area label="本期下期预告" value={next} max={1000} onChange={v=>{setNext(v);setFormDirty(true);}} /></div>
            {basis&&<p className="ice-editorial__hint">来自预设 {basis.series}/{basis.episode} · 这里的修改只用于本次创作。更新原排期可在大纲中导入同一期并确认覆盖。</p>}
            {/* 批B4：带入前的最终摘要——用户在发起前能看见将使用的标题/栏目/期号与依据范围。 */}
            {number&&context.data&&<p className="ice-editorial__hint" role="status">
              将带入对话：{series} 第 {number} 期 · {mode==='ai'?'AI 讨论选题（进入后再定标题）':`标题「${title.trim()||'（待填写）'}」`}
              {mode==='outline'&&basis?' · 沿用预设期题并可修改':''}。
              依据范围：最近 {context.data.body_history_count} 篇不同期号正文与 {context.data.title_history_count} 个历史标题
              （已发布到第 {context.data.last_published_episode} 期，默认下一期 {context.data.next_episode??'—'}）。
              确认前不会发起任何 AI 请求。
            </p>}
            <Button variant="primary" disabled={!number||context.isFetching||!context.data||(mode!=='ai'&&!title.trim())} onClick={()=>void start()}>确认并带入对话</Button>
            </fieldset>
            {context.data&&<details className="ice-editorial__evidence"><summary>本期参考依据：{context.data.body_history_count} 篇此前正文 · {context.data.title_history_count} 个历史标题</summary>
              <p className="ice-editorial__hint">草稿与已发布内容按原状态提供，不补造缺失文章；完整标题用于避重。这里展示最近五个不同期号的正文。</p>
              {context.data.history.map(row=><details key={row.history_id}><summary>{row.episode} · {row.title} · {row.status==='published'?'已发布':'草稿'}</summary><pre>{row.body_excerpt}</pre></details>)}
              <Button size="sm" onClick={()=>setTab('history')}>查看全部历史记录</Button></details>}
          </Tabs.Content>
          <Tabs.Content value="outline" className="ice-editorial__section">
            <div className="ice-editorial__actions"><Button disabled={Boolean(busy)} onClick={read}>读取大纲文档</Button><Button disabled={Boolean(busy)||!outlines.data} onClick={()=>ask(Boolean(text.trim()),()=>{setText(outlines.data!.example);setSource('示例大纲');setPreview(null);},'填入示例会替换当前大纲文本，未保存的内容将丢弃。')}>填入示例</Button>
              {outlines.data&&<CopyButton text={outlines.data.example} label="复制示例" />}</div>
            <p className="ice-editorial__hint">支持 Markdown、TXT、DOCX；先识别，逐项修改并确认保存。期号1–9999，单次最多1000条，可分批追加。「填入示例」使用应用内置的演示大纲（也可复制仓库 docs/栏目选题大纲-示例.md），示例数据不是你的已发布历史，保存前会逐条预览确认。</p>
            <fieldset disabled={Boolean(busy)} className="ice-editorial__fields"><Field label="大纲来源名称"><Input aria-label="大纲来源名称" maxLength={200} value={source} onChange={e=>{setSource(e.target.value);setPreview(null);}} /></Field>
              <Area label="选题大纲文本" value={text} max={400000} rows={7} onChange={v=>{setText(v);setPreview(null);}} />
              <Button variant="primary" disabled={!text.trim()} onClick={()=>void parse()}>识别并预览题目</Button>
            </fieldset>
            {preview&&<section className="ice-editorial__card" aria-label="大纲识别预览">
              <h3>识别出 {preview.rows.length} 条期题 · 尚未保存</h3>
              {/* 批B1：真实范围摘要——只统计本次实际解析返回的数据。 */}
              <p className="ice-editorial__hint" role="status">
                本次共解析 {previewStats.summary.count} 条（保留 {previewStats.summary.included} 条）
                {previewStats.summary.seriesList.length>0&&` · 栏目 ${previewStats.summary.seriesList.join('、')}`}
                {previewStats.summary.episodeMin!==null&&` · 期号 ${previewStats.summary.episodeMin}–${previewStats.summary.episodeMax}`}
                {` · 预览第 ${previewPage.page+1}/${previewPage.pages} 页`}
                {previewStats.summary.conflicts>0&&` · ${previewStats.summary.conflicts} 条与已存期题同栏目同期号`}
                {previewStats.summary.issues>0&&` · ${previewStats.summary.issues} 处待修正`}
                。保存前不会创建文章，也不会调用模型。
              </p>
              {(preview.errors.length>0||preview.ignored_lines.length>0)&&<Banner tone="warning" title="请对照原文检查识别结果">{preview.errors.slice(0,8).join('；')}{preview.ignored_lines.length>0&&` 有 ${preview.ignored_lines.length} 行未识别。`}可修正以下条目，或取消保留。</Banner>}
              {previewPage.rows.map((row,index)=>{const i=previewPage.start+index;return <fieldset className="ice-editorial__topic" key={i} disabled={Boolean(busy)}>
                <label><input type="checkbox" aria-label={`保留期题 ${i+1}`} checked={row.include!==false} onChange={e=>rowChange(i,'include',e.target.checked)} />保留第 {i+1} 条</label>
                <div className="ice-editorial__row"><Field label="栏目"><select aria-label={`期题 ${i+1} 栏目`} value={row.series} onChange={e=>rowChange(i,'series',e.target.value)}><option value="">请选择</option>{columns.map(c=><option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}</select></Field><Field label="期号"><Input aria-label={`期题 ${i+1} 期号`} type="number" min={1} max={9999} value={row.episode} onChange={e=>rowChange(i,'episode',Number(e.target.value))} /></Field></div>
                <Field label="标题"><Input aria-label={`期题 ${i+1} 标题`} maxLength={30} value={row.title} onChange={e=>rowChange(i,'title',e.target.value)} /></Field>
                {row.existing&&<p className="ice-editorial__hint">已存标题：{row.existing.title}</p>}
                {/* 批B2：可定位的行级预检——不静默截断/合并，修改后即时重算。 */}
                {previewStats.issues[i]?.length>0&&(
                  <ul className="ice-error-text" style={{margin:'2px 0',paddingLeft:18}} aria-label={`期题 ${i+1} 待修正`}>
                    {previewStats.issues[i].map(issue=><li key={issue}>{issue}</li>)}
                  </ul>)}
                {(['content_angle','core_benefit','next_episode_plan'] as const).map((key,n)=><Area key={key} label={`期题 ${i+1} ${['内容要点','读者收益','下期预告'][n]}`} value={row[key]} max={key==='content_angle'?300:1000} onChange={v=>rowChange(i,key,v)} />)}
              </fieldset>;})}
              <Pager page={previewPage.page} pages={previewPage.pages} change={setPage} disabled={Boolean(busy)} />
              {/* 批B3：覆盖确认逐条列明“旧标题→新标题”，新增与覆盖分开；整批契约不变。 */}
              <div className="ice-editorial__check" style={{display:'grid',gap:6}}>
                <span>本次将保存：<strong>{previewStats.additions} 条新增</strong>{previewStats.covering.length>0&&<> · <strong>{previewStats.covering.length} 条覆盖已有期题</strong></>}（整批一起保存，接口不支持逐行提交）。</span>
                {previewStats.covering.length>0&&<>
                  <ul style={{margin:0,paddingLeft:18}} aria-label="将覆盖的已有期题">
                    {previewStats.covering.slice(0,20).map(({row,index})=><li key={index}>第 {index+1} 条 · {row.series}/{row.episode}：<s>{row.existing!.title}</s> → <strong>{row.title||'（标题为空，待修正）'}</strong></li>)}
                    {previewStats.covering.length>20&&<li>…以及另外 {previewStats.covering.length-20} 条</li>}
                  </ul>
                  <p className="ice-editorial__hint">覆盖只替换预设期题本身；已创建的文章与会话不受影响。未勾选覆盖时，同栏目同期号以服务器冲突报错为准，你的预览与修改都会保留。</p>
                  <label><input type="checkbox" checked={replace} disabled={Boolean(busy)} onChange={e=>setReplace(e.target.checked)} />
                    我已逐条核对，确认覆盖上述 {previewStats.covering.length} 条已有期题</label>
                </>}
              </div>
              <Button variant="primary" disabled={Boolean(busy)||!preview.rows.length} onClick={()=>void save()}>
                {previewStats.summary.conflicts>0&&!replace?'需先勾选覆盖确认':'确认并保存期题'}
              </Button>
            </section>}
            <section className="ice-editorial__card" aria-label="已存期题列表" aria-busy={pendingOutline}><h3>已安排的 {series} 期题 · {savedWindow.total} 条</h3><Input aria-label="搜索预设期题" placeholder="搜索期号或标题" maxLength={200} value={search} onChange={e=>{setSearch(e.target.value);setSavedPage(0);}} />
              {pendingOutline&&<span role="status" className="ice-editorial__hint"><Spinner size={12} />正在搜索并读取本页期题…</span>}
              {savedWindow.rows.map(row=><div className="ice-editorial__list-row" key={row.series+row.episode}><span><small>第 {row.episode} 期</small><strong>{row.title}</strong></span><Button size="sm" disabled={Boolean(busy)||pendingOutline} onClick={()=>choose(row)}>选用此期</Button></div>)}
              {!pendingOutline&&!savedWindow.total&&<p className="ice-editorial__hint">还没有匹配的预设期题。可以先填入示例查看格式。</p>}<Pager page={savedWindow.page} pages={savedWindow.pages} change={setSavedPage} disabled={Boolean(busy)||pendingOutline} />
            </section>
          </Tabs.Content>
          <Tabs.Content value="history" className="ice-editorial__section">
            <fieldset disabled={Boolean(busy)} className="ice-editorial__fields"><h3>快速登记已发布进度</h3><p className="ice-editorial__hint">仅更新本地记录，不会向微信发布文章。有效进度取逐篇已发布记录与此处期号的较大值；0表示尚未发布。</p>
              <div className="ice-editorial__row"><Field label="本栏已发布到第几期"><Input aria-label="本栏已发布到第几期" type="number" min={0} max={9999} value={progress} onChange={e=>{setProgress(e.target.value);progressTouched.current=true;}} /></Field>
                <Button disabled={!context.data||context.isFetching||!progressDirty} onClick={()=>ask(formDirty,()=>void saveProgress(),'保存进度后会重新计算默认下一期，当前未确认的本期填写将重置。')}>保存发布进度</Button></div>
            </fieldset>
            {history.isLoading&&<SkeletonRows />}{history.error&&<ErrorPanel title="历史记录读取失败" detail={history.error.message} onRetry={()=>void history.refetch()} />}
            <section className="ice-editorial__section" aria-label="历史文章列表" aria-busy={pendingHistory}><h3>本栏历史文章与未分类记录 · {historyWindow.total} 条</h3>
              <div className="ice-editorial__row"><Input aria-label="搜索历史标题或期号" placeholder="搜索历史标题或期号" maxLength={200} value={historySearch} onChange={e=>{setHistorySearch(e.target.value);setHistoryPage(0);}} />
                <select aria-label="筛选历史发布状态" value={status} onChange={e=>{setStatus(e.target.value);setHistoryPage(0);}}><option value="">全部状态</option><option value="published">已发布</option><option value="draft">草稿</option></select></div>
              {pendingHistory&&<span role="status" className="ice-editorial__hint"><Spinner size={12} />正在读取本页历史…</span>}
              {historyWindow.rows.map(row=><div className="ice-editorial__list-row" key={row.history_id}><span><small>{row.series||'未分类'} / {row.episode??'—'} · {row.status==='published'?`已发布 ${row.published_at}`:'草稿'}</small><strong>{row.title}</strong></span>
                <Button size="sm" disabled={Boolean(busy)||pendingHistory} onClick={()=>void run('正在读取原文快照…',async()=>{const value=await rpc<HistoryRow&{body:string}>('history.get',{account_id:account,history_id:row.history_id});if(accountStore.get()===account)setReading(value);})}>查看原文</Button>
                <Button size="sm" disabled={Boolean(busy)||pendingHistory} onClick={()=>setRecord({...row,series:row.series||series,episode:row.episode||1})}>登记发布状态</Button></div>)}
              {!pendingHistory&&!historyWindow.total&&<p className="ice-editorial__hint">没有匹配的历史记录，请调整标题、期号或发布状态筛选。</p>}
              <Pager page={historyWindow.page} pages={historyWindow.pages} change={setHistoryPage} disabled={Boolean(busy)||pendingHistory} />
            </section>
          </Tabs.Content>
        </Tabs.Root>
      </div>
    </Dialog>
    <Dialog open={Boolean(discard)} onOpenChange={open=>{if(!open){setDiscard('');pending.current=null;}}} title="有修改尚未确认" description={discard}
      footer={<><Button onClick={()=>{setDiscard('');pending.current=null;}}>继续编辑</Button><Button variant="danger" onClick={()=>{const action=pending.current;setDiscard('');pending.current=null;action?.();}}>放弃修改并继续</Button></>}><p>未保存的文章内容不受影响。</p></Dialog>
    {record&&<Dialog open onOpenChange={open=>{if(!open&&!busyRef.current)setRecord(null);}} title="登记文章发布状态" description="只登记实际状态，不会向公众号发送内容。"
      footer={<><Button disabled={Boolean(busy)} onClick={()=>setRecord(null)}>取消登记</Button><Button variant="primary" disabled={Boolean(busy)} onClick={()=>void run('正在保存发布记录…',async()=>{await rpc('history.update',{...record,account_id:account});setRecord(null);await refresh();toast.success('发布记录已保存');})}>保存发布记录</Button></>}>
      <div className="ice-editorial__section"><strong>{record.title}</strong><Field label="文章所属栏目"><select aria-label="文章所属栏目" value={record.series} onChange={e=>setRecord({...record,series:e.target.value})}>{columns.map(c=><option key={c.code} value={c.code}>{c.name}</option>)}</select></Field>
        <Field label="文章期号"><Input aria-label="文章期号" type="number" min={1} max={9999} value={record.episode??''} onChange={e=>setRecord({...record,episode:Number(e.target.value)})} /></Field>
        <Field label="文章发布状态"><select aria-label="文章发布状态" value={record.status} onChange={e=>setRecord({...record,status:e.target.value as HistoryRow['status']})}><option value="draft">草稿</option><option value="published">已发布</option></select></Field>
        {record.status==='published'&&<Field label="实际发布日期"><Input aria-label="实际发布日期" type="date" value={record.published_at} onChange={e=>setRecord({...record,published_at:e.target.value})} /></Field>}
        {error&&<ErrorPanel title="发布记录未保存" detail={error} />}
      </div>
    </Dialog>}
    {reading&&<Dialog open onOpenChange={open=>{if(!open)setReading(null);}} title={reading.title} width={820} description={`${reading.series||'未分类'} / ${reading.episode??'—'} · ${reading.status==='published'?'已发布快照':'历史索引快照'}，此处只读。`}
      footer={<Button onClick={()=>setReading(null)}>关闭原文</Button>}><MarkdownContent text={reading.body} /></Dialog>}
  </>;
}
function Field({label,children}:{label:string;children:React.ReactNode}) {return <label className="ice-editorial__field"><span>{label}</span>{children}</label>;}
function useSearch(value:string) {const [settled,setSettled]=React.useState(value);React.useEffect(()=>{const timer=window.setTimeout(()=>setSettled(value),200);return()=>window.clearTimeout(timer);},[value]);return settled;}
function Area({label,value,onChange,max,rows=2}:{label:string;value:string;onChange:(value:string)=>void;max:number;rows?:number}) {return <Field label={label}><textarea aria-label={label} value={value} onChange={e=>onChange(e.target.value)} maxLength={max} rows={rows} /></Field>;}
function Pager({page,pages,change,disabled}:{page:number;pages:number;change:(n:number)=>void;disabled:boolean}) {return <div className="ice-editorial__pager"><Button size="sm" disabled={disabled||page===0} onClick={()=>change(page-1)}>上一页</Button><span>{page+1} / {pages}</span><Button size="sm" disabled={disabled||page+1>=pages} onClick={()=>change(page+1)}>下一页</Button></div>;}
