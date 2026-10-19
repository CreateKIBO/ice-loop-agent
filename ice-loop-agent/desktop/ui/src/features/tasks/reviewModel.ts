import type { Approval, ExecutionBlock } from './taskTypes';

export const asRows = (value:unknown):Record<string,unknown>[] =>
  Array.isArray(value) ? value.filter((row):row is Record<string,unknown> => Boolean(row)&&typeof row==='object'&&!Array.isArray(row)) : [];
export const textValue = (value:unknown) => typeof value==='string' ? value : '';
const LIST_KEYS:Record<string,string>={topic:'directions',outline:'sections',final_title:'candidates',asset_plan:'slots'};
export const reviewListKey = (scope:string) => LIST_KEYS[scope];
export function reviewRows(approval:Approval) { return asRows(approval.payload[reviewListKey(approval.scope) ?? '']); }
export function recommendedChoice(approval:Approval):number {
  const value=approval.payload.recommended;
  return typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<reviewRows(approval).length ? value : 0;
}
export function reviewError(approval:Approval):string|null {
  const key=reviewListKey(approval.scope);
  if (!key) return '当前审批类型无法在此处读取，请保留内容并联系维护者。';
  if (!approval.content_hash || !Array.isArray(approval.payload[key])) return '方案格式不完整，请刷新后重试。';
  const rows=reviewRows(approval);
  if (rows.length!==(approval.payload[key] as unknown[]).length || (key!=='slots'&&!rows.length)) return '方案列表无法完整读取，请刷新后重试。';
  const fields:Record<string,string>={topic:'标题候选',outline:'h2',final_title:'title',asset_plan:'caption'};
  const field=fields[approval.scope];
  if (rows.some(row=>!textValue(row[field!]).trim())) return '请填写每一项的标题或说明。';
  if (['topic','outline'].includes(approval.scope)&&!textValue(approval.payload.working_title).trim()) return '请填写工作标题。';
  return null;
}
export function changeReviewRow(approval:Approval,index:number,field:string,value:string):Approval {
  const key=reviewListKey(approval.scope),rows=reviewRows(approval);
  if (!key||!Number.isInteger(index)||index<0||index>=rows.length) throw Error('候选位置已变化，请刷新后重试。');
  return {...approval,payload:{...approval.payload,[key]:rows.map((row,i)=>i===index?{...row,[field]:value}:row)}};
}
export function decisionParams(jobId:string,approval:Approval,choice:number,decision:'approve'|'reject',note:string) {
  const error=reviewError(approval);
  if (decision==='approve'&&error) throw Error(error);
  const selectable=approval.scope==='topic'||approval.scope==='final_title';
  if (decision==='approve'&&selectable&&(!Number.isInteger(choice)||choice<0||choice>=reviewRows(approval).length)) throw Error('请选择当前方案中的候选。');
  return {job_id:jobId,approval_id:approval.approval_id,content_hash:approval.content_hash,
    decision,note,choice:decision==='approve'&&selectable?choice:null};
}
export function executionInputs(blocks:ExecutionBlock[]) {
  return Object.fromEntries(blocks.map(block=>[block.stdin_key,block.stdin_text??'']));
}
export function executionExpectations(blocks:ExecutionBlock[]) {
  return Object.fromEntries(blocks.map(block=>[String(block.index),Boolean(block.expected_failure)]));
}
export function missingInputNames(blocks:ExecutionBlock[],inputs:Record<string,string>) {
  return blocks.filter(block=>block.input_calls>0&&!(inputs[block.stdin_key]?.length)).map(block=>block.stdin_key);
}
