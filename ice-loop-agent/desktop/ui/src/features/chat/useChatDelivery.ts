import * as React from 'react';
import {queryClient,rpc,RpcError} from '../../data/client';
import {clearAcknowledgedComposer,clearDelivery,deliveryParams,deliveryStorage,parseDeliveryResponse,parseReceiptResponse,readDelivery,saveDelivery,type ChatPayload,type DeliveryRecord,type ChatAcceptance} from '../../data/chatDelivery';
export function useChatDelivery(account:string,conversation:string|null){
  const [initial]=React.useState(()=>readDelivery(deliveryStorage(),account,conversation||''));
  const [pending,setPending]=React.useState(initial.record),[persisted,setPersisted]=React.useState(initial.persisted);
  const [busy,setBusy]=React.useState(Boolean(initial.record)),[error,setError]=React.useState<unknown>(null);
  const [cancelling,setCancelling]=React.useState(false);
  const cancelLock=React.useRef(false),activeRequest=React.useRef<string|null>(initial.record?.requestId??null);
  const [note,setNote]=React.useState(''),[acceptedId,setAcceptedId]=React.useState<string|null>(null);
  // The id only bridges acceptance -> first query observation, never later windows.
  const observeAccepted=React.useCallback((id:string)=>setAcceptedId(current=>current===id?null:current),[]);
  const [settlement,setSettlement]=React.useState<{record:DeliveryRecord;result:ReturnType<typeof parseDeliveryResponse>}|null>(null);
  const locked=React.useRef(Boolean(initial.record)),pendingRef=React.useRef(pending);
  pendingRef.current=pending;
  const acknowledge=React.useCallback((record:DeliveryRecord,result:ReturnType<typeof parseDeliveryResponse>)=>{
    clearDelivery(deliveryStorage(),record);
    if(result.accepted)clearAcknowledgedComposer(deliveryStorage(),record);
    void queryClient.invalidateQueries({queryKey:['ice',account,'chat.get']});
    return result;
  },[account]);
  const present=(record:DeliveryRecord,result:ReturnType<typeof parseDeliveryResponse>,cancel=false)=>{
    if(activeRequest.current!==record.requestId&&pendingRef.current?.requestId!==record.requestId)return;
    activeRequest.current=null;locked.current=false;setBusy(false);
    setSettlement({record,result});
    setPending(null);pendingRef.current=null;setError(null);
    if(result.accepted){setAcceptedId(result.status==='streaming'?result.message_id:null);setNote(cancel&&result.status==='stopped'?'本次请求已受理，已停止这条回复；远端已处理的部分仍可能计费。':result.status==='failed'?'请求已受理，但回复未能生成。原需求已保存，可在消息下重试。':result.replayed?'已找到本次发送的原结果，没有再次生成。':'');}
    else setNote('本次未确认发送已取消，原输入保留。');
  };
  React.useEffect(()=>{
    if(!initial.record||!conversation){locked.current=false;setBusy(false);return;}
    let live=true;const record=initial.record;
    void rpc('chat.receipt',{account_id:account,...deliveryParams(record)}).then(value=>{
      const result=parseReceiptResponse(value);
      if(result){acknowledge(record,result);if(live)present(record,result);}
      else if(live)setNote('有一条发送尚未确认。可核对并继续，或取消这次请求；不会自动发送。');
    }).catch(cause=>{if(live)setError(cause);}).finally(()=>{if(live&&activeRequest.current===record.requestId){locked.current=false;setBusy(false);}});
    return()=>{live=false;};
  // One read-only mount check. No automatic model request on reload/StrictMode.
  },[account,conversation,initial,acknowledge]);
  const run=async(record:DeliveryRecord):Promise<ChatAcceptance|null>=>{
    if(locked.current)return null;
    locked.current=true;activeRequest.current=record.requestId;setBusy(true);setError(null);setNote('');
    try{
      let result:ReturnType<typeof parseDeliveryResponse>;
      if(window.ice?.sendChat){
        const packet=await window.ice.sendChat({account_id:account,...deliveryParams(record)});
        if(packet.ok)result=parseDeliveryResponse(packet.result);
        else{
          const reason=new RpcError(packet.error.code,packet.error.message,packet.error.recoverable,packet.error.action);
          // An engine reply proves the request handler ended. A timeout/closed
          // transport does not; first check the durable receipt in either case.
          let known:ReturnType<typeof parseDeliveryResponse>|null=null,checked=false;
          try{known=parseReceiptResponse(await rpc('chat.receipt',{account_id:account,...deliveryParams(record)}));checked=true;}catch{}
          if(known)result=known;
          else{if(packet.error.settled&&checked){clearDelivery(deliveryStorage(),record);if(activeRequest.current===record.requestId){setPending(null);pendingRef.current=null;setNote('本次请求未受理，输入已保留，调整后可重新发送。');}}throw reason;}
        }
      }else result=parseDeliveryResponse(await rpc('chat.send',{account_id:account,...deliveryParams(record)}));
      acknowledge(record,result);present(record,result);return result.accepted?result:null;
    }catch(cause){if(activeRequest.current===record.requestId)setError(cause);throw cause;}
    finally{if(activeRequest.current===record.requestId){locked.current=false;setBusy(false);}}
  };
  const send=async(payload:ChatPayload,source:DeliveryRecord['source'],draftEditId?:string)=>{
    if(locked.current)return null;
    let record:DeliveryRecord;
    try{
      if(pendingRef.current)throw Error('请先核对或取消上一条未确认发送，新输入已保留');
      if(!account||!conversation)throw Error('请先选择公众号与创作会话');
      record={version:1,account,conversation,requestId:crypto.randomUUID(),payload:JSON.parse(JSON.stringify(payload)) as ChatPayload,source,draftEditId,createdAt:Date.now()};
      const saved=saveDelivery(deliveryStorage(),record);setPersisted(saved.persisted);setPending(record);pendingRef.current=record;
    }catch(cause){setError(cause);setNote('本次新请求尚未发出，输入已保留。');throw cause;}
    return run(record);
  };
  const resume=()=>pendingRef.current?run(pendingRef.current):Promise.resolve(null);
  const cancel=async()=>{
    const record=pendingRef.current;
    if(!record||cancelLock.current)return null;
    cancelLock.current=true;setCancelling(true);setError(null);
    try{
      const result=parseDeliveryResponse(await rpc('chat.cancel_send',{account_id:account,...deliveryParams(record)}));
      acknowledge(record,result);present(record,result,true);return result.accepted?result:null;
    }catch(cause){setError(cause);throw cause;}
    finally{cancelLock.current=false;setCancelling(false);}
  };
  return {busy,cancelling,pending,persisted,error,note,acceptedId,observeAccepted,settlement,send,resume,cancel};
}
export type ChatDelivery=ReturnType<typeof useChatDelivery>;
