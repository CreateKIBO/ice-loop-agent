// v3.1 助手提问框：像常见 Agent 那样逐题作答——每题给出可选项（单选/多选，含说明），
// 随时可“自己填写”或“交给助手判断”；最后一步核对全部回答再提交。
// 停靠在输入框上方；可收起后直接在输入框自由回复（引擎按自由回答处理，问题保持待答）。
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { Button } from "../../components/ui";
import { useActivityReducedMotion } from "../../components/ActivityRail";
import { useCitations } from "../../data/client";
import { deliveryStorage } from "../../data/chatDelivery";
import type { ChatMessage } from "../../data/workbenchResponses";
import type { ChatDelivery } from "./useChatDelivery";
import {
  DELEGATE_ANSWER, clarificationCitations, decodeDraft, draftAnswer, emptyDraft, encodeDraft, questionsFrom, readAnswers, saveAnswers,
  type CitationChoice, type Draft, type Question,
} from "./clarification";
import "../../styles/questions.css";

const OTHER_LIMIT = 1800;

/** 最新一条助手回复若有待答问题，返回该消息；否则 null。 */
export function pendingQuestionRow(rows: ChatMessage[] | undefined): ChatMessage | null {
  const last = rows?.filter(row => row.role === "assistant").at(-1);
  if (!last || last.status !== "completed") return null;
  const meta = last.metadata ?? {};
  if (meta.clarification_status === "answered" || meta.answered_at || meta.clarification_status === "superseded") return null;
  return questionsFrom(meta.questions).length ? last : null;
}

export function QuestionDock({ row, account, conversation, delivery, disabled }: {
  row: ChatMessage; account: string; conversation: string; delivery: ChatDelivery; disabled: boolean;
}) {
  const questions = React.useMemo(() => questionsFrom(row.metadata?.questions), [row.metadata?.questions]);
  if (!questions.length) return null;
  return <Dock key={row.id + JSON.stringify(questions)} row={row} account={account} conversation={conversation}
               delivery={delivery} disabled={disabled} questions={questions} />;
}

