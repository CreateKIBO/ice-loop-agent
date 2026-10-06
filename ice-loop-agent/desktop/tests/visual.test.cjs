const test=require('node:test');
const assert=require('node:assert/strict');
const {promptForSlot,resourceSearchText}=require('../renderer/visual.js');
test('cover uses complete reviewed cover prompt',()=>{
  assert.equal(promptForSlot({cover_prompt:'Use case: cover\nexact text: "ICE Loop"'},{kind:'cover'}),'Use case: cover\nexact text: "ICE Loop"');
});
test('real screenshot has no AI generation prompt',()=>{
  assert.equal(promptForSlot({cover_prompt:'cover'},{kind:'body_real',prompt:'invented terminal'}),'');
});
test('body image retains its own prompt',()=>{
  assert.equal(promptForSlot({cover_prompt:'cover'},{kind:'body_diagram',prompt:'diagram'}),'diagram');
  assert.equal(promptForSlot({cover_prompt:'cover'},{kind:'body_diagram'}),'');
});
test('resource search covers editable labels and analyzed content',()=>{
  const text=resourceSearchText({title:'Cover',description:'Python 循环',tags:['变量'],visual_analysis:{summary:'蓝色',style:'Flat'}});
  for(const query of ['cover','python','变量','蓝色','flat'])assert.ok(text.includes(query));
});
