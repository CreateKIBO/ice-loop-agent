import {motion} from 'motion/react';
import {ActivityRail,useActivityReducedMotion} from '../../components/ActivityRail';
import {Button} from '../../components/ui';
import {settingsStore} from '../../app/uiState';
import {errorCode} from '../../components/errorText';
import {ErrorNote} from '../../components/ErrorNote';
import type {ChatDelivery} from './useChatDelivery';
import '../../styles/chat-delivery.css';
export function DeliveryNotice({delivery}:{delivery:ChatDelivery}){
  const reduced=useActivityReducedMotion();
  if(!delivery.pending&&!delivery.error&&!delivery.note)return null;
  return <motion.section className="ice-delivery" aria-label="发送状态" initial={reduced?false:{opacity:0}} animate={{opacity:1}} transition={{duration:reduced?0:0.16}}>
    {delivery.pending&&<><div role="status">{delivery.cancelling?'正在取消本次请求…':delivery.busy?'正在确认本次发送…':'这次发送的结果尚未确认'}</div>{delivery.busy&&<ActivityRail />}
      <p>已受理的请求会返回原消息，核对不会重复生成。若此前尚未受理，“核对并继续发送”会继续这一次请求。</p>
      {!delivery.persisted&&<p className="ice-error-text">发送记录暂时只保存在当前进程内，请先完成核对再关闭程序。</p>}
      <details><summary>查看待确认请求</summary><pre>{delivery.pending.payload.text|| (delivery.pending.source==='retry'?'重试原回复':JSON.stringify(delivery.pending.payload.clarification_answers,null,2))}</pre></details>
      <div className="ice-delivery__actions"><Button size="sm" disabled={delivery.busy} onClick={()=>void delivery.resume().catch(()=>{})}>核对并继续发送</Button><Button size="sm" disabled={delivery.cancelling} onClick={()=>void delivery.cancel().catch(()=>{})}>取消这次请求</Button></div>
    </>}
    {delivery.error!=null&&<ErrorNote error={delivery.error} note={delivery.pending?'发送是否受理仍需核对；输入已保留，新输入也不会被覆盖。':undefined} />}
    {['MODEL_BUDGET_EXCEEDED','BUDGET_EXCEEDED'].includes(errorCode(delivery.error))&&<Button size="sm" onClick={()=>settingsStore.set(true)}>打开预算设置</Button>}
    {delivery.note&&<p role="status">{delivery.note}</p>}
  </motion.section>;
}
