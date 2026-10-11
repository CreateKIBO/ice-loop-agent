'use strict';
const fs = require('fs');

const UI_PAGES = Object.freeze({ new: 'ice://app/ui/index.html', classic: 'ice://app/index.html' });
// 这些冒烟依赖经典页面上的 window.__ICE_*__ 钩子，必须进经典界面。
const CLASSIC_SMOKE_FLAGS = Object.freeze(['--smoke', '--review-smoke', '--browser-smoke', '--chat-smoke', '--prompt-smoke', '--provider-smoke']);
const NEW_SMOKE_FLAGS = Object.freeze(['--ui-smoke', '--dpi-smoke']);

function readUiMode(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).mode === 'classic' ? 'classic' : 'new'; }
  catch { return 'new'; }
}

function writeUiMode(file, mode) {
  if (mode !== 'new' && mode !== 'classic') throw new Error('未知界面');
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ mode }));
  fs.renameSync(temporary, file);
}

/** 启动页：命令行参数优先，其次是用户上次的选择；新界面产物缺失时回落经典界面。 */
function chooseStartPage({ argv, newUiBuilt, savedMode }) {
  if (NEW_SMOKE_FLAGS.some(flag => argv.includes(flag))) return UI_PAGES.new;
  if (argv.includes('--classic-ui') || CLASSIC_SMOKE_FLAGS.some(flag => argv.includes(flag))) return UI_PAGES.classic;
  if (!newUiBuilt) return UI_PAGES.classic;
  return argv.includes('--new-ui') || savedMode !== 'classic' ? UI_PAGES.new : UI_PAGES.classic;
}

module.exports = { UI_PAGES, CLASSIC_SMOKE_FLAGS, readUiMode, writeUiMode, chooseStartPage };
