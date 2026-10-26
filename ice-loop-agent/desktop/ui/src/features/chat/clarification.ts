import type {DeliveryStorage} from '../../data/chatDelivery';
export type Question={id:string;question:string;options:string[]};
export function questionsFrom(value:unknown):Question[]{
  if(!Array.isArray(value)||value.length<1||value.length>3)return [];
  const ids=new Set<string>(),result:Question[]=[];
  for(const row of value){
    if(!row||typeof row!=='object'||typeof row.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(row.id)||ids.has(row.id)||typeof row.question!=='string'||!row.question.trim()||row.question.length>500)return [];
    const options=row.options??[];
    if(!Array.isArray(options)||options.length>4||options.some((option:unknown)=>typeof option!=='string'||!option.trim()||option.length>200)||new Set(options).size!==options.length)return [];
    ids.add(row.id);result.push({id:row.id,question:row.question,options});
  }
  return result;
}
export const answersReady=(questions:Question[],answers:Record<string,string>)=>questions.length>0&&questions.every(row=>typeof answers[row.id]==='string'&&answers[row.id].trim().length>0&&answers[row.id].length<=2000);
const PREFIX='ice.clarification.v1:',INDEX=PREFIX+'index';
export const answerKey=(account:string,conversation:string,message:string)=>PREFIX+JSON.stringify([account,conversation,message]);
export function readAnswers(storage:DeliveryStorage|null,account:string,conversation:string,message:string,questions:Question[]):Record<string,string>{
  try{
    const raw=storage?.getItem(answerKey(account,conversation,message));if(!raw||raw.length>30000)return {};
    const row=JSON.parse(raw);
    if(row.account!==account||row.conversation!==conversation||row.message!==message||row.questions!==JSON.stringify(questions)||!row.answers||typeof row.answers!=='object'||Array.isArray(row.answers))return {};
    return Object.fromEntries(questions.filter(q=>typeof row.answers[q.id]==='string'&&row.answers[q.id].length<=2000).map(q=>[q.id,row.answers[q.id]]));
  }catch{return {};}
}
export function saveAnswers(storage:DeliveryStorage|null,account:string,conversation:string,message:string,questions:Question[],answers:Record<string,string>):boolean{
  try{
    if(!storage)return false;
    const key=answerKey(account,conversation,message),now=Date.now();
    const values=Object.fromEntries(questions.map(q=>[q.id,typeof answers[q.id]==='string'?answers[q.id].slice(0,2000):'']));
    if(Object.values(values).every(value=>!value))storage.removeItem(key);
    else storage.setItem(key,JSON.stringify({account,conversation,message,questions:JSON.stringify(questions),answers:values}));
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
