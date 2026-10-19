export const NODE_LABEL: Record<string,string> = {
  ingest:'接收需求',topic:'选题',research:'调研',outline:'大纲',draft:'起草',
  verify_code:'代码验证',integrate_evidence:'整合运行证据',article_review:'文章审阅',
  style_review:'风格审阅',title_workshop:'最终标题',asset_plan:'配图计划',assets:'准备配图',
  final_check:'终检',export:'导出',
};
export const REVIEW_LABEL: Record<string,string> = {
  topic:'确定选题方向',outline:'审阅文章大纲',final_title:'选择最终标题',asset_plan:'确认配图计划',
};
export type Approval = {
  approval_id:string; scope:string; content_hash:string; payload:Record<string,unknown>;
};
export type ExecutionBlock = {
  index:number; filename:string; language:string; source:string; stdin_key:string;
  stdin_text:string; needs_input:boolean; input_calls:number; expected_failure:boolean;
};
export type ExecutionPlan = {
  content_hash:string; blocks:ExecutionBlock[]; approved:boolean; missing_inputs:string[]; mode:string;
};
export type RunEvidence = {
  run_id:string; filename:string; source?:string; stdout:string; stderr:string;
  exit_code:number; verdict:string; duration_ms:number;
};
export type TaskDetail = {
  job:{job_id:string;state:string;current_node:string;lease:string|null;pause_reason:string;stopping?:boolean};
  article:{topic:string;final_title:string|null;series:string;episode:number;spec:{demo?:boolean;account_id:string}};
  pending_approval:Approval|null; execution:ExecutionPlan|null;
  execution_hash:string|null; runs:Record<string,RunEvidence>; body:string;
};
