import type {DeliveryStorage} from '../../data/chatDelivery';
/** 助手的澄清问题。header/multiple/details 为 v3.1 可选字段；旧消息只有 id/question/options。 */
export type Question={id:string;question:string;options:string[];header?:string;multiple?:boolean;details?:string[]};
export const MAX_QUESTIONS=4;
export function questionsFrom(value:unknown):Question[]{
  if(!Array.isArray(value)||value.length<1||value.length>MAX_QUESTIONS)return [];
  const ids=new Set<string>(),result:Question[]=[];
  for(const row of value){
    if(!row||typeof row!=='object'||typeof row.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(row.id)||ids.has(row.id)||typeof row.question!=='string'||!row.question.trim()||row.question.length>500)return [];
    const options=row.options??[];
    if(!Array.isArray(options)||options.length>4||options.some((option:unknown)=>typeof option!=='string'||!option.trim()||option.length>200)||new Set(options).size!==options.length)return [];
    const item:Question={id:row.id,question:row.question,options};
    if(typeof row.header==='string'&&row.header.trim())item.header=row.header.trim().slice(0,12);
    if(row.multiple===true&&options.length)item.multiple=true;
    if(Array.isArray(row.details)&&row.details.length===options.length&&row.details.every((note:unknown)=>typeof note==='string'&&note.length<=200))item.details=row.details;
    ids.add(row.id);result.push(item);
  }
  return result;
}

/** 单题作答草稿：选中的选项 + 自行填写的内容（单选时“其他”与选项互斥，多选时可并存）。 */
export type Draft={selected:string[];other:string;delegate?:boolean};
export const DELEGATE_ANSWER='（不确定，请按最合理的方式处理，并在回复中说明你的选择）';
export const emptyDraft=():Draft=>({selected:[],other:''});
export function draftAnswer(question:Question,draft:Draft|undefined):string{
  if(!draft)return '';
  if(draft.delegate)return DELEGATE_ANSWER;
  const picked=draft.selected.filter(option=>question.options.includes(option));
  const other=draft.other.trim();
  if(question.multiple)return [picked.join('、'),other].filter(Boolean).join('；');
  return other||picked[0]||'';
}
export function encodeDraft(draft:Draft):string{return JSON.stringify({v:2,s:draft.selected,o:draft.other,d:draft.delegate?1:0});}
export function decodeDraft(question:Question,raw:string|undefined):Draft{
  if(!raw)return emptyDraft();
  try{
    const row=JSON.parse(raw);
    if(row&&row.v===2&&Array.isArray(row.s)&&typeof row.o==='string')
      return {selected:row.s.filter((option:unknown)=>typeof option==='string'&&question.options.includes(option)),other:row.o.slice(0,2000),delegate:row.d===1};
  }catch{/* v1 草稿是纯文本 */}
  // v1 草稿：与某个选项完全相同则视为选中，否则作为自行填写。
  return question.options.includes(raw)?{selected:[raw],other:''}:{selected:[],other:raw.slice(0,2000)};
}
export const answersReady=(questions:Question[],answers:Record<string,string>)=>questions.length>0&&questions.every(row=>typeof answers[row.id]==='string'&&answers[row.id].trim().length>0&&answers[row.id].length<=2000);
// UI 草稿包含选项、自由输入和 JSON 转义，容量与最终提交答案的 2000 字上限分开。
const MAX_STORED_ANSWER=20000,MAX_STORED_RECORD=200000;
const PREFIX='ice.clarification.v1:',INDEX=PREFIX+'index';
export const answerKey=(account:string,conversation:string,message:string)=>PREFIX+JSON.stringify([account,conversation,message]);
export function readAnswers(storage:DeliveryStorage|null,account:string,conversation:string,message:string,questions:Question[]):Record<string,string>{
  try{
    const raw=storage?.getItem(answerKey(account,conversation,message));if(!raw||raw.length>MAX_STORED_RECORD)return {};
    const row=JSON.parse(raw);
    if(row.account!==account||row.conversation!==conversation||row.message!==message||row.questions!==JSON.stringify(questions)||!row.answers||typeof row.answers!=='object'||Array.isArray(row.answers))return {};
    return Object.fromEntries(questions.filter(q=>typeof row.answers[q.id]==='string'&&row.answers[q.id].length<=MAX_STORED_ANSWER).map(q=>[q.id,row.answers[q.id]]));
  }catch{return {};}
}
export function saveAnswers(storage:DeliveryStorage|null,account:string,conversation:string,message:string,questions:Question[],answers:Record<string,string>):boolean{
  try{
    if(!storage)return false;
    const key=answerKey(account,conversation,message),now=Date.now();
    if(questions.some(q=>typeof answers[q.id]==='string'&&answers[q.id].length>MAX_STORED_ANSWER))return false;
    const values=Object.fromEntries(questions.map(q=>[q.id,typeof answers[q.id]==='string'?answers[q.id]:'']));
    const record=JSON.stringify({account,conversation,message,questions:JSON.stringify(questions),answers:values});
    if(record.length>MAX_STORED_RECORD)return false;
    if(Object.values(values).every(value=>!value))storage.removeItem(key);
    else storage.setItem(key,record);
    const raw=storage.getItem(INDEX);const parsed=raw&&raw.length<30000?JSON.parse(raw):[];
    let rows:Array<{key:string;at:number}>=Array.isArray(parsed)?parsed.filter(row=>row&&typeof row.key==='string'&&row.key.startsWith(PREFIX+'[')&&Number.isFinite(row.at)&&row.key!==key):[];
    if(Object.values(values).some(Boolean))rows.push({key,at:now});rows.sort((a,b)=>b.at-a.at);
    rows=rows.filter((row,index)=>{if(index<60&&now-row.at<30*24*3600*1000)return true;storage.removeItem(row.key);return false;});
    storage.setItem(INDEX,JSON.stringify(rows));return true;
  }catch{return false;}
}

export type CitationChoice='inherit'|'selected'|'none';
export function clarificationCitations(choice:CitationChoice,selected:ReadonlyArray<{chunkId:string;hash:string}>):{citations?:Array<{chunk_id:string;hash:string}>}{
  if(choice==='inherit')return {};
  if(choice==='none')return {citations:[]};
  if(!selected.length)throw Error('请先在知识检索中选择需要引用的资料');
  return {citations:selected.map(item=>({chunk_id:item.chunkId,hash:item.hash}))};
}
