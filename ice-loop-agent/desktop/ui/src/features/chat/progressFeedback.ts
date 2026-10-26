import type {TurnProgress,StepStatus} from '../../data/eventStream';
import {PHASE_LABEL,phaseFromMetadata} from '../../data/eventStream';

/** Terminal events win over stale streaming metadata. A stopped task never
 * keeps an indeterminate animation alive while its message refresh is late. */
export function progressFeedback(progress:TurnProgress,metadata:unknown) {
  const fallback=phaseFromMetadata(metadata);
  const terminalPhase=fallback&&['ready','failed','stopped','interrupted','awaiting_input'].includes(fallback.phase)?fallback.phase:null;
  const finished=progress.finished;
  const active=!finished&&!terminalPhase;
  const last=progress.steps.at(-1);
  const status=finished?.status??terminalPhase;
  const waiting=finished?.phase==='awaiting_input'||terminalPhase==='awaiting_input';
  const tone:'working'|'success'|'warning'|'danger'=active?'working':waiting||status==='stopped'||status==='interrupted'?'warning':status==='failed'?'danger':'success';
  const label=finished?(last?.label??(waiting?PHASE_LABEL.awaiting_input:PHASE_LABEL[status??'ready']??PHASE_LABEL.ready))
    :terminalPhase?PHASE_LABEL[terminalPhase]:progress.current?.label??fallback?.label??'正在生成…';
  const settled:StepStatus=tone==='danger'?'failed':tone==='success'?'done':'stopped';
  const steps=active?progress.steps:progress.steps.map(step=>step.status==='active'?{...step,status:settled}:step);
  return {active,tone,label,steps,detail:active?progress.current?.detail:undefined,
    startedAt:progress.startedAt??fallback?.startedAt,finishedAt:finished?last?.at:undefined};
}
