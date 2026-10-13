"""Reuse the reviewed CDP harness with fresh G-only synthetic fixtures."""
from pathlib import Path

out = Path(__file__).resolve().parent
old = out.parent / '验收-2026-10-08'
seed = (old/'seed_native.py').read_text(encoding='utf-8')
seed = seed.replace("repo / '.test-tmp' / 'review-20261008' / 'native'", "repo / '.test-tmp' / 'reaccept-beta1-20261008' / ('native-package' if '--packaged' in sys.argv else 'native-source-final')")
seed = seed.replace("    result = {'runtime':", """
    archived = service.call('chat.create', {'title': '归档验收会话'})
    service.call('chat.update', {'conversation_id': archived['conversation']['id'], 'archived': True})
    candidate_id = new_id('candidate')
    store.conn.execute('INSERT INTO creative_candidates (id,conversation_id,account_id,title,body,base_json,prompts_json,status,parent_id,review_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        (candidate_id,cid,'ice-loop','候选保存验收','# 候选保存验收\\n\\nDRAFT_NATIVE_MARKER',json.dumps(conv['current']), '[]','draft',None,'{}',now_iso()))
    store.conn.commit()
    result = {'runtime':""")
(out/'seed_native.py').write_text(seed, encoding='utf-8')
native = (old/'native-review.cjs').read_text(encoding='utf-8')
native = native.replace("const packaged=process.argv.includes('--packaged');\n", '')
native = native.replace('const fixture=', "const packaged=process.argv.includes('--packaged');\nconst fixture=")
native = native.replace("'.test-tmp/review-20261008/native/review-fixture.json'", "'.test-tmp/reaccept-beta1-20261008/'+(packaged?'native-package':'native-source-final')+'/review-fixture.json'")
start = native.index('const runtime=')
end = native.index('const resultFile=', start)
native = native[:start] + 'const runtime=fixture.runtime;\n' + native[end:]
native = native.replace('docs/验收-2026-10-08', 'docs/复验-beta1-2026-10-08')
native = native.replace("packaged?'native-packaged-result.json':'native-source-result.json'", "(process.argv.includes('--final')?'final-':'baseline-')+(packaged?'native-packaged-result.json':'native-source-result.json')")
native = native.replace('SOURCE_UNSAVED_MARKER\\n\\nSource mode edited.', 'SOURCE_UNSAVED_MARKER\\\\n\\\\nSource mode edited.')
native = native.replace("},15000);", "},60000);")
native = native.replace("  await cdp('Page.reload');await delay(1800);", """
  results.observations.engine_version=await evaluate("window.ice.request('bootstrap',{}).then(r=>r.version)");
  const draftBefore=await evaluate("window.ice.request('chat.drafts',{}).then(r=>r.length)");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.innerText==='保存为草稿').click()");
  await delay(2100);
  const draftAfter=await evaluate("window.ice.request('chat.drafts',{}).then(r=>r.length)");
  results.observations.candidate_saves_actual_draft=draftAfter===draftBefore+1;
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.innerText==='查看归档').click()");
  await delay(1000);
  results.observations.archived_conversation_visible=await evaluate("Boolean(document.querySelector('button[title=\\\"归档验收会话\\\"]'))");
  await cdp('Page.reload');await delay(1800);
""")
native = native.replace("  results.observations.status='completed';", """
  const o=results.observations;
  results.scoped_ui_pass=!o.conversation_crashes && o.editor_open && !o.rich_edit_missing_from_source
    && !o.source_edit_missing_from_rich && o.candidate_saves_actual_draft && o.archived_conversation_visible;
  results.observations.status='completed';
""")
native = native.replace("  results.observations.candidate_saves_actual_draft=draftAfter===draftBefore+1;", """
  results.observations.candidate_saves_actual_draft=draftAfter===draftBefore+1;
  await evaluate("document.querySelector('button[title=\\\"候选保存验收\\\"]')?.click()");
  for(let n=0;n<40;n++){
    if(await evaluate("document.querySelector('[role=dialog]')?.innerText.includes('DRAFT_NATIVE_MARKER')"))break;
    await delay(250);
  }
  results.observations.sidebar_draft_body_visible=await evaluate("Boolean(document.querySelector('[role=dialog]')?.innerText.includes('DRAFT_NATIVE_MARKER'))");
  await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.innerText==='关闭')?.click()");
""")
native = native.replace("&& o.candidate_saves_actual_draft && o.archived_conversation_visible;", "&& o.candidate_saves_actual_draft && o.archived_conversation_visible && o.sidebar_draft_body_visible;")
native = native.replace("  const draftBefore=", "  results.observations.step='query_drafts_before';\n  const draftBefore=")
native = native.replace("  await evaluate(\"[...document.querySelectorAll('button')].find(b=>b.innerText==='保存为草稿').click()\");", "  results.observations.step='save_candidate';\n  await evaluate(\"[...document.querySelectorAll('button')].find(b=>b.innerText==='保存为草稿').click()\");")
native = native.replace("  console.log(JSON.stringify(results,null,2));", "  console.log(JSON.stringify(results,null,2));\n  if(process.argv.includes('--final') && !results.scoped_ui_pass) process.exitCode=1;")
(out/'native-reaccept.cjs').write_text(native, encoding='utf-8')
print('Native source/packaged fixture scripts prepared')
