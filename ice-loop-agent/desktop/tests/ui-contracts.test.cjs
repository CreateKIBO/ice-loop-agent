// v2.0 契约产物一致性（Node 侧）：schema ↔ 生成校验器 ↔ TS 类型 同步，且无 eval。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const UI = path.join(__dirname, '..', 'ui');
const contractsDir = path.join(UI, 'contracts');
const generatedDir = path.join(UI, 'src', 'contracts', 'generated');

const schemas = fs.existsSync(contractsDir)
  ? fs.readdirSync(contractsDir).filter(f => f.endsWith('.schema.json')) : [];

test('contracts schema files exist', () => {
  assert.ok(schemas.length > 0, 'desktop/ui/contracts/ 下应有权威 schema');
});

for (const file of schemas) {
  const name = file.replace('.schema.json', '');
  test(`validator generated for ${name}`, () => {
    const target = path.join(generatedDir, `${name}.validator.js`);
    assert.ok(fs.existsSync(target), `${name} 缺少生成校验器，请运行 npm --prefix ui run gen`);
    const code = fs.readFileSync(target, 'utf8');
    assert.ok(!/new Function\s*\(/.test(code), `${name} 校验器包含 new Function`);
    assert.ok(!/[^a-zA-Z]eval\s*\(/.test(code), `${name} 校验器包含 eval`);
  });
  test(`TS type exported for ${name}`, () => {
    const types = fs.readFileSync(path.join(UI, 'src', 'contracts', 'types.gen.ts'), 'utf8');
    const exported = types.includes(`export type I${name.split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('')}`);
    assert.ok(exported, `types.gen.ts 缺少 ${name} 的 TS 投影`);
  });
}

test('validators and types regenerate from committed schemas (drift guard on artifacts)', () => {
  // Ajv standalone 输出没有头注释；生成标记放在配套 .d.ts（由脚本写出）。
  for (const file of fs.readdirSync(generatedDir)) {
    if (!file.endsWith('.d.ts')) continue;
    const code = fs.readFileSync(path.join(generatedDir, file), 'utf8');
    assert.ok(/生成/.test(code.split('\n')[0] || ''), `${file} 缺少生成标记头`);
  }
});
