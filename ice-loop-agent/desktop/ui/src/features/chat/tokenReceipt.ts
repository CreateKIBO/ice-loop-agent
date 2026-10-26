// Treat persisted metadata as untrusted; never render a claimed pass without its numbers.
export function tokenReceipt(value:unknown):{summary:string;detail:string}|null {
  if(!value||typeof value!=='object')return null;
  const row=value as Record<string,unknown>;
  const number=(v:unknown,min=0):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=2_147_483_647;
  if(row.state==='disabled')return {summary:'Token 预检 · 已关闭',detail:'当前模型未请求供应商计数，字符保护仍生效。'};
  if(row.state==='unsupported')return {summary:'Token 预检 · 尚未接通',detail:'当前端点或模型尚未接通供应商计数，不能据此确认输入加输出符合窗口。'};
  if(!['checked','incomplete','blocked'].includes(String(row.state)))return null;
  if(!number(row.input_tokens))return {summary:'Token 预检 · 记录不完整',detail:'未取得有效的供应商计数，请核对模型设置。'};
  const input=row.input_tokens.toLocaleString(),reserve=number(row.output_reserved,1)?row.output_reserved:null,context=number(row.context_window,1)?row.context_window:null;
  const source=row.window_source==='user'?'手动窗口':row.window_source==='models_endpoint'?'端点报告窗口':'配置窗口';
  const complete=row.state==='checked'&&reserve!==null&&context!==null&&row.input_tokens+reserve<=context;
  if(complete)return {summary:`Token 预检 · 输入 ${input} + 输出预留 ${reserve.toLocaleString()}`,
    detail:`${source} ${context.toLocaleString()} Token，已按供应商计数核验。实际计费与最终窗口校验以供应商为准。`};
  if(row.state==='blocked')return {summary:`Token 预检 · 输入 ${input}，已拦截`,detail:'输入加输出预留超过配置窗口，本次未发送生成请求。请调整范围、输出上限或模型；历史正文和标题未删减。'};
  return {summary:`Token 预检 · 输入 ${input}，未完成窗口核验`,detail:'窗口或明确的输出上限未知，请在模型设置中补齐。供应商计数不是计费承诺。'};
}
