export type Topic = {topic_id:string;series:string;episode:number;title:string;content_angle:string;core_benefit:string;next_episode_plan:string;content_hash:string};
export type TopicRow = Pick<Topic,'series'|'episode'|'title'|'content_angle'|'core_benefit'|'next_episode_plan'> & {include?:boolean;existing?:Topic|null;source_line?:number};
export type OutlinePreview = {rows:TopicRow[];errors:string[];ignored_lines:number[];base_hash:string;preview_hash:string;source_name:string};
export type OutlineList = {rows:Topic[];example:string};
export type DataPage<T> = {rows:T[];total:number;page:number;pages:number;page_size:number};
export type OutlinePage = DataPage<Topic> & {example:string};
export type TopicMatch = {topic:Topic|null;next_title:string;available:Array<{topic_id:string;episode:number;title:string;content_hash:string}>};
export type HistoryRow = {history_id:string;series:string;episode:number|null;title:string;status:'draft'|'published';published_at:string;content_hash:string};
export type PlanningContext = {account_id:string;series:string;context_hash:string;reference_episode:number;last_published_episode:number;next_episode:number|null;
  title_history_count:number;body_history_count:number;same_episode_drafts:number;history:Array<{history_id:string;title:string;episode:number;status:string;body_excerpt:string}>;previous_exercise:string;previous_preview:string};
export type PlanFields = {series:string;episode:number;topic:string;title_mode:'manual'|'outline'|'ai';content_angle:string;core_benefit:string;next_episode_plan:string};
export function topicFields(row:Topic,topics:Topic[]) {
  return {title:row.title,content_angle:row.content_angle,core_benefit:row.core_benefit,
    next_episode_plan:row.next_episode_plan||topics.find(next=>next.series===row.series&&next.episode===row.episode+1)?.title||''};
}
export function issueNumber(value:string):number|null {
  return /^\d{1,4}$/.test(value)&&Number(value)>=1&&Number(value)<=9999?Number(value):null;
}
export function editorialInput(fields:PlanFields) {
  return (fields.title_mode==='ai'?`请根据本栏目前五篇文章正文和全部历史标题，为 ${fields.series} 第${fields.episode}期提出3–5个选题供我审阅。`:
    `请为 ${fields.series} 第${fields.episode}期准备初稿，标题已由我确认：${fields.topic}。保留这个标题，不重新拟题。`)
    +[fields.content_angle&&`内容要点：${fields.content_angle}`,fields.core_benefit&&`读者收益：${fields.core_benefit}`,fields.next_episode_plan&&`下期预告：${fields.next_episode_plan}`].filter(Boolean).map(s=>'\n'+s).join('');
}
export function outlinePayload(rows:TopicRow[]) {
  return rows.filter(row=>row.include!==false).map(({series,episode,title,content_angle,core_benefit,next_episode_plan})=>({series,episode,title,content_angle,core_benefit,next_episode_plan}));
}
export function outlinePage<T>(rows:T[],page:number,size=8) {
  const pages=Math.max(1,Math.ceil(rows.length/size)),current=Math.min(Math.max(page,0),pages-1);
  return {page:current,pages,start:current*size,rows:rows.slice(current*size,(current+1)*size)};
}

// ---- 批B（2026-10-22）：大纲导入摘要 / 行级预检 / 覆盖清单的纯推导 ----
// 预检只基于本次识别返回且仍在预览中的行；未加载的全库冲突不由前端声称覆盖。

export type PreviewSummary = {
  count:number; included:number; seriesList:string[];
  episodeMin:number|null; episodeMax:number|null; conflicts:number; issues:number;
};
export type PreviewAnalysis = {
  summary: PreviewSummary;
  /** 与 rows 索引对齐的每行预检结果（单遍计算，渲染层直接取用）。 */
  issues: string[][];
  /** 将被覆盖的行（include 且 existing）及其原始索引；additions 为新增条数。 */
  covering: Array<{ row: TopicRow; index: number }>;
  additions: number;
};

