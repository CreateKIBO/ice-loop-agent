import * as React from 'react';
import { Banner,Button,Dialog,Input,SkeletonRows } from '../../components/ui';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { toast } from '../../components/toast';
import { applyAccountBootstrap } from '../../data/actions';
import { accountStore,dirtyStore,flushAllDirty,registerDirtyFlush,rpc,useAccountQuery,useCurrentAccount } from '../../data/client';
import { publicationSettingsStore } from '../../app/uiState';
import { brandColors,emptyPublication,publicationDraft,publicationError,publicationFile,publicationPayload } from './publicationModel';
import type { PublicationAccount,PublicationDraft } from './publicationModel';
import '../../styles/publication.css';

type Boot={account:PublicationAccount&{id:string};accounts:Array<{id:string;name:string}>;account_hash:string;saved_account_id?:string};
type Preview={account:PublicationAccount;saved:false};
type Pending='close'|'new'|'reload'|'import'|null;
const Tabs=TabsPrimitive.Root,TabsList=TabsPrimitive.List,TabsContent=TabsPrimitive.Content;
function TabsTrigger({value,children}:{value:string;children:React.ReactNode}) {return <TabsPrimitive.Trigger value={value}>{children}</TabsPrimitive.Trigger>;}

export function PublicationSettings({entry='identity'}:{entry?:'identity'|'new'|'history'}) {
  const account=useCurrentAccount(),query=useAccountQuery<Boot>('bootstrap',{}, {staleTime:0,refetchOnMount:'always'});
  const [draft,setDraft]=React.useState<PublicationDraft|null>(null),[base,setBase]=React.useState(''),[hash,setHash]=React.useState('');
  const [mode,setMode]=React.useState<'edit'|'new'>('edit'),[tab,setTab]=React.useState(entry==='history'?'history':'identity');
  const [busy,setBusy]=React.useState(''),[error,setError]=React.useState<string|null>(null),[pending,setPending]=React.useState<Pending>(null);
  const [preview,setPreview]=React.useState<{value:PublicationAccount;file:string}|null>(null);
  const dirtyRef=React.useRef(false),busyRef=React.useRef(false),ownFlush=React.useRef(false),active=React.useRef(true),generation=React.useRef(0);
  const requestId=React.useRef<string|null>(null),fileInput=React.useRef<HTMLInputElement|null>(null);
  const dirty=Boolean(draft&&JSON.stringify(draft)!==base),dirtyKey='publication:'+account;
  dirtyRef.current=dirty;
  React.useEffect(()=>{active.current=true;return()=>{active.current=false;generation.current++;};},[]);
  React.useEffect(()=>{if(dirty)dirtyStore.markDirty(dirtyKey);else dirtyStore.markClean(dirtyKey);},[dirty,dirtyKey]);
  React.useEffect(()=>{
    const off=registerDirtyFlush(dirtyKey,()=>{if(ownFlush.current)return;if(busyRef.current)throw Error('公众号设置正在处理，请稍候');if(dirtyRef.current)throw Error('公众号资料有未保存修改，请先保存或放弃修改');});
    return()=>{off();dirtyStore.markClean(dirtyKey);};
  },[dirtyKey]);
  const install=(value:PublicationAccount,nextMode:'edit'|'new',contentHash='')=>{
    const next=publicationDraft(value);
    setDraft(next);setMode(nextMode);setHash(contentHash);setBase(JSON.stringify(nextMode==='new'?publicationDraft():next));
    setError(null);setPending(null);requestId.current=null;
  };
  React.useEffect(()=>{if(!draft&&query.data?.account.id===account){
    if(entry==='new')install(emptyPublication(),'new');else install(query.data.account,'edit',query.data.account_hash);
  }},[query.data,account,draft,entry]); // eslint-disable-line react-hooks/exhaustive-deps
  const change=<K extends keyof PublicationDraft>(key:K,value:PublicationDraft[K])=>{
    dirtyRef.current=true;dirtyStore.markDirty(dirtyKey);
    setDraft(previous=>previous&&({...previous,[key]:value}));
  };
  const close=()=>{if(!busyRef.current){if(dirtyRef.current)setPending('close');else publicationSettingsStore.set(false);}};
  const replace=(action:Exclude<Pending,null>)=>{
    if(busyRef.current)return;
    if(dirtyRef.current){setPending(action);return;}
    discard(action);
  };
  const discard=(action:Exclude<Pending,null>)=>{
    if(action==='close'){dirtyRef.current=false;dirtyStore.markClean(dirtyKey);publicationSettingsStore.set(false);return;}
    if(action==='new')install(emptyPublication(),'new');
    if(action==='import'&&preview){install(preview.value,'new');setPreview(null);setTab('identity');}
    if(action==='reload'&&query.data?.account.id===account)install(query.data.account,'edit',query.data.account_hash);
    setPending(null);
  };
  const perform=async(label:string,action:()=>Promise<void>)=>{
    if(busyRef.current)return;
    busyRef.current=true;setBusy(label);setError(null);
    try{await action();}catch(problem){if(active.current)setError((problem as Error).message);}
    finally{busyRef.current=false;if(active.current)setBusy('');}
  };
  const save=()=>void perform('正在保存公众号资料…',async()=>{
    if(!draft) return;
    const problem=publicationError(draft);if(problem)throw Error(problem);
    if(mode==='edit'&&!hash)throw Error('尚未读取到资料版本，请重新载入后保存');
    ownFlush.current=true;
    try{await flushAllDirty();}finally{ownFlush.current=false;}
    if(!active.current||accountStore.get()!==account)return;
    if(mode==='new')requestId.current??=crypto.randomUUID();
    const result=await rpc<Boot>('accounts.save',{account:publicationPayload(draft),expected_account_id:account,
      ...(mode==='new'?{request_id:requestId.current}:{account_hash:hash})});
    if(!active.current||accountStore.get()!==account)return;
    if(result.saved_account_id&&result.saved_account_id!==result.account.id)throw Error('资料已保存，但当前公众号已变化，请关闭后重新选择');
    dirtyRef.current=false;dirtyStore.markClean(dirtyKey);publicationSettingsStore.set(false);
    applyAccountBootstrap(result);
    toast.success({title:'公众号资料已保存',detail:`当前使用「${result.account.name}」`});
  });
  const pick=(kind:'library'|'output')=>void perform('正在选择目录…',async()=>{
    if(!window.ice?.choosePublicationDir)throw Error('请在桌面程序中选择目录，也可以直接填写绝对路径');
    const selected=await window.ice.choosePublicationDir(kind);
    if(active.current&&accountStore.get()===account&&selected)change(kind==='library'?'library_root':'article_root',selected);
  });
  const importFile=(file:File)=>void perform('正在预览品牌资料…',async()=>{
    const token=++generation.current,payload=await publicationFile(file);
    const result=await rpc<Preview>('accounts.preview_import',payload);
    if(active.current&&token===generation.current&&accountStore.get()===account)setPreview({value:result.account,file:file.name});
  });
  const exportCurrent=()=>void perform('正在导出当前公众号配置…',async()=>{
    if(!window.ice?.exportPublication)throw Error('当前环境不支持配置文件导出');
    await flushAllDirty();const result=await window.ice.exportPublication();
    if(result&&active.current)toast.success({title:'公众号配置已导出'});
  });
  const reload=()=>void perform('正在读取最新资料…',async()=>{
    const result=await query.refetch();
    if(result.error)throw result.error;
    if(!active.current)return;
    if(!result.data||result.data.account.id!==account)throw Error('当前公众号已变化，请保留输入并重新选择公众号');
    if(dirtyRef.current)setPending('reload');else install(result.data.account,'edit',result.data.account_hash);
  });
  return <Dialog open onOpenChange={open=>{if(!open)close();}} title="公众号与品牌" width={960}
    description="设置读者、栏目和品牌规范。已有任务继续使用创建时的规范，新内容使用保存后的资料。"
    footer={pending?<>
      <span className="ice-publication__hint" style={{flex:1}} role="status">有修改尚未保存。</span>
      <Button onClick={()=>setPending(null)}>继续编辑</Button>
      <Button variant="danger" onClick={()=>discard(pending)}>{pending==='close'?'放弃修改并关闭':pending==='new'?'放弃修改并新增':pending==='import'?'放弃修改并使用资料':'放弃修改并载入'}</Button>
    </>:<>
      <span className="ice-publication__hint" style={{flex:1}} role="status">{busy||(dirty?'修改尚未保存':mode==='new'?'填写后创建独立公众号':'当前资料已保存')}</span>
      <Button disabled={Boolean(busy)} onClick={close}>关闭</Button>
      <Button variant="primary" loading={Boolean(busy)} disabled={!draft||(mode==='edit'&&!dirty)} onClick={save}>保存并使用</Button>
    </>}>
    <div className="ice-publication">
      <div className="ice-publication__tools"><span className="ice-badge">{mode==='new'?'新增公众号':'编辑当前公众号'}</span><span style={{flex:1}} />
        <Button size="sm" disabled={Boolean(busy)} onClick={()=>replace('new')}>新增公众号</Button>
        <Button size="sm" disabled={Boolean(busy)} onClick={()=>fileInput.current?.click()}>导入品牌资料</Button>
        {mode==='edit'&&<Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={reload}>载入最新资料</Button>}
        <Button size="sm" variant="ghost" disabled={Boolean(busy)||dirty||mode==='new'} onClick={exportCurrent}>导出配置</Button>
        <input ref={fileInput} type="file" accept=".json,.md,.txt" aria-label="导入公众号品牌资料文件" className="ice-sr-only" tabIndex={-1}
          onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)importFile(file);}} />
      </div>
      {error&&<Banner tone="danger" title="资料尚未保存">{error}。当前输入保留。</Banner>}
      {query.error&&<Banner tone="warning" title="读取资料失败">{query.error.message}<Button size="sm" onClick={()=>void query.refetch()}>重试读取</Button></Banner>}
      {preview&&<Banner title="资料预览 · 尚未保存">
        <div className="ice-publication__import"><strong>{preview.value.name}</strong><span>{preview.file}</span>
          <p>{preview.value.audience==='请设置你的目标读者'?'品牌说明已保留，请在使用前确认名称和目标读者。':preview.value.audience}</p>
          <Button size="sm" disabled={Boolean(busy)} onClick={()=>replace('import')}>用这份资料新增公众号</Button>
          <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={()=>setPreview(null)}>取消导入</Button>
        </div>
      </Banner>}
      {!draft&&<SkeletonRows rows={6} height={32} />}
      {draft&&<div className="ice-publication__layout">
        <Tabs value={tab} onValueChange={setTab} className="ice-publication__editor">
          <TabsList className="ice-publication__tabs" aria-label="公众号资料分类"><TabsTrigger value="identity">账号与读者</TabsTrigger><TabsTrigger value="style">品牌与栏目</TabsTrigger><TabsTrigger value="history">历史与目录</TabsTrigger></TabsList>
          <fieldset disabled={Boolean(busy)} className="ice-publication__fields">
            <TabsContent value="identity" className="ice-publication__section">
              <Field label="公众号名称"><Input aria-label="公众号名称" maxLength={500} value={draft.name} onChange={event=>change('name',event.target.value)} placeholder="你的公众号名称" /></Field>
              <Field label="目标读者"><Input aria-label="目标读者" maxLength={500} value={draft.audience} onChange={event=>change('audience',event.target.value)} placeholder="例如：希望把想法做成作品的在校学生" /></Field>
              <Area label="内容定位" value={draft.positioning} max={2000} onChange={value=>change('positioning',value)} hint="介绍你主要写什么，以及读者能得到什么。" />
              <Field label="表达风格"><Input aria-label="表达风格" maxLength={500} value={draft.persona} onChange={event=>change('persona',event.target.value)} /></Field>
              <Field label="品牌标语"><Input aria-label="品牌标语" maxLength={500} value={draft.slogan} onChange={event=>change('slogan',event.target.value)} /></Field>
              <Area label="品牌说明原文" value={draft.brand_document} max={20000} rows={6} onChange={value=>change('brand_document',value)} hint="可保留导入的品牌说明；保存前可逐项编辑，不会自动创建文章。" />
            </TabsContent>
            <TabsContent value="style" className="ice-publication__section">
              <Field label="配图品牌色"><Input aria-label="配图品牌色" maxLength={100} value={draft.colors} onChange={event=>change('colors',event.target.value)} placeholder="#2448DB, #15191F, #F3F2ED" /></Field>
              <Field label="配图风格"><Input aria-label="配图风格" maxLength={500} value={draft.image_style} onChange={event=>change('image_style',event.target.value)} /></Field>
              <Area label="视觉规范" value={draft.visual_brief} max={6000} onChange={value=>change('visual_brief',value)} hint="说明构图、字体、参考图的使用要求，以及应避免的视觉元素。" />
              <div className="ice-publication__row"><Field label="最少字数"><Input aria-label="最少字数" type="number" min={300} max={10000} value={draft.words_range[0]} onChange={event=>change('words_range',[event.target.value,draft.words_range[1]])} /></Field>
                <Field label="最多字数"><Input aria-label="最多字数" type="number" min={300} max={10000} value={draft.words_range[1]} onChange={event=>change('words_range',[draft.words_range[0],event.target.value])} /></Field></div>
              <div className="ice-publication__tools"><strong>内容栏目</strong><span style={{flex:1}} /><Button size="sm" disabled={draft.columns.length>=12} onClick={()=>change('columns',[...draft.columns,{code:'',name:''}])}>添加栏目</Button></div>
              <p className="ice-publication__hint">栏目代码用于关联期号和历史文章，修改资料时请保留已有代码。</p>
              {draft.columns.map((column,index)=><div key={index} className="ice-publication__column">
                <Input aria-label={`栏目 ${index+1} 代码`} maxLength={12} placeholder="ART" value={column.code} onChange={event=>change('columns',draft.columns.map((row,i)=>i===index?{...row,code:event.target.value.toUpperCase()}:row))} />
                <Input aria-label={`栏目 ${index+1} 名称`} maxLength={60} placeholder="栏目名称" value={column.name} onChange={event=>change('columns',draft.columns.map((row,i)=>i===index?{...row,name:event.target.value}:row))} />
                <Button size="sm" variant="ghost" disabled={draft.columns.length<=1} aria-label={`移除栏目 ${index+1}`} onClick={()=>change('columns',draft.columns.filter((_,i)=>i!==index))}>移除</Button>
              </div>)}
              <Field label="文章结尾标题"><Input aria-label="文章结尾标题" maxLength={50} value={draft.ending_heading} onChange={event=>change('ending_heading',event.target.value)} /></Field>
              <Area label="文末品牌句" value={draft.closing_sentence} max={500} onChange={value=>change('closing_sentence',value)} />
              <Area label="禁用词" value={draft.banned_text} max={6100} onChange={value=>change('banned_text',value)} hint="每行一个，最多100项；不填写时不额外限制。" />
            </TabsContent>
            <TabsContent value="history" className="ice-publication__section">
              <Field label="已有文章目录"><div className="ice-publication__path"><Input aria-label="已有文章目录" maxLength={1000} value={draft.library_root} onChange={event=>change('library_root',event.target.value)} placeholder="选择存放Markdown文章的文件夹" /><Button size="sm" onClick={()=>pick('library')}>选择历史目录</Button></div></Field>
              <p className="ice-publication__hint">只读关联原稿，用于拟题和引用。未标注的历史不会被猜测为已发布。</p>
              <Field label="新文章输出目录"><div className="ice-publication__path"><Input aria-label="新文章输出目录" maxLength={1000} value={draft.article_root} onChange={event=>change('article_root',event.target.value)} placeholder="留空使用此公众号的独立目录" /><Button size="sm" onClick={()=>pick('output')}>选择输出目录</Button></div></Field>
              <HistoryFiles enabled={mode==='edit'&&tab==='history'&&Boolean(query.data?.account.library_root)&&draft.library_root===query.data?.account.library_root} changed={draft.library_root!==query.data?.account.library_root} />
            </TabsContent>
          </fieldset>
        </Tabs>
        <aside className="ice-publication__preview" aria-label="公众号品牌预览">
          <span className="ice-publication__eyebrow">你的内容品牌</span><h2>{draft.name||'公众号名称'}</h2><p>{draft.slogan||'在这里写下你的品牌标语'}</p>
          <div className="ice-publication__palette">{brandColors(draft.colors).map((color,index)=><span key={color+index} style={{backgroundColor:color}} title={color} />)}</div>
          <strong>写给谁</strong><p>{draft.audience||'确认你的目标读者'}</p><strong>内容栏目</strong><p>{draft.columns.map(row=>row.name||row.code).filter(Boolean).join(' · ')||'添加你的内容栏目'}</p>
          <span className="ice-publication__hint">{draft.id?'保存后用于后续创作':'新公众号拥有独立会话、存稿和资源'}</span>
        </aside>
      </div>}
    </div>
  </Dialog>;
}

