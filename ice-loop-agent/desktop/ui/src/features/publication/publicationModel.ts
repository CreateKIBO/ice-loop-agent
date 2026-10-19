export type PublicationAccount={id?:string;preset:string;name:string;positioning:string;audience:string;persona:string;slogan:string;
  colors:string;image_style:string;visual_brief:string;brand_document:string;ending_heading:string;closing_sentence:string;
  words_range:[number,number];columns:Array<{code:string;name:string}>;banned_words:string[];article_root:string;library_root:string};
export type PublicationDraft=Omit<PublicationAccount,'words_range'|'banned_words'>&{words_range:[string,string];banned_text:string};
export const emptyPublication=():PublicationAccount=>({preset:'general',name:'',positioning:'',audience:'',persona:'自然、准确、清晰',
  slogan:'',colors:'#2448DB, #15191F, #F3F2ED',image_style:'flat editorial',visual_brief:'',brand_document:'',ending_heading:'写在最后',
  closing_sentence:'',words_range:[1200,2400],columns:[{code:'ART',name:'日常文章'}],banned_words:[],article_root:'',library_root:''});
export function publicationDraft(account:PublicationAccount=emptyPublication()):PublicationDraft {
  const {banned_words,words_range,...rest}=account;
  return {...rest,columns:account.columns.map(row=>({...row})),words_range:[String(words_range[0]),String(words_range[1])],banned_text:banned_words.join('\n')};
}
export function publicationPayload(draft:PublicationDraft):PublicationAccount {
  const {banned_text,words_range,...rest}=draft;
  return {...rest,words_range:[Number(words_range[0]),Number(words_range[1])],banned_words:banned_text.split(/\r?\n/).map(word=>word.trim()).filter(Boolean)};
}
export function publicationError(draft:PublicationDraft):string|null {
  if(!draft.name.trim())return '请填写公众号名称';
  if(!draft.audience.trim()||draft.audience.trim()==='请设置你的目标读者')return '请确认这份资料面向的目标读者';
  const limits:Record<string,number>={name:500,positioning:2000,audience:500,persona:500,slogan:500,image_style:500,visual_brief:6000,brand_document:20000,ending_heading:50,closing_sentence:500,article_root:1000,library_root:1000};
  for(const [key,limit] of Object.entries(limits))if(String(draft[key as keyof PublicationDraft]??'').length>limit)return `资料字段超过长度限制（最多${limit}字）`;
  if(!draft.ending_heading.trim())return '请填写文章结尾标题';
  if(!/^#[0-9a-fA-F]{6}(?:\s*,\s*#[0-9a-fA-F]{6}){0,5}$/.test(draft.colors.trim()))return '品牌色需为1–6个HEX色值，以英文逗号分隔';
  const [min,max]=publicationPayload(draft).words_range;
  if(!draft.words_range.every(value=>value.trim())||!Number.isInteger(min)||!Number.isInteger(max)||min<300||max>10000||min>max)return '文章字数需在300–10000之间，最小值不大于最大值';
  if(draft.columns.length<1||draft.columns.length>12)return '请保留1–12个栏目';
  if(draft.columns.some(row=>!/^[A-Z][A-Z0-9_]{0,11}$/.test(row.code)||!row.name.trim()||row.name.trim().length>60))return '栏目需填写名称；代码为1–12位大写字母、数字或下划线，以字母开头';
  if(new Set(draft.columns.map(row=>row.code)).size!==draft.columns.length)return '栏目代码不能重复';
  const banned=publicationPayload(draft).banned_words;
  if(banned.length>100||banned.some(word=>word.length>60))return '禁用词最多100项，每项不超过60字';
  return null;
}
export function brandColors(value:string) {return value.split(',').map(color=>color.trim()).filter(color=>/^#[0-9a-fA-F]{6}$/.test(color)).slice(0,6);}
export async function publicationFile(file:File) {
  const format=file.name.split('.').pop()?.toLowerCase();
  if(!format||!['json','md','txt'].includes(format))throw Error('请选择JSON配置、Markdown或文本品牌说明');
  if(file.size>128000)throw Error('文件超过128KB，请使用精简的品牌资料');
  let text:string;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer()).replace(/^\uFEFF/,'');}
  catch{throw Error('文件编码无法读取，请另存为UTF-8后重试');}
  if(!text.trim()||text.length>60000)throw Error('资料不能为空，且最多60000字');
  return {text,format,name:file.name.replace(/\.[^.]+$/,'').slice(0,100)};
}