/** B1+B2+B3 的单遍分析：重复检测用“同栏目+合法期号 → 首次出现索引”映射，
 *  避免 O(行数²) 的逐行全表扫描（上限 1000 条时每次键入都重算会明显卡顿）。 */
export function analyzePreview(rows:TopicRow[]):PreviewAnalysis {
  // 两遍：先收集每个“栏目+合法期号”的全部出现索引，重复组的每一行都能互相定位
  // （只标后续行会让首次出现者不知道自己被重复，与逐行独立入口的行为不一致）。
  const indicesByKey=new Map<string,number[]>();
  const keyOf=(series:string,episode:number)=>`${series}#${episode}`;
  rows.forEach((row,index)=>{
    if(row.include===false)return;
    const episode=Number(row.episode);
    if(!row.series||!Number.isInteger(episode)||episode<1||episode>9999)return;
    const key=keyOf(row.series,episode);
    const list=indicesByKey.get(key);
    if(list)list.push(index);else indicesByKey.set(key,[index]);
  });
  const issues=rows.map((row,index)=>{
    const list:string[]=[];
    if(row.include===false)return list; // 已取消保留的行不再计入
    const title=row.title??'';
    if(!row.series)list.push('缺少栏目');
    const episode=Number(row.episode);
    if(!Number.isInteger(episode)||episode<1||episode>9999)list.push('期号需为1–9999的整数');
    if(!title.trim())list.push('标题为空');
    else if(title.length>30)list.push(`标题 ${title.length} 字，超过30字上限`);
    if(row.series&&Number.isInteger(episode)&&episode>=1&&episode<=9999){
      const group=indicesByKey.get(keyOf(row.series,episode));
      if(group&&group.length>1){
        const other=group[0]===index?group[1]:group[0];
        list.push(`与预览第 ${other+1} 条重复（同栏目同期号）`);
      }
    }
    return list;
  });
  const included: Array<{ row: TopicRow; index: number }> = [];
  const seriesSet = new Set<string>();
  const episodes: number[] = [];
  rows.forEach((row, index) => {
    if (row.include === false) return;
    included.push({ row, index });
    if (row.series) seriesSet.add(row.series);
    if (Number.isInteger(row.episode) && row.episode >= 1 && row.episode <= 9999) episodes.push(row.episode);
  });
  const covering = included.filter(entry => entry.row.existing);
  return {
    summary: {
      count: rows.length, included: included.length,
      seriesList: [...seriesSet],
      episodeMin: episodes.length ? Math.min(...episodes) : null,
      episodeMax: episodes.length ? Math.max(...episodes) : null,
      conflicts: covering.length,
      issues: issues.reduce((total, list) => total + list.length, 0),
    },
    issues,
    covering,
    additions: included.length - covering.length,
  };
}

/** B1：预览真实范围摘要（只统计本次实际解析的数据）。 */
export function previewSummary(rows:TopicRow[]):PreviewSummary {
  return analyzePreview(rows).summary;
}

/** B2：单行预检（标题空白/过长、期号不合法、缺栏目、预览内重复栏目+期号）。
 *  逐行渲染请优先用 analyzePreview 的预计算结果；此独立入口保留给单行核对与测试。 */
export function previewRowIssues(row:TopicRow,allRows:TopicRow[]):string[] {
  const issues:string[]=[];
  const title=row.title??'';
  if(row.include===false)return issues; // 已取消保留的行不再计入
  if(!row.series)issues.push('缺少栏目');
  const episode=Number(row.episode);
  if(!Number.isInteger(episode)||episode<1||episode>9999)issues.push('期号需为1–9999的整数');
  if(!title.trim())issues.push('标题为空');
  else if(title.length>30)issues.push(`标题 ${title.length} 字，超过30字上限`);
  if(row.series&&Number.isInteger(episode)&&episode>=1&&episode<=9999){
    // 预览内重复：跨页也检查（rows 是本次识别的完整内存集合）。
    const twins=allRows.filter(other=>other!==row&&other.include!==false&&other.series===row.series&&Number(other.episode)===episode);
    if(twins.length)issues.push(`与预览第 ${allRows.indexOf(twins[0])+1} 条重复（同栏目同期号）`);
  }
  return issues;
}
