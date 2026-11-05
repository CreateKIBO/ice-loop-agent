import * as React from 'react';
import {motion} from 'motion/react';
import {useActivityReducedMotion} from '../../components/ActivityRail';
import type {ChatMessage} from '../../data/workbenchResponses';
import type {ChatDelivery} from './useChatDelivery';
import {questionsFrom} from './clarification';
import '../../styles/chat-delivery.css';

/**
 * 对话流中的问题记录。v3.1 起逐题作答在输入框上方的提问框（QuestionDock）中完成；
 * 这里只保留：待答提示、已确认回答的摘要、以及过期问题的说明。
 */
export function ClarificationForm({row,active}:{row:ChatMessage;account:string;conversation:string;active:boolean;delivery:ChatDelivery}){
  const questions=React.useMemo(()=>questionsFrom(row.metadata?.questions),[row.metadata?.questions]);
  const reduced=useActivityReducedMotion();
  if(!questions.length)return null;
  const answered=row.metadata?.clarification_status==='answered'||Boolean(row.metadata?.answered_at);
  const answers=(row.metadata?.answers??{}) as Record<string,unknown>;
  return <motion.section className="ice-clarification" aria-label={answered?'已确认的信息':'助手的问题'} initial={reduced?false:{opacity:0}} animate={{opacity:1}} transition={{duration:reduced?0:0.16}}>
    <h3>{answered?'已确认的信息':`助手有 ${questions.length} 个问题`}</h3>
    {answered?<dl>{questions.map(question=><div key={question.id}><dt>{question.question}</dt>
      <dd>{typeof answers[question.id]==='string'?String(answers[question.id]):'已通过自由回答补充，请查看后续消息'}</dd></div>)}</dl>
    :<>
      <ol className="ice-clarification__list">{questions.map(question=><li key={question.id}>{question.question}</li>)}</ol>
      <p className="ice-clarification__hint">{active?'请在下方的提问框中逐题选择或填写；也可以直接在输入框自由回复。':'这是此前的问题，请在最新回复中继续，或直接在输入框补充要求。'}</p>
    </>}
  </motion.section>;
}