function Dock({ row, account, conversation, delivery, disabled, questions }: {
  row: ChatMessage; account: string; conversation: string; delivery: ChatDelivery; disabled: boolean; questions: Question[];
}) {
  const reduced = useActivityReducedMotion();
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>(() => {
    const stored = readAnswers(deliveryStorage(), account, conversation, row.id, questions);
    return Object.fromEntries(questions.map(q => [q.id, decodeDraft(q, stored[q.id])]));
  });
  const firstOpen = Math.max(0, questions.findIndex(q => !draftAnswer(q, drafts[q.id])));
  const [step, setStep] = React.useState(() => questions.every(q => draftAnswer(q, drafts[q.id])) ? questions.length : firstOpen);
  const [collapsed, setCollapsed] = React.useState(false);
  const [persisted, setPersisted] = React.useState(true);
  const citations = useCitations();
  const [citationChoice, setCitationChoice] = React.useState<CitationChoice>("inherit");
  const [error, setError] = React.useState<string | null>(null);
  const signature = JSON.stringify(questions);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const advanceTimer = React.useRef<number | undefined>(undefined);
  const focusStep = React.useRef<number | null>(null);
  React.useEffect(() => () => window.clearTimeout(advanceTimer.current), []);

  React.useEffect(() => {
    setPersisted(saveAnswers(deliveryStorage(), account, conversation, row.id, questions,
      Object.fromEntries(questions.map(q => [q.id, isEmpty(drafts[q.id]) ? "" : encodeDraft(drafts[q.id])]))));
  }, [account, conversation, row.id, signature, drafts]); // eslint-disable-line react-hooks/exhaustive-deps

  const answers = Object.fromEntries(questions.map(q => [q.id, draftAnswer(q, drafts[q.id])]));
  const answeredCount = questions.filter(q => answers[q.id]).length;
  const overlong = questions.filter(q => answers[q.id].length > 2000);
  const allAnswered = answeredCount === questions.length && !overlong.length;
  const reviewing = step >= questions.length;
  const locked = disabled || delivery.busy || Boolean(delivery.pending);
  const citationReady = citationChoice !== "selected" || citations.length > 0;

  const update = (id: string, next: (draft: Draft) => Draft) => {
    window.clearTimeout(advanceTimer.current);
    setError(null);
    setDrafts(current => ({ ...current, [id]: next(current[id] ?? emptyDraft()) }));
  };
  const go = (index: number) => {
    window.clearTimeout(advanceTimer.current);
    const next = Math.max(0, Math.min(questions.length, index));
    focusStep.current = next;
    if (next === step) boxRef.current?.querySelector<HTMLElement>(".ice-qbox__body [data-autofocus]")?.focus();
    setStep(next);
  };
  /** 单选题选中后自动进入下一题（未答的优先），像常见 Agent 的问答框一样连贯。 */
  const advanceFrom = (index: number, nextDrafts: Record<string, Draft>) => {
    window.clearTimeout(advanceTimer.current);
    advanceTimer.current = window.setTimeout(() => {
      const after = questions.findIndex((q, i) => i > index && !draftAnswer(q, nextDrafts[q.id]));
      const before = questions.findIndex(q => !draftAnswer(q, nextDrafts[q.id]));
      go(after >= 0 ? after : before >= 0 ? before : questions.length);
    }, reduced ? 0 : 220);
  };
  const pick = (question: Question, index: number, option: string) => {
    if (locked) return;
    window.clearTimeout(advanceTimer.current);
    const current = drafts[question.id] ?? emptyDraft();
    let next: Draft;
    if (question.multiple) {
      const has = current.selected.includes(option);
      next = { ...current, delegate: false, selected: has ? current.selected.filter(o => o !== option) : [...current.selected, option] };
    } else {
      next = { selected: [option], other: "", delegate: false };
    }
    const nextDrafts = { ...drafts, [question.id]: next };
    setDrafts(nextDrafts); setError(null);
    if (!question.multiple) advanceFrom(index, nextDrafts);
  };
  const delegate = (question: Question, index: number) => {
    if (locked) return;
    window.clearTimeout(advanceTimer.current);
    const nextDrafts = { ...drafts, [question.id]: { selected: [], other: "", delegate: !drafts[question.id]?.delegate } };
    setDrafts(nextDrafts);
    if (nextDrafts[question.id].delegate) advanceFrom(index, nextDrafts);
  };

  const submit = async () => {
    if (locked) return;
    if (overlong.length) { setError("回答含所选选项最多 2000 字，请缩短补充内容；原输入已保留"); go(questions.indexOf(overlong[0])); return; }
    if (!allAnswered) { setError("还有问题没有回答"); go(questions.findIndex(q => !answers[q.id])); return; }
    if (!citationReady) { setError("请先在知识检索中选择需要引用的资料，或改用其他引用方式"); return; }
    try {
      await delivery.send({ ...clarificationCitations(citationChoice, citations), clarification_message_id: row.id,
        clarification_answers: Object.fromEntries(questions.map(q => [q.id, answers[q.id].trim()])) }, "clarification");
    } catch (problem) { setError((problem as Error)?.message || "发送失败，回答已保留，可稍后重试"); }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const target = event.target as HTMLElement;
    if (["SELECT", "SUMMARY", "A"].includes(target.tagName)) return;
    const typing = target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && (target as HTMLInputElement).type === "text");
    if (event.key === "Escape") { event.preventDefault(); setCollapsed(true); return; }
    if (typing) {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); reviewing ? void submit() : go(step + 1); }
      return;
    }
    if (reviewing) {
      if (event.key === "ArrowLeft") { event.preventDefault(); go(step - 1); }
      return;
    }
    const question = questions[step];
    const digit = Number(event.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= question.options.length) { event.preventDefault(); pick(question, step, question.options[digit - 1]); return; }
    if (event.key === "ArrowRight" || (event.key === "Enter" && target.tagName !== "BUTTON")) { event.preventDefault(); go(step + 1); }
    if (event.key === "ArrowLeft") { event.preventDefault(); go(step - 1); }
  };

  if (collapsed) {
    return (
      <div className="ice-qbox ice-qbox--collapsed" role="region" aria-label="助手的问题">
        <span className="ice-qbox__badge">{answeredCount}/{questions.length}</span>
        <span>助手有 {questions.length} 个问题等你确认。也可以直接在下方输入框自由回复。</span>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="primary" onClick={() => { setCollapsed(false); go(Math.min(step, questions.length)); }}>继续回答</Button>
      </div>
    );
  }

  const question = reviewing ? null : questions[step];
  const draft = question ? drafts[question.id] ?? emptyDraft() : null;
  return (
    <motion.div ref={boxRef} className="ice-qbox" role="region" aria-label="助手的问题" onKeyDown={onKeyDown}
                initial={reduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduced ? 0 : 0.18 }}>
      <div className="ice-qbox__head">
        <strong>需要你确认</strong>
        <nav className="ice-qbox__tabs" aria-label="问题列表">
          {questions.map((q, index) => (
            <button key={q.id} type="button" className="ice-qbox__tab" aria-current={step === index ? "step" : undefined}
                    data-done={answers[q.id] ? "true" : undefined} onClick={() => go(index)} title={q.question}>
              <span className="ice-qbox__tick" aria-hidden>{answers[q.id] ? "✓" : index + 1}</span>
              {q.header || `问题 ${index + 1}`}
            </button>
          ))}
          <button type="button" className="ice-qbox__tab" aria-current={reviewing ? "step" : undefined} onClick={() => go(questions.length)}
                  data-done={allAnswered ? "true" : undefined}>
            <span className="ice-qbox__tick" aria-hidden>✔</span>提交
          </button>
        </nav>
        <span style={{ flex: 1 }} />
        <button type="button" className="ice-link-btn" onClick={() => setCollapsed(true)} title="收起后可在输入框自由回复（Esc）">收起</button>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={reviewing ? "review" : question!.id} className="ice-qbox__body"
                    ref={element => {
                      if (!element || focusStep.current !== step) return;
                      focusStep.current = null;
                      const active = document.activeElement;
                      if (active === document.body || boxRef.current?.contains(active)) element.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
                    }}
                    initial={reduced ? false : { opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={reduced ? undefined : { opacity: 0, x: -10 }}
                    transition={{ duration: reduced ? 0 : 0.14 }}>
          {question && draft ? (
            <fieldset disabled={locked} className="ice-qbox__question">
              <legend>{question.question}{question.multiple && <span className="ice-qbox__hint">（可多选）</span>}</legend>
              <div className="ice-qbox__options" role={question.multiple ? "group" : "radiogroup"} aria-label={question.question}>
                {question.options.map((option, index) => {
                  const selected = draft.selected.includes(option);
                  return (
                    <button key={option} type="button" className="ice-qbox__option" role={question.multiple ? "checkbox" : "radio"}
                            aria-checked={selected} data-autofocus={index === 0 ? "" : undefined} onClick={() => pick(question, step, option)}>
                      <span className={"ice-qbox__mark" + (question.multiple ? " is-check" : "")} aria-hidden>{selected ? (question.multiple ? "✓" : "●") : ""}</span>
                      <span className="ice-qbox__label">
                        <span>{option}</span>
                        {question.details?.[index] && <span className="ice-qbox__desc">{question.details[index]}</span>}
                      </span>
                      <kbd aria-hidden>{index + 1}</kbd>
                    </button>
                  );
                })}
                <div className={"ice-qbox__other" + (draft.other.trim() ? " is-filled" : "")}>
                  <label htmlFor={`q-other-${row.id}-${question.id}`}>
                    {question.options.length ? (question.multiple ? "补充其他（可选）" : "其他：自己填写") : "你的回答"}
                  </label>
                  <textarea id={`q-other-${row.id}-${question.id}`} rows={question.options.length ? 2 : 3} maxLength={OTHER_LIMIT}
                            data-autofocus={question.options.length ? undefined : ""} value={draft.other}
                            placeholder={question.options.length ? "不在选项里？直接写下你的想法" : "写下你的回答"}
                            onChange={event => { const value = event.target.value; update(question.id, d => ({ selected: question.multiple ? d.selected : (value.trim() ? [] : d.selected), other: value, delegate: false })); }} />
                </div>
              </div>
              {answers[question.id].length > 2000 && <p className="ice-error-text" role="alert">回答含所选选项共 {answers[question.id].length} 字，最多 2000 字。请缩短补充内容，原输入已保留。</p>}
              <div className="ice-qbox__foot">
                <button type="button" className={"ice-link-btn" + (draft.delegate ? " is-on" : "")} aria-pressed={Boolean(draft.delegate)}
                        onClick={() => delegate(question, step)} title={DELEGATE_ANSWER}>
                  {draft.delegate ? "✓ 已交给助手判断" : "不确定，交给助手判断"}</button>
                <span style={{ flex: 1 }} />
                <span className="ice-qbox__hint">{question.options.length ? "数字键选择 · " : ""}Enter 下一题 · Esc 收起</span>
                <Button size="sm" variant="ghost" disabled={step === 0} onClick={() => go(step - 1)}>上一题</Button>
                <Button size="sm" variant={answers[question.id] ? "primary" : "secondary"} onClick={() => go(step + 1)}>
                  {step === questions.length - 1 ? "检查并提交" : answers[question.id] ? "下一题" : "跳到下一题"}</Button>
              </div>
            </fieldset>
          ) : (
            <div className="ice-qbox__review">
              <ol>
                {questions.map((q, index) => (
                  <li key={q.id} data-missing={answers[q.id] ? undefined : "true"}>
                    <button type="button" className="ice-qbox__review-row" onClick={() => go(index)} title="修改这个回答">
                      <span className="ice-qbox__review-q">{q.question}</span>
                      <span className="ice-qbox__review-a">{answers[q.id] || "尚未回答"}</span>
                    </button>
                  </li>
                ))}
              </ol>
              <details className="ice-qbox__more">
                <summary>知识引用：{citationChoice === "inherit" ? "沿用原请求" : citationChoice === "none" ? "本次不使用" : `改用当前选中的 ${citations.length} 条`}</summary>
                <select aria-label="本次知识引文" value={citationChoice} onChange={event => setCitationChoice(event.target.value as CitationChoice)}>
                  <option value="inherit">沿用原请求的引用</option><option value="selected">改用当前选中的 {citations.length} 条引用</option><option value="none">本次不使用知识引文</option>
                </select>
                <p className="ice-qbox__hint">继续使用原来选择的模型；这项选择不会自动发送。</p>
              </details>
              <div className="ice-qbox__foot">
                <span className="ice-qbox__hint">{overlong.length ? `有 ${overlong.length} 个回答超过 2000 字，请返回缩短。`
                  : allAnswered ? "确认无误后提交，助手会据此继续生成。" : `还有 ${questions.length - answeredCount} 个问题没有回答`}</span>
                <span style={{ flex: 1 }} />
                <Button size="sm" variant="ghost" onClick={() => go(questions.length - 1)}>返回修改</Button>
                <Button size="sm" variant="primary" data-autofocus="" disabled={locked || !allAnswered || !citationReady} loading={delivery.busy}
                        onClick={() => void submit()}>提交回答并继续</Button>
              </div>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
      {error && <p className="ice-error-text" role="alert">{error}</p>}
      {!persisted && <p className="ice-error-text">回答暂时无法保存到本地，请保留窗口。</p>}
      {disabled && !delivery.busy && <p className="ice-qbox__hint">助手正在回复，稍后即可提交。</p>}
    </motion.div>
  );
}

function isEmpty(draft: Draft | undefined) {
  return !draft || (!draft.selected.length && !draft.other.trim() && !draft.delegate);
}
