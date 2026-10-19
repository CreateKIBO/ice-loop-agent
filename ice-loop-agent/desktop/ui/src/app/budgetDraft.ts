export type DefaultLimits={max_model_calls:number;max_image_model_calls:number;max_chat_calls:number;defaults_hash:string};
export type BudgetDraft={max_model_calls:string;max_image_model_calls:string;max_chat_calls:string};
export const budgetDraft=(data:DefaultLimits):BudgetDraft=>({max_model_calls:String(data.max_model_calls),max_image_model_calls:String(data.max_image_model_calls),max_chat_calls:String(data.max_chat_calls)});
export function budgetValues(draft:BudgetDraft) {
  const values={max_model_calls:0,max_image_model_calls:0,max_chat_calls:0};
  for(const key of Object.keys(values) as Array<keyof BudgetDraft>) {
    const value=draft[key].trim(),minimum=key==='max_chat_calls'?0:1,maximum=key==='max_chat_calls'?1000:100;
    if(!/^\d+$/.test(value)||!Number.isInteger(Number(value))||Number(value)<minimum||Number(value)>maximum)
      throw Error(key==='max_chat_calls'?'会话上限需为0–1000的整数，只有会话的0表示不限制':'普通文章与补图上限需为1–100的整数，0不能用来解除限制');
    values[key]=Number(value);
  }
  return values;
}
