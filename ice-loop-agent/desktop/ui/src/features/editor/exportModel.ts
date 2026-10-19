export type ExportChecks={blocking?:string[];missing_images?:number[];pending_placeholders?:number;
  run_refs_unresolved?:string[];unmanaged_images?:Array<{caption:string}>};
export type ExportResult={destination:string;mode:'draft'|'ready';images:number;checks:ExportChecks;
  source_body_sha256:string;body_sha256:string;can_open?:boolean};
export function exportProblems(checks:ExportChecks):string[] {
  const blocking=checks.blocking??[];
  const messages=[...blocking,...(checks.missing_images??[]).filter(no=>!blocking.some(message=>new RegExp('^图'+no+'(?![0-9])').test(message))).map(no=>`图${no}尚未完成`),
    ...(checks.run_refs_unresolved??[]).map(()=> '存在未解析的运行输出'),
    ...(checks.unmanaged_images??[]).map(image=>`图片「${image.caption||'未命名图片'}」尚未归档到本篇配图`)];
  if(checks.pending_placeholders&&!checks.missing_images?.length)messages.push(`还有${checks.pending_placeholders}处待配图`);
  return [...new Set(messages)].slice(0,50);
}
