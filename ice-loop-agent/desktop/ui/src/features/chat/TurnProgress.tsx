import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { formatElapsed, turnSteps, type StreamEvent } from "../../data/eventStream";

import { ActivityRail,useDocumentVisible } from '../../components/ActivityRail';
import { progressFeedback } from './progressFeedback';

function useNow(active: boolean, intervalMs = 1000): {now:number;visible:boolean} {
  const visible=useDocumentVisible();
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active||!visible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, visible,intervalMs]);
  return {now,visible};
}

/** C1：生成中显示引擎事件里的真实步骤与已用时间；没有事件时退回消息元数据的阶段。 */
export function TurnProgress({ events, turnId, metadata }: { events: StreamEvent[]; turnId: string; metadata: unknown }) {
  const progress = React.useMemo(() => turnSteps(events, turnId), [events, turnId]);
  const feedback=progressFeedback(progress,metadata);
  const startedAt=feedback.startedAt;
  const {now,visible} = useNow(feedback.active);
  const started = startedAt ? Date.parse(startedAt) : NaN;
  const ended=feedback.finishedAt?Date.parse(feedback.finishedAt):NaN;
  const label=feedback.label,detail=feedback.detail;
  return (
    <div className="ice-turn-progress" data-tone={feedback.tone} data-active={feedback.active&&visible}>
      <div className="ice-turn-progress__head">
        {feedback.active?<span className="ice-typing" aria-hidden="true"><span /><span /><span /></span>
          :<span className="ice-turn-progress__signal" aria-hidden="true" />}
        <span role="status" aria-live="polite" aria-atomic="true">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={label} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                       exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16 }}
                       className="ice-turn-progress__label">
            {label}{detail ? <span className="ice-turn-progress__detail"> · {detail}</span> : null}
          </motion.span>
        </AnimatePresence>
        </span>
        {Number.isFinite(started)&&(feedback.active||Number.isFinite(ended)) && (
          <span className="ice-turn-progress__elapsed" title={feedback.active?"从发送到现在的真实耗时":"截至处理结束或状态更新的用时"}>
            {feedback.active?"已用":"用时"} {formatElapsed((Number.isFinite(ended)?ended:now) - started)}
          </span>
        )}
      </div>
      <ActivityRail active={feedback.active} tone={feedback.tone} />
      {feedback.steps.length > 1 && (
        <ol className="ice-turn-steps" aria-label="本轮步骤">
          <AnimatePresence initial={false}>
            {feedback.steps.map(step => (
              <motion.li key={step.key} layout initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
                         transition={{ type: "spring", stiffness: 420, damping: 34 }}
                         aria-current={step.status==="active"?"step":undefined}
                         className={"ice-turn-step ice-turn-step--" + step.status}
                         title={step.detail}>
                <span className="ice-turn-step__dot" aria-hidden />
                {step.label}
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      )}
    </div>
  );
}

