const {test} = require('node:test');
const assert = require('node:assert/strict');
const {merge} = require('../renderer/brief.js');
const base = {topic:'循环',series:'PY',episode:'5',core_benefit:'',materials_text:''};
test('fill blanks preserves supplied topic and user materials', () => {
  const snapshot = {...base, materials_text:'真实素材'};
  const result = merge(snapshot,snapshot,{topic:'改写主题',core_benefit:'跑通循环',materials_text:'建议素材'});
  assert.equal(result.values.topic,'循环'); assert.equal(result.values.materials_text,'真实素材');
  assert.equal(result.values.core_benefit,'跑通循环');
});
test('replace existing requires explicit choice', () => {
  assert.equal(merge(base,base,{topic:'循环练习'},true).values.topic,'循环练习');
});
test('late response preserves concurrent edits even in replace mode', () => {
  const result = merge(base,{...base,topic:'我修改的主题'},{topic:'AI主题',core_benefit:'AI收益'},true);
  assert.equal(result.values.topic,'我修改的主题'); assert.equal(result.values.core_benefit,'AI收益');
});
test('touched fields are protected even when text was restored', () => {
  assert.equal(merge(base,base,{topic:'AI主题'},true,['topic']).values.topic,'循环');
});
test('changing series or episode discards entire suggestion', () => {
  const result = merge(base,{...base,series:'JV'},{core_benefit:'收益'});
  assert.equal(result.stale,true); assert.deepEqual(result.changed,[]);
});
test('unknown keys and blank suggestions never mutate the form', () => {
  const result = merge(base,base,{core_benefit:' ',series:'JV',episode:7,api_key:'secret'},true);
  assert.deepEqual(result.values,base);
});
