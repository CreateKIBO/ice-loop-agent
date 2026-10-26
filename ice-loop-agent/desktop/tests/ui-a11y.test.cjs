'use strict';
// 批次C-11/C-14（2026-10-20 后续任务）源码级可访问性守护：
// 1) 表单控件（input/select/textarea/Input/TextArea JSX 用法）必须有可访问名称：
//    aria-label / aria-labelledby / 关联 id / 被未闭合 <label> 包裹；
// 2) 键盘处理器在 IME 组词（isComposing）期间不得触发发送/命令类键；
// 3) ShortcutHelp 的键位表与源码中真实注册的处理器一一对齐（防止文案先行、实现缺位）。
// 范围说明：这是源码结构检查，不替代原生 Electron 键盘旅程（见原生专项）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

const UI = path.resolve(__dirname, '..', 'ui');
const SRC = path.join(UI, 'src');

function listSources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSources(full));
    else if (/\.(tsx|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const sources = listSources(SRC).map(file => ({
  file, rel: path.relative(SRC, file).replace(/\\/g, '/'), text: fs.readFileSync(file, 'utf8'),
}));

test('every form control has an accessible name (aria-label, labelledby, id, or label wrap)', () => {
  const gaps = [];
  for (const source of sources) {
    const pattern = /<(input|select|textarea|Input|TextArea)\b/g;
    let match;
    while ((match = pattern.exec(source.text))) {
      // 开标签属性区启发式窗口：控件属性在源码中连续书写；自闭合与带子元素两种写法都覆盖。
      const window = source.text.slice(match.index, match.index + 600);
      // ui.tsx 的 Input/包装组件通过 {...rest} 透传调用方属性，由调用方负责命名。
      if (window.includes('{...rest}')) continue;
      const hasName = /aria-label\s*=|aria-labelledby\s*=/.test(window)
        || /(^|\s)id\s*=/.test(window) || /aria-hidden/.test(window);
      if (hasName) continue;
      // 未命名时检查是否被未闭合的 <label> 包裹（隐式关联）。
      const before = source.text.slice(Math.max(0, match.index - 600), match.index);
      const labelOpens = (before.match(/<label\b/g) ?? []).length;
      const labelCloses = (before.match(/<\/label>/g) ?? []).length;
      if (labelOpens > labelCloses) continue;
      gaps.push(`${source.rel}:${source.text.slice(0, match.index).split('\n').length} <${match[1]}>`);
    }
  }
  assert.deepEqual(gaps, [], `缺少可访问名称的表单控件：\n${gaps.join('\n')}`);
});

test('decorative status dots and icons are hidden from assistive tech', () => {
  for (const source of sources) {
    const dots = source.text.match(/className=\{?"[^"]*ice-dot[^"]*"/g) ?? [];
    for (const dot of dots) {
      const at = source.text.indexOf(dot);
      assert.ok(/aria-hidden/.test(source.text.slice(at - 60, at + dot.length + 90)),
        `${source.rel}: ice-dot 状态点必须带 aria-hidden（颜色不能是唯一信息通道）`);
    }
  }
});

test('send/command key handlers guard IME composition (isComposing)', () => {
  // 会触发业务动作的按键处理器文件必须感知 isComposing。
  const handlers = [
    { file: 'features/chat/Composer.tsx', expect: 'isComposing' },
    { file: 'features/chat/WindowFindBar.tsx', expect: 'isComposing' },
    { file: 'app/CommandPalette.tsx', expect: 'isComposing' },
    { file: 'app/CommandPalette.tsx', expect: 'event.isComposing' }, // useGlobalShortcuts
    { file: 'features/editor/ArticleEditor.tsx', expect: 'isComposing' }, // Ctrl+S
    { file: 'data/composerDraft.ts', expect: 'isComposing' }, // shouldSendKey 纯逻辑
  ];
  for (const item of handlers) {
    const source = sources.find(entry => entry.rel === item.file);
    assert.ok(source, `${item.file} 应存在`);
    assert.ok(source.text.includes(item.expect),
      `${item.file} 缺少 ${item.expect}（IME 组词期间不能触发命令）`);
  }
});

test('ShortcutHelp entries correspond to real key registrations in source', () => {
  const uiRequire = Module.createRequire(path.join(UI, 'package.json'));
  const result = esbuild.buildSync({
    stdin: {
      contents: "import { SHORTCUTS } from './components/ShortcutHelp'; export { SHORTCUTS };",
      resolveDir: SRC, loader: 'ts',
    },
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    loader: { '.css': 'empty' }, external: ['react', 'react/*'], logLevel: 'silent',
  });
  const target = path.join(UI, '.shortcut-help-under-test.cjs');
  const module = new Module(target);
  module.filename = target;
  module.paths = Module._nodeModulePaths(UI);
  module._compile(result.outputFiles[0].text, target);
  const { SHORTCUTS } = module.exports;

  // 键位 → 实现所在文件必须包含的注册片段（与真实代码一一对应）。
  const registrations = {
    'Ctrl + K': { file: 'app/CommandPalette.tsx', needle: 'key === "k"' },
    'Ctrl + N': { file: 'app/CommandPalette.tsx', needle: 'key === "n"' },
    'Ctrl + ,': { file: 'app/CommandPalette.tsx', needle: 'key === ","' },
    'Ctrl + S': { file: 'features/editor/ArticleEditor.tsx', needle: '"s"' },
    'Enter': { file: 'data/composerDraft.ts', needle: 'key' },
    'Shift + Enter': { file: 'data/composerDraft.ts', needle: 'shiftKey' },
    'Esc': { file: 'app/WorkbenchShell.tsx', needle: '"Escape"' },
    '← / →': { file: 'app/WorkbenchShell.tsx', needle: '"ArrowLeft"' },
    'Home 或 Enter': { file: 'app/WorkbenchShell.tsx', needle: '"Home"' },
    '↑ ↓ PgUp PgDn Home End 空格': { file: 'features/chat/ChatPane.tsx', needle: "'PageUp'" },
    '↑ / ↓': { file: 'app/CommandPalette.tsx', needle: '"ArrowDown"' },
  };
  const missing = [];
  for (const entry of SHORTCUTS) {
    const registration = registrations[entry.keys];
    if (!registration) { missing.push(`帮助中的键位未登记验收映射：${entry.keys}`); continue; }
    const source = sources.find(item => item.rel === registration.file);
    if (!source?.text.includes(registration.needle)) {
      missing.push(`${entry.keys} 声称存在于 ${registration.file}，实际找不到 ${registration.needle}`);
    }
  }
  // 反向：注册表里的每个键位都必须出现在帮助里，防止"实现了但帮助没写"。
  for (const keys of Object.keys(registrations)) {
    if (!SHORTCUTS.some(entry => entry.keys === keys)) {
      missing.push(`真实注册的键位未写入帮助：${keys}`);
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});
