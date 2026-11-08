// P2 发布日历：按月显示“计划发布”（文章上的计划日期）与“已登记发布”（人工登记的发布记录）。
// 日历只做排期与回顾，不触发任何发布。
import * as React from "react";

import { Button, SkeletonRows } from "../../components/ui";
import { ErrorNote } from "../../components/ErrorNote";
import { toast } from "../../components/toast";
import { queryClient, useAccountQuery, useCurrentAccount } from "../../data/client";
import { docRpc, invalidateDocuments, type DocumentSummary } from "./documentsApi";
import { openDocument } from "./documentNav";

type CalendarItem = { kind: "planned" | "published"; date: string; document_id: string; title: string;
  published?: boolean; url?: string; series?: string | null; episode?: number | null };
type CalendarData = { month: string; planned: CalendarItem[]; published: CalendarItem[]; unplanned_count: number };

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
const pad = (value: number) => String(value).padStart(2, "0");
const monthKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

export function ArticleCalendar({ documents }: { documents: DocumentSummary[] }) {
  const account = useCurrentAccount();
  const [cursor, setCursor] = React.useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const month = monthKey(cursor);
  const data = useAccountQuery<CalendarData>("documents.calendar", { month }, { staleTime: 0 });
  const [pick, setPick] = React.useState<string | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["ice", account, "documents.calendar"] });
    void invalidateDocuments(account);
  };
  const schedule = async (documentId: string, date: string | null) => {
    try { await docRpc("documents.plan", { document_id: documentId, planned_date: date }); refresh(); }
    catch (error) { toast.error({ title: "排期没有保存", detail: (error as Error).message }); }
  };

  const first = new Date(cursor);
  const offset = (first.getDay() + 6) % 7; // 周一开头
  const days = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const cells: Array<string | null> = [...Array(offset).fill(null), ...Array.from({ length: days }, (_, i) => `${month}-${pad(i + 1)}`)];
  while (cells.length % 7) cells.push(null);
  const byDay = new Map<string, CalendarItem[]>();
  for (const item of [...(data.data?.published ?? []), ...(data.data?.planned ?? [])]) {
    const list = byDay.get(item.date) ?? [];
    // 已登记发布的文章不再重复显示“计划”。
    if (item.kind === "planned" && item.published) continue;
    list.push(item); byDay.set(item.date, list);
  }
  const unplanned = documents.filter(d => !d.planned_date && !d.published && d.generation_state !== "running");
  const today = todayKey();

  return (
    <section className="ice-cal" aria-label="发布日历">
      <div className="ice-cal__head">
        <Button size="sm" variant="ghost" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} aria-label="上个月">‹</Button>
        <strong>{cursor.getFullYear()} 年 {cursor.getMonth() + 1} 月</strong>
        <Button size="sm" variant="ghost" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} aria-label="下个月">›</Button>
        <Button size="sm" variant="ghost" onClick={() => { const d = new Date(); setCursor(new Date(d.getFullYear(), d.getMonth(), 1)); }}>本月</Button>
        <span style={{ flex: 1 }} />
        <span className="ice-cal__legend"><i className="is-planned" />计划发布 <i className="is-published" />已登记发布</span>
      </div>
      {data.isLoading && <SkeletonRows rows={5} height={40} />}
      {data.error && <ErrorNote error={data.error} onRetry={() => data.refetch()} retryLabel="重新读取日历" />}
      {data.data && <div className="ice-cal__grid" role="grid" aria-label={`${month} 日历`}>
        {WEEK.map(day => <div key={day} className="ice-cal__week" role="columnheader">周{day}</div>)}
        {cells.map((day, index) => <div key={day ?? "x" + index} role="gridcell"
          className={"ice-cal__day" + (day ? "" : " is-empty") + (day === today ? " is-today" : "") + (pick && day ? " is-target" : "")}
          onClick={() => { if (pick && day) { void schedule(pick, day); setPick(null); } }}>
          {day && <span className="ice-cal__num">{Number(day.slice(8))}</span>}
          {day && (byDay.get(day) ?? []).map(item => <button key={item.kind + item.document_id + (item.url ?? "")} type="button"
            className={"ice-cal__item is-" + item.kind} title={item.kind === "published" ? `已登记发布：${item.title}` : `计划：${item.title}`}
            onClick={event => { event.stopPropagation(); void openDocument(item.document_id); }}>{item.title || "未命名文章"}</button>)}
        </div>)}
      </div>}
      <div className="ice-cal__unplanned">
        <div className="ice-doc-row"><strong>未排期</strong><span className="ice-doc-muted">{unplanned.length} 篇 · 点“排期”后再点日历上的某一天</span></div>
        {pick && <div className="ice-doc-row ice-cal__picking">正在为「{documents.find(d => d.document_id === pick)?.title}」选日期
          <button type="button" className="ice-link-btn" onClick={() => setPick(null)}>取消</button></div>}
        <ul>
          {unplanned.slice(0, 12).map(item => <li key={item.document_id} className="ice-doc-row">
            <span className="ice-cal__utitle">{item.title || "未命名文章"}</span>
            <span style={{ flex: 1 }} />
            <input type="date" aria-label={`为「${item.title}」设计划日期`} onChange={event => { if (event.target.value) void schedule(item.document_id, event.target.value); }} />
            <button type="button" className="ice-link-btn" aria-pressed={pick === item.document_id} onClick={() => setPick(pick === item.document_id ? null : item.document_id)}>排期</button>
          </li>)}
        </ul>
        {(data.data?.planned ?? []).length > 0 && <details>
          <summary>本月计划（{data.data!.planned.length}）</summary>
          <ul>{data.data!.planned.map(item => <li key={item.document_id} className="ice-doc-row">
            <span>{item.date.slice(5)} · {item.title}</span><span style={{ flex: 1 }} />
            {item.published && <span className="ice-doc-chip is-ok">已发布</span>}
            <button type="button" className="ice-link-btn" onClick={() => void schedule(item.document_id, null)}>取消排期</button>
          </li>)}</ul>
        </details>}
      </div>
    </section>
  );
}
