const test=require('node:test'),assert=require('node:assert/strict');
const {siteFor,allowedURL,partition,bounds}=require('../browser.cjs');
test('embedded sites are fixed HTTPS entry points',()=>{
  assert.equal(siteFor('tapnow').url,'https://app.tapnow.media/home');
  assert.equal(siteFor('wechat').url,'https://mp.weixin.qq.com/');
  assert.throws(()=>siteFor('__proto__'));assert.throws(()=>siteFor('unknown'));
});
test('remote navigation cannot load local files or privileged app pages',()=>{
  for(const url of ['file:///G:/data/key.json','ice://app/index.html','javascript:alert(1)','http://app.tapnow.media','https://user:secret@mp.weixin.qq.com','https://localhost/','data:text/html,hi'])assert.equal(allowedURL(url),false,url);
  assert.equal(allowedURL('https://open.weixin.qq.com/connect/qrconnect'),true);
  assert.equal(allowedURL('about:blank'),false);assert.equal(allowedURL('about:blank',true),true);
});
test('site and publication cookies use distinct durable partitions',()=>{
  assert.equal(partition('账号A','tapnow'),partition('账号A','tapnow'));
  assert.notEqual(partition('账号A','tapnow'),partition('账号B','tapnow'));
  assert.notEqual(partition('账号A','tapnow'),partition('账号A','wechat'));
  assert.ok(partition('账号A','tapnow').startsWith('persist:'));
});
test('native view remains inside content area and below application controls',()=>{
  const r=bounds({x:0,y:0,width:5000,height:5000},[1040,720]);
  assert.equal(r.x,66);assert.equal(r.y,130);assert.equal(r.x+r.width,1040);assert.equal(r.y+r.height,720);
  assert.equal(bounds({x:94,y:330,width:920,height:390},[1040,720]).x,94,'collapsed sidebar keeps native view aligned with its host');
  assert.throws(()=>bounds({x:NaN,y:100,width:400,height:400},[1040,720]));
  assert.throws(()=>bounds({x:1040,y:100,width:400,height:400},[1040,720]));
});
