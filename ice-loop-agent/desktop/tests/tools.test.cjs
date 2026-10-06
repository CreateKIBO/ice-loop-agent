const {test}=require('node:test');const assert=require('node:assert/strict');const {publicAddress}=require('../tools.cjs');
test('web capture blocks non-public destinations',()=>{
  for(const ip of ['127.0.0.1','10.0.1.1','172.16.1.2','192.168.0.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','198.18.0.1','192.0.2.5','203.0.113.1','::1','::ffff:127.0.0.1','fd00::1','fe80::1','2001:db8::1'])assert.equal(publicAddress(ip),false,ip);
  for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(publicAddress(ip),true,ip);
});
