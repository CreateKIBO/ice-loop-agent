'use strict';
// Present the actual editorial state without advancing it or altering hashes.
function studioWritingStage(candidate, current, busy) {
  if (busy) return { index: 0, label: '正在创作', note: '生成完成后，先预览再做决定。' };
  if (candidate?.status === 'accepted') return { index: 3, label: '文章已采用', note: '继续完善配图，在制作任务中检查并导出。' };
  if (candidate?.status === 'pending') return { index: 2, label: '等待审批', note: '到文章审批中比较修改，由你决定采用。' };
  if (candidate?.saved_draft || current?.body && !candidate) return { index: 1, label: '已有保存稿', note: '可以继续改稿，也可以同步文章审批。' };
  if (candidate) return { index: 1, label: '初稿待确认', note: '预览或手动修改，满意后保存到草稿箱。' };
  return { index: 0, label: '从想法开始', note: '先讨论内容，或直接生成一份初稿。' };
}
window.iceStudioState = { writingStage: studioWritingStage };

function paintStudioJourney() {
  if(!creativeMountMatches())return;
  const shell = document.querySelector('.creative-shell'); if (!shell) return;
  let host = shell.querySelector('#studio-journey');
  if (!host) {
    host = document.createElement('div'); host.id = 'studio-journey'; host.className = 'studio-journey';
    shell.querySelector('.creative-toolbar').after(host);
  }
  const candidate = chatCandidate(), current = creative.data?.current;
  const busy = creative.sending || creative.data?.messages.some(m => m.status === 'streaming');
  const stage = studioWritingStage(candidate, current, busy);
  const signature = `${stage.index}:${stage.label}`;
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
  host.innerHTML = `<div class="journey-status"><span class="journey-marker ${busy ? 'working' : ''}"></span><strong>${esc(stage.label)}</strong><span>${esc(stage.note)}</span></div><ol aria-label="文章创作流程">${['创作对话','保存初稿','文章审批','配图与导出'].map((label, i) => `<li class="${i === stage.index ? 'current' : i < stage.index ? 'done' : ''}"><span>${i + 1}</span>${label}</li>`).join('')}</ol>`;
  window.iceMotion?.enter(host);
}
const studioPaintPreview = paintCreativePreview;
paintCreativePreview = function () { studioPaintPreview(); paintStudioJourney(); };
const studioPaintProgress = paintCreativeProgress;
paintCreativeProgress = function () { studioPaintProgress(); paintStudioJourney(); };

function openStudioPreferences() {
  let dialog = document.querySelector('#studio-preferences');
  if (!dialog) {
    dialog = document.createElement('dialog'); dialog.id = 'studio-preferences'; dialog.className = 'modal studio-preferences';
    dialog.innerHTML = `<form method="dialog"><div class="modal-head"><div><span class="eyebrow">MAKE ROOM TO WRITE</span><h2>工作台显示偏好</h2></div><button class="icon-button" aria-label="关闭">×</button></div><label>界面动效<select id="studio-motion"><option value="system">跟随系统</option><option value="on">开启适度动效</option><option value="off">减少动效</option></select></label><p class="muted">适度动效用于说明页面切换与运行状态。减少动效后仍会显示实际阶段和用时。</p><label>界面密度<select id="studio-density"><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label><p class="muted">适用于导航和工作台列表；文章字号保持适合阅读的大小。</p><div class="preference-shortcuts"><span>快捷搜索 <kbd>Ctrl K</kbd></span><span>发送 <kbd>Enter</kbd></span><span>换行 <kbd>Shift Enter</kbd></span></div><div class="modal-actions"><button class="button primary">完成</button></div></form>`;
    document.body.append(dialog);
    dialog.querySelector('#studio-motion').addEventListener('change', e => window.iceMotion?.setPreference(e.target.value));
    dialog.querySelector('#studio-density').addEventListener('change', e => {
      document.documentElement.dataset.density = e.target.value;
      try { localStorage.setItem('ice-density', e.target.value); } catch {}
    });
  }
  dialog.querySelector('#studio-motion').value = window.iceMotion?.preference || 'system';
  dialog.querySelector('#studio-density').value = document.documentElement.dataset.density || 'comfortable';
  dialog.showModal();
}
try { document.documentElement.dataset.density = localStorage.getItem('ice-density') === 'compact' ? 'compact' : 'comfortable'; } catch {}
document.addEventListener('click', event => { if (event.target.closest('[data-studio-preferences]')) openStudioPreferences(); });
