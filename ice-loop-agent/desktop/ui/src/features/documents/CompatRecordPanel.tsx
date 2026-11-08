// v3.12 微信兼容记录：测试稿专用侧栏。每项分“粘贴后 / 后台保存后 / 手机预览”三格记录，未执行保持“未验”。
import * as React from "react";

import { Button, Input, SkeletonRows } from "../../components/ui";
import { ErrorNote } from "../../components/ErrorNote";
import { toast } from "../../components/toast";
import { queryClient, useAccountQuery, useCurrentAccount } from "../../data/client";
import { docRpc } from "./documentsApi";

type Stage = "paste" | "saved" | "phone";
type Result = "untested" | "pass" | "partial" | "fail";
type Item = { code: string; label: string; note: string } & Record<Stage, Result>;
type Compat = { document_id: string; theme: string; items: Item[]; stages: Array<{ key: Stage; label: string }>;
  results: Record<Result, string>; environment: Record<string, string>; updated_at: string | null };
const ENV: Array<{ key: string; label: string; placeholder: string }> = [
  { key: "os", label: "系统", placeholder: "Windows 11 / macOS 15" }, { key: "scale", label: "缩放", placeholder: "100% / 125% / 150%" },
  { key: "wechat", label: "公众号后台", placeholder: "浏览器与版本" }, { key: "phone", label: "手机", placeholder: "机型与微信版本" },
  { key: "head", label: "源码 HEAD", placeholder: "git 提交号" },
];

export function CompatRecordPanel({ documentId }: { documentId: string }) {
  const account = useCurrentAccount();
  const data = useAccountQuery<Compat>("documents.compat_get", { document_id: documentId }, { staleTime: 0 });
  const [saving, setSaving] = React.useState(false);
  const save = async (params: Record<string, unknown>) => {
    setSaving(true);
    try {
      const next = await docRpc<Compat>("documents.compat_record", { document_id: documentId, ...params });
      queryClient.setQueryData(["ice", account, "documents.compat_get", { document_id: documentId }], next);
    } catch (error) { toast.error({ title: "记录没有保存", detail: (error as Error).message }); }
    finally { setSaving(false); }
  };
  const copy = async () => {
    try {
      const report = await docRpc<{ markdown: string }>("documents.compat_report", { document_id: documentId });
      const bridge = window.ice?.copyText as undefined | ((text: string) => Promise<unknown>);
      if (typeof bridge === "function") await bridge(report.markdown); else await navigator.clipboard.writeText(report.markdown);
      toast.success({ title: "已复制 Markdown 记录", detail: "可直接粘进验收记录；“未验”不计为兼容。" });
    } catch (error) { toast.error({ title: "没有复制", detail: (error as Error).message }); }
  };
  if (data.isLoading) return <SkeletonRows rows={6} height={20} />;
  if (data.error || !data.data) return <ErrorNote error={data.error} onRetry={() => data.refetch()} retryLabel="重新读取记录" />;
  const compat = data.data;
  const done = compat.items.reduce((sum, item) => sum + compat.stages.filter(stage => item[stage.key] !== "untested").length, 0);
  const total = compat.items.length * compat.stages.length;
  return (
    <div className="ice-doc-form ice-compat">
      <p className="ice-doc-muted">按测试稿里的【编号】逐项记录。三个阶段分开填：粘贴到后台编辑器后、点保存后重新打开、用手机预览。没做的保持“未验”。</p>
      <div className="ice-compat__env">
        {ENV.map(field => <label key={field.key} className="ice-doc-field">{field.label}
          <Input defaultValue={compat.environment[field.key] ?? ""} placeholder={field.placeholder} maxLength={120} aria-label={field.label}
                 onBlur={event => { if (event.target.value !== (compat.environment[field.key] ?? "")) void save({ environment: { [field.key]: event.target.value } }); }} /></label>)}
      </div>
      <div className="ice-doc-row">
        <span className="ice-doc-muted">已记录 {done}/{total} 格{saving ? " · 保存中…" : compat.updated_at ? " · 已保存" : ""}</span>
        <span style={{ flex: 1 }} />
        <Button size="sm" onClick={() => void copy()}>复制 Markdown 记录</Button>
      </div>
      <table className="ice-compat__table">
        <thead><tr><th>编号</th>{compat.stages.map(stage => <th key={stage.key}>{stage.label}</th>)}</tr></thead>
        <tbody>
          {compat.items.map(item => <React.Fragment key={item.code}>
            <tr>
              <th scope="row" title={item.label}>{item.code}<span>{item.label}</span></th>
              {compat.stages.map(stage => <td key={stage.key}>
                <select value={item[stage.key]} className={"is-" + item[stage.key]} aria-label={`${item.code} ${item.label} ${stage.label}`}
                        onChange={event => void save({ items: { [item.code]: { [stage.key]: event.target.value } } })}>
                  {(Object.keys(compat.results) as Result[]).map(key => <option key={key} value={key}>{compat.results[key]}</option>)}
                </select></td>)}
            </tr>
            {(item.note || [item.paste, item.saved, item.phone].some(value => value === "partial" || value === "fail")) && <tr className="ice-compat__note">
              <td colSpan={4}><Input defaultValue={item.note} maxLength={300} placeholder="说明：哪里不对、截图位置" aria-label={`${item.code} 说明`}
                onBlur={event => { if (event.target.value !== item.note) void save({ items: { [item.code]: { note: event.target.value } } }); }} /></td>
            </tr>}
          </React.Fragment>)}
        </tbody>
      </table>
    </div>
  );
}
