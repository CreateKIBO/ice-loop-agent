"""Create new isolated native-test scripts without overwriting review evidence."""
from pathlib import Path

out = Path(__file__).resolve().parent
old = out.parent / "验收-2026-10-08"
seed = (old / "seed_native.py").read_text(encoding="utf-8")
seed = seed.replace("'review-20261008'", "'small-fixes-20261008'")
seed = seed.replace("/ 'native'", "/ 'native-retry'")
(out / "seed_native.py").write_text(seed, encoding="utf-8")
native = (old / "native-review.cjs").read_text(encoding="utf-8")
native = native.replace("review-20261008", "small-fixes-20261008")
native = native.replace("small-fixes-20261008/native/review-fixture.json", "small-fixes-20261008/native-retry/review-fixture.json")
native = native.replace("docs/验收-2026-10-08", "docs/修复-2026-10-08")
native = native.replace("const packaged=process.argv.includes('--packaged');", "const packaged=false;")
native = native.replace("SOURCE_UNSAVED_MARKER\\n\\nSource mode edited.", "SOURCE_UNSAVED_MARKER\\\\n\\\\nSource mode edited.")
native = native.replace("  // 不保存fixture变化，仅退出专属测试实例。", """
  await delay(1000);
  results.observations.recovery_draft=await evaluate("window.ice.request('articles.editor_draft_get',{job_id:"+JSON.stringify(fixture.job_id)+"}).then(r=>r.draft?.content||'')");
  results.observations.source_draft_persisted=results.observations.recovery_draft.includes('SOURCE_UNSAVED_MARKER');
  const before=await evaluate("window.ice.request('chat.list',{}).then(r=>r.length)");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.innerText==='新建会话').click()");
  await delay(1600);
  const after=await evaluate("window.ice.request('chat.list',{}).then(r=>r.length)");
  results.observations.create_conversation_works=after===before+1;
  results.observations.new_conversation_composer=await evaluate("Boolean(document.querySelector('textarea'))");
  // Only this test runtime is mutated; the real application is untouched.
""")
native = native.replace("  results.observations.status='completed';", """
  const o=results.observations;
  results.accepted=o.has_new_conversation_button && !o.conversation_crashes && o.editor_open
    && !o.rich_edit_missing_from_source && !o.source_edit_missing_from_rich
    && o.source_draft_persisted && o.create_conversation_works && o.new_conversation_composer;
  if(!results.accepted) throw Error('Native scoped regression did not meet all checks');
  results.observations.status='completed';
""")
native = native.replace("  console.log(JSON.stringify(results,null,2));", "  console.log(JSON.stringify(results,null,2));\n  if(!results.accepted)process.exitCode=1;")
(out / "native-fixes.cjs").write_text(native, encoding="utf-8")
print("Prepared isolated source Electron regression scripts")
