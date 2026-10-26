/** Bounded account/thread outbox. Unknown acceptance is never auto-resubmitted. */
import {validate_chat_send_request,validate_chat_send_response,validate_chat_receipt_response} from '../contracts';
import type {IChatSendRequest,IChatSendResponse} from '../contracts/types.gen';
import {loadComposerDraft,saveComposerDraft} from './composerDraft';
export type ChatPayload=Omit<IChatSendRequest,'conversation_id'|'request_id'>;
export type ChatAcceptance=Extract<IChatSendResponse,{accepted:true}>;
export type ChatCancelled=Extract<IChatSendResponse,{accepted:false}>;
export type DeliveryRecord={version:1;account:string;conversation:string;requestId:string;payload:ChatPayload;createdAt:number;source:'composer'|'retry'|'clarification';draftEditId?:string};
export type DeliveryStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const PREFIX='ice.delivery.v1:',INDEX=PREFIX+'index',MAX_RECORD=512*1024,MAX_TOTAL=2*1024*1024,MAX_COUNT=60;
const memory=new Map<string,{record:DeliveryRecord;persisted:boolean;bytes:number}>();
export const deliveryKey=(account:string,conversation:string)=>PREFIX+JSON.stringify([account,conversation]);
export const deliveryParams=(record:DeliveryRecord)=>({...record.payload,conversation_id:record.conversation,request_id:record.requestId});
export function deliveryStorage():DeliveryStorage|null {try{return window.localStorage;}catch{return null;}}
function decode(raw:string|null,account:string,conversation:string):DeliveryRecord|null{
  if(!raw||raw.length*2>MAX_RECORD)return null;
  try{const value=JSON.parse(raw);
    if(value.version!==1||value.account!==account||value.conversation!==conversation||typeof value.requestId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(value.requestId)
      ||!Number.isFinite(value.createdAt)||!['composer','retry','clarification'].includes(value.source)
      ||!value.payload||typeof value.payload!=='object'||Array.isArray(value.payload)||!validate_chat_send_request(deliveryParams(value)))return null;
    return value;
  }catch{return null;}
}
export function readDelivery(storage:DeliveryStorage|null,account:string,conversation:string):{record:DeliveryRecord|null;persisted:boolean}{
  const key=deliveryKey(account,conversation),cached=memory.get(key);
  if(cached&&!cached.persisted)return {...cached};
  try{const value=decode(storage?.getItem(key)??null,account,conversation);if(value)return {record:value,persisted:true};}catch{}
  return cached?{record:cached.record,persisted:cached.persisted}:{record:null,persisted:true};
}
function putMemory(key:string,record:DeliveryRecord,persisted:boolean,bytes:number){
  memory.delete(key);
  let total=[...memory.values()].reduce((sum,item)=>sum+item.bytes,0);
  while(memory.size>=MAX_COUNT||total+bytes>MAX_TOTAL){
    const removable=[...memory].find(([,item])=>item.persisted);
    if(!removable){if(persisted)return;throw Error('未确认发送内容较多，无法在内存中保留，请先核对已有请求');}
    total-=removable[1].bytes;memory.delete(removable[0]);
  }
  memory.set(key,{record,persisted,bytes});
}
function readIndex(storage:DeliveryStorage){
  const raw=storage.getItem(INDEX);if(raw&&raw.length>65536)throw Error('发送记录索引过大，请先检查本地存储');
  const value=raw?JSON.parse(raw):[];
  if(!Array.isArray(value)||value.length>MAX_COUNT)throw Error('发送记录索引无法读取，请先检查本地存储');
  return value.filter((row):row is {key:string;bytes:number}=>row&&typeof row.key==='string'&&row.key.startsWith(PREFIX+'[')&&row.key.length<500&&Number.isSafeInteger(row.bytes)&&row.bytes>=0);
}
export function saveDelivery(storage:DeliveryStorage|null,record:DeliveryRecord):{record:DeliveryRecord;persisted:boolean}{
  const raw=JSON.stringify(record),bytes=raw.length*2,key=deliveryKey(record.account,record.conversation);
  if(bytes>MAX_RECORD||!decode(raw,record.account,record.conversation))throw Error('发送记录超出容量或参数无效，请减少附加资料');
  let persisted=false;
  if(storage)try{
    const index=readIndex(storage).filter(row=>row.key!==key);
    if(index.length>=MAX_COUNT||index.reduce((sum,row)=>sum+row.bytes,0)+bytes>MAX_TOTAL)throw Object.assign(Error('未确认的发送记录已达上限，请先在原会话核对或取消'),{capacity:true});
    storage.setItem(key,raw);storage.setItem(INDEX,JSON.stringify([...index,{key,bytes}]));persisted=true;
  }catch(error){if((error as {capacity?:boolean}).capacity)throw error;}
  putMemory(key,record,persisted,bytes);return {record,persisted};
}
export function clearDelivery(storage:DeliveryStorage|null,record:DeliveryRecord):boolean{
  const key=deliveryKey(record.account,record.conversation),cached=memory.get(key);
  if(cached?.record.requestId===record.requestId)memory.delete(key);
  try{
    if(!storage)return false;
    const current=decode(storage.getItem(key),record.account,record.conversation);
    if(current?.requestId!==record.requestId)return !current;
    storage.removeItem(key);storage.setItem(INDEX,JSON.stringify(readIndex(storage).filter(row=>row.key!==key)));return true;
  }catch{return false;}
}
export function clearAcknowledgedComposer(storage:DeliveryStorage|null,record:DeliveryRecord){
  if(!storage||record.source!=='composer'||!record.draftEditId)return;
  const draft=loadComposerDraft(storage,record.account,record.conversation);
  if(draft.editId===record.draftEditId&&draft.text.trim()===record.payload.text&&draft.mode===(record.payload.mode??'discuss'))
    saveComposerDraft(storage,record.account,record.conversation,{text:'',mode:draft.mode});
}
export function parseDeliveryResponse(value:unknown):IChatSendResponse{
  if(!validate_chat_send_response(value))throw Error('发送回执格式无效，原输入保留，请先核对发送结果');
  return value as IChatSendResponse;
}
export function parseReceiptResponse(value:unknown):IChatSendResponse|null{
  if(!validate_chat_receipt_response(value))throw Error('发送核对结果格式无效，请稍后重试');
  return (value as {found?:boolean}).found===false?null:value as IChatSendResponse;
}
export const deliveryMemoryStats=()=>({entries:memory.size,bytes:[...memory.values()].reduce((sum,item)=>sum+item.bytes,0)});
