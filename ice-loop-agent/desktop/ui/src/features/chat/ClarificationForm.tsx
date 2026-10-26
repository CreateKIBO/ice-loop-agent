import * as React from 'react';
import {motion} from 'motion/react';
import {Button} from '../../components/ui';
import {useActivityReducedMotion} from '../../components/ActivityRail';
import {useCitations} from '../../data/client';
import {deliveryStorage} from '../../data/chatDelivery';
import type {ChatMessage} from '../../data/workbenchResponses';
import type {ChatDelivery} from './useChatDelivery';
import {answersReady,questionsFrom,readAnswers,saveAnswers,clarificationCitations,type CitationChoice} from './clarification';
import '../../styles/chat-delivery.css';
export function ClarificationForm({row,account,conversation,active,delivery}:{row:ChatMessage;account:string;conversation:string;active:boolean;delivery:ChatDelivery}){
  const questions=React.useMemo(()=>questionsFrom(row.metadata?.questions),[row.metadata?.questions]);
  return questions.length?<QuestionFields key={row.id+JSON.stringify(questions)} row={row} account={account} conversation={conversation} active={active} delivery={delivery} questions={questions}/>:null;
}
function QuestionFields({row,account,conversation,active,delivery,questions}:{row:ChatMessage;account:string;conversation:string;active:boolean;delivery:ChatDelivery;questions:ReturnType<typeof questionsFrom>}){
  const [answers,setAnswers]=React.useState(()=>readAnswers(deliveryStorage(),account,conversation,row.id,questions));
  const citations=useCitations(),[citationChoice,setCitationChoice]=React.useState<CitationChoice>('inherit');
  const citationReady=citationChoice!=='selected'||citations.length>0;
  const [persisted,setPersisted]=React.useState(true),reduced=useActivityReducedMotion();
  const answered=row.metadata?.clarification_status==='answered'||Boolean(row.metadata?.answered_at);
  const signature=JSON.stringify(questions);
  React.useEffect(()=>{setPersisted(saveAnswers(deliveryStorage(),account,conversation,row.id,questions,answered?{}:answers));},[account,conversation,row.id,signature,answers,answered]);
  const disabled=!active||answered||delivery.busy||Boolean(delivery.pending);
  const update=(id:string,value:string)=>setAnswers(current=>({...current,[id]:value}));
  return <motion.form className="ice-clarification" aria-label="补充创作信息" initial={reduced?false:{opacity:0}} animate={{opacity:1}} transition={{duration:reduced?0:0.16}}
    onSubmit={event=>{event.preventDefault();if(disabled||!citationReady||!answersReady(questions,answers))return;void delivery.send({...clarificationCitations(citationChoice,citations),clarification_message_id:row.id,clarification_answers:Object.fromEntries(questions.map(q=>[q.id,answers[q.id].trim()]))},'clarification').catch(()=>{});}}>
    <h3>{answered?'已确认的信息':'确认后继续创作'}</h3>
    {answered?<div><p className="ice-clarification__hint">这些回答已随原需求保存。</p><dl>{questions.map(question=><div key={question.id}><dt>{question.question}</dt><dd>{typeof (row.metadata?.answers as Record<string,unknown>|undefined)?.[question.id]==='string'?String((row.metadata!.answers as Record<string,unknown>)[question.id]):'已通过自由回答补充，请查看后续消息'}</dd></div>)}</dl></div>:<fieldset disabled={disabled}>
      {questions.map(question=><div className="ice-clarification__question" key={question.id}>
        <strong>{question.question}</strong>
        {question.options.length>0&&<div className="ice-clarification__options" role="group" aria-label={question.question+'的建议回答'}>{question.options.map(option=><Button key={option} size="sm" type="button" aria-pressed={answers[question.id]===option} onClick={()=>update(question.id,option)}>{option}</Button>)}</div>}
        <label><span className="ice-clarification__hint">选择建议后也可修改，或自行填写</span><textarea aria-label={question.question+'的回答'} value={answers[question.id]??''} onChange={event=>update(question.id,event.target.value)} rows={2} maxLength={2000}/></label>
      </div>)}
      <label className="ice-clarification__sources"><span>本次知识引文</span><select aria-label="本次知识引文" value={citationChoice} onChange={event=>setCitationChoice(event.target.value as CitationChoice)}>
        <option value="inherit">沿用原请求的引用</option><option value="selected">改用当前选中的 {citations.length} 条引用</option><option value="none">本次不使用知识引文</option>
      </select><span className="ice-clarification__hint">继续使用原来选择的模型。引用过期时，可先重新检索，再选择改用当前引用；这项选择不会自动发送。</span></label>
      <Button variant="primary" type="submit" disabled={!citationReady||!answersReady(questions,answers)} loading={delivery.busy}>确认回答并继续生成</Button>
    </fieldset>}
    {!answered&&!active&&<p className="ice-clarification__hint">这是此前的问题，请在最新回复中继续，或直接在输入框补充要求。</p>}
    {!answered&&!persisted&&<p className="ice-error-text">回答暂时无法保存到本地，请保留窗口或复制内容。</p>}
  </motion.form>;
}