function Field({label,children}:{label:string;children:React.ReactNode}) {return <label className="ice-publication__field"><span>{label}</span>{children}</label>;}
function Area({label,value,onChange,max,rows=3,hint}:{label:string;value:string;onChange:(value:string)=>void;max:number;rows?:number;hint?:string}) {
  return <Field label={label}><textarea aria-label={label} rows={rows} maxLength={max} value={value} onChange={event=>onChange(event.target.value)} />{hint&&<small className="ice-publication__hint">{hint}</small>}</Field>;
}
function HistoryFiles({enabled,changed}:{enabled:boolean;changed:boolean}) {
  const rows=useAccountQuery<Array<{folder:string;title:string;series?:string;episode?:number}>>('library.list',{}, {enabled,staleTime:30000});
  const [search,setSearch]=React.useState(''),[page,setPage]=React.useState(0);
  const filtered=(rows.data??[]).filter(row=>(row.title+' '+row.folder).toLowerCase().includes(search.toLowerCase())),pages=Math.max(1,Math.ceil(filtered.length/12)),current=Math.min(page,pages-1);
  if(!enabled)return <p className="ice-publication__hint">{changed?'保存目录后，重新打开这里即可查看关联原稿。':'可稍后关联历史文章，也可以从新选题开始。'}</p>;
  return <section className="ice-publication__section" aria-label="已关联历史文章"><strong>可引用存稿 · {rows.data?.length??0} 篇</strong>
    <Input aria-label="搜索历史文章" placeholder="按标题或目录搜索" value={search} onChange={event=>{setSearch(event.target.value);setPage(0);}} />
    {rows.isLoading&&<SkeletonRows rows={3} height={28} />}{rows.error&&<Banner tone="warning" title="暂未读取到文章">{rows.error.message}<Button size="sm" onClick={()=>void rows.refetch()}>重试</Button></Banner>}
    {filtered.slice(current*12,current*12+12).map(row=><div key={row.folder} className="ice-publication__history-row"><span className="ice-badge">{row.series||'未归类'}{row.episode?' / '+row.episode:''}</span><span>{row.title}</span></div>)}
    {!rows.isLoading&&!rows.error&&!filtered.length&&<p className="ice-publication__hint">{search?'没有匹配的文章':'目录中暂未找到可读取的Markdown正文。'}</p>}
    {pages>1&&<div className="ice-publication__tools"><Button size="sm" disabled={!current} onClick={()=>setPage(current-1)}>上一页</Button><span>{current+1} / {pages}</span><Button size="sm" disabled={current>=pages-1} onClick={()=>setPage(current+1)}>下一页</Button></div>}
  </section>;
}
