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
