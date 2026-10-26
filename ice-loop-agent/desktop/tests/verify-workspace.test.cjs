// PS5.1 behavior tests; all files and junctions belong to this isolated fixture.
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const repo=path.resolve(__dirname,'../..');
const root=fs.mkdtempSync(path.join(repo,'.test-tmp/verify-guards-'));
fs.writeFileSync(path.join(root,'.test-owner.json'),JSON.stringify({purpose:'verifier guard regression'}));
function ps(file,args=[]){return spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',file,...args],{cwd:repo,windowsHide:true,encoding:'utf8',env:{...process.env,TEMP:root,TMP:root,PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH,NODE_TEST_CONTEXT:'',ICE_DESKTOP_RUNTIME:'',ICE_PACKAGED_EXE:'',ICE_PYTHON:''}});}
function json(file){return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
const harness=path.join(root,'guards.ps1');
fs.writeFileSync(harness,'\ufeff'+String.raw`param([string]$Repo,[string]$Root)
$ErrorActionPreference='Stop'
. (Join-Path $Repo 'tools/verify-workspace-guards.ps1')
$base=Join-Path $Root '.test-tmp'
$owned=Join-Path $base 'release-fixture/owned'
$runtime=Join-Path $owned 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
'{"purpose":"guard regression"}' | Set-Content -Encoding UTF8 (Join-Path $owned '.test-owner.json')
$fixture=Join-Path $Root 'fixture.json'
@{runtime=$runtime} | ConvertTo-Json | Set-Content -Encoding UTF8 $fixture
$valid=Get-FixtureGuard $fixture $base 'release-fixture'
@{runtime=(Join-Path $Root 'personal')} | ConvertTo-Json | Set-Content -Encoding UTF8 $fixture
$foreign=Get-FixtureGuard $fixture $base 'release-fixture'
@{runtime=$runtime;config=(Join-Path $Root 'personal.json')} | ConvertTo-Json | Set-Content -Encoding UTF8 $fixture
$aux=Get-FixtureGuard $fixture $base 'release-fixture'
@{runtime=$runtime;config='../personal.json'} | ConvertTo-Json | Set-Content -Encoding UTF8 $fixture
$relativeAux=Get-FixtureGuard $fixture $base 'release-fixture'
@{runtime=$runtime;fault='../fault.json';trace=(Join-Path $owned 'trace.jsonl')} | ConvertTo-Json | Set-Content -Encoding UTF8 $fixture
$relativeFault=Get-FixtureGuard $fixture $base 'release-fixture'
@{runtime=$runtime;fault=(Join-Path $owned 'fault.json');trace='../trace.jsonl'} | ConvertTo-Json | Set-Content -Encoding UTF8 $fixture
$relativeTrace=Get-FixtureGuard $fixture $base 'release-fixture'
@{runtime=$runtime;fault=(Join-Path $owned 'fault.json');trace=(Join-Path $owned 'trace.jsonl')} | ConvertTo-Json | Set-Content -Encoding UTF8 $fixture
$ownedTrace=Get-FixtureGuard $fixture $base 'release-fixture' 
@{runtime=$runtime;output=('first line'+[char]13+[char]10+'second line')} | ConvertTo-Json | Set-Content -Encoding UTF8 $fixture
$multilineMetadata=Get-FixtureGuard $fixture $base 'release-fixture'
@{runtime=$runtime;trace=('invalid'+[char]13+[char]10+'path')} | ConvertTo-Json | Set-Content -Encoding UTF8 $fixture
$invalidPathMetadata=Get-FixtureGuard $fixture $base 'release-fixture' 
$result=@{
 valid=$valid.status; foreign=$foreign.status; auxiliary=$aux.status; relativeAuxiliary=$relativeAux.status; relativeFault=$relativeFault.status; relativeTrace=$relativeTrace.status; ownedTrace=$ownedTrace.status; multilineMetadata=$multilineMetadata.status; invalidPathMetadata=$invalidPathMetadata.status
 child=(Test-WorkspaceChild $runtime $base)
 prefix=(Test-WorkspaceChild ($base+'-other/runtime') $base)
 traversal=(Test-WorkspaceChild (Join-Path $base '../personal') $base)
 relative=(Test-WorkspaceChild '.test-tmp/runtime' $base)
 blockedDependency=(Test-StepDependencies @(@{name='build';status='not-run:no-deps'}) @('build'))
 missingDependency=(Test-StepDependencies @() @('build'))
 passedDependency=(Test-StepDependencies @(@{name='build';status='passed'}) @('build'))
}
$result | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 (Join-Path $Root 'guards.json')
`);

test('PS5.1 guards enforce canonical directory boundaries, fixture ownership and prerequisite success',{skip:process.platform!=='win32'},()=>{
 const r=ps(harness,[repo,root]);assert.equal(r.status,0,r.stderr||r.stdout);
 const g=json(path.join(root,'guards.json'));
 assert.equal(g.valid,'ok');assert.equal(g.foreign,'blocked:invalid-fixture');assert.equal(g.auxiliary,'blocked:invalid-fixture');assert.equal(g.relativeAuxiliary,'blocked:invalid-fixture');
 assert.equal(g.relativeFault,'blocked:invalid-fixture');assert.equal(g.relativeTrace,'blocked:invalid-fixture');assert.equal(g.ownedTrace,'ok');
 assert.equal(g.multilineMetadata,'ok');assert.equal(g.invalidPathMetadata,'blocked:invalid-fixture');
 assert.equal(g.child,true);for(const key of ['prefix','traversal','relative','blockedDependency','missingDependency'])assert.equal(g[key],false,key);
 assert.equal(g.passedDependency,true);
});

test('PS5.1 rejects junction traversal even when lexical paths belong to the test root',{skip:process.platform!=='win32'},()=>{
 const base=path.join(root,'junctions');fs.mkdirSync(base);const target=path.join(root,'target');fs.mkdirSync(target);
 const link=path.join(base,'linked');fs.symlinkSync(target,link,'junction');
 const file=path.join(root,'junction.ps1');
 fs.writeFileSync(file,"param($Repo,$Path,$Base)\n. (Join-Path $Repo 'tools/verify-workspace-guards.ps1')\nif(Test-WorkspaceChild $Path $Base){exit 2}else{exit 0}\n");
 const r=ps(file,[repo,path.join(link,'runtime'),base]);assert.equal(r.status,0,r.stderr||r.stdout);
});

test('requested unknown checks and missing dependencies return nonzero, never a green partial report',{skip:process.platform!=='win32'},()=>{
 const fake=path.join(root,'fake-app');fs.mkdirSync(path.join(fake,'tools'),{recursive:true});fs.mkdirSync(path.join(fake,'desktop/ui'),{recursive:true});
 for(const name of ['verify-workspace.ps1','verify-workspace-guards.ps1'])fs.copyFileSync(path.join(repo,'tools',name),path.join(fake,'tools',name));
 const out=path.join(fake,'.test-tmp/report');
 const r=ps(path.join(fake,'tools/verify-workspace.ps1'),['-Native','does-not-exist','-OutputDir',out]);
 assert.equal(r.status,1,r.stderr||r.stdout);
 assert.ok(fs.existsSync(path.join(out,'report.json')),r.stderr||r.stdout);
 const report=json(path.join(out,'report.json')); 
 assert.equal(report.complete,false);assert.ok(report.steps.some(s=>s.status==='not-run:unknown-native'));
 assert.equal(report.steps.find(s=>s.name==='check-bundle').status,'skipped:dependency');
 assert.equal(report.steps.find(s=>s.name==='python-full-baseline').status,'not-run:default-off');
});


test('requested missing fixture reports its seed command and exits incomplete after successful prerequisites',{skip:process.platform!=='win32'},()=>{
 const fake=path.join(root,'fake-app-ready');
 for(const dir of ['tools','desktop/tests','desktop/node_modules','desktop/ui/node_modules'])fs.mkdirSync(path.join(fake,dir),{recursive:true});
 for(const name of ['verify-workspace.ps1','verify-workspace-guards.ps1'])fs.copyFileSync(path.join(repo,'tools',name),path.join(fake,'tools',name));
 const scripts=Object.fromEntries(['check:ui','check','check:tools','build:ui','check:bundle'].map(name=>[name,'node -e "process.exit(0)"']));
 fs.writeFileSync(path.join(fake,'desktop/package.json'),JSON.stringify({scripts}));
 fs.writeFileSync(path.join(fake,'desktop/tests/stub.test.cjs'),"require('node:test')('isolated verifier fixture',()=>{});");
 const out=path.join(fake,'.test-tmp/report');
 const r=ps(path.join(fake,'tools/verify-workspace.ps1'),['-Native','onboarding','-OutputDir',out]);
 assert.equal(r.status,1,r.stderr||r.stdout);assert.ok(fs.existsSync(path.join(out,'report.json')),r.stderr||r.stdout);
 const report=json(path.join(out,'report.json'));assert.equal(report.complete,false);
 assert.equal(report.passed,6,r.stdout);
 const step=report.steps.find(s=>s.name==='native:onboarding');assert.equal(step.status,'skipped:missing-fixture');
 assert.match(step.note,/seed_onboarding_native\.py/);
});

// ---- 2026-10-21 批A：-PrepareNativeFixtures 行为回归（测试专属注册表 + 依赖注入）----
function buildPrepareApp(tag, opts) {
  const o = Object.assign({failSeedFor: null, failBuild: false, escapeFixture: false}, opts || {});
  const app=path.join(root,'prep-'+tag);
  for(const dir of ['tools','tests','docs/上线准备','desktop/tests','desktop/node_modules','desktop/ui/node_modules','.test-tmp'])fs.mkdirSync(path.join(app,dir),{recursive:true});
  for(const name of ['verify-workspace.ps1','verify-workspace-guards.ps1'])fs.copyFileSync(path.join(repo,'tools',name),path.join(app,'tools',name));
  // 测试专属注册表：两个同家族受控专项（仅供行为验证，不触碰真实注册表）。
  const verifier=fs.readFileSync(path.join(app,'tools/verify-workspace.ps1'),'utf8').replace(/^\uFEFF/,'');
  const markerStart=verifier.lastIndexOf('$nativeRegistry = @{'); // 注释里也引用了该名字，必须取定义处
  const markerEnd=verifier.indexOf('\n}',verifier.indexOf("'interaction-integrity'")); // registry 闭合行，而非条目行内的 }
  assert.ok(markerStart>0&&markerEnd>markerStart,'registry block not found');
  const BS=String.fromCharCode(92);
  const registry='\uFEFF'+verifier.slice(0,markerStart)+"$nativeRegistry = @{\n"+
    "  'case-a' = @{ prepare = $true; seed = 'tests"+BS+"stub_seed.py'; fixture = 'docs"+BS+"/上线准备"+BS+"/x-fixture.json'; network = 'mock/loopback'; script = 'tests"+BS+"stub-native.cjs'; family = 'release-x' }\n"+
    "  'case-b' = @{ prepare = $true; seed = 'tests"+BS+"stub_seed.py'; fixture = 'docs"+BS+"/上线准备"+BS+"/x-fixture.json'; network = 'mock/loopback'; script = 'tests"+BS+"stub-native.cjs'; family = 'release-x' }"+
    verifier.slice(markerEnd);
  fs.writeFileSync(path.join(app,'tools/verify-workspace.ps1'),registry);
  fs.writeFileSync(path.join(app,'tests','stub_seed.py'),[
    'import json,os,sys,uuid',
    'app=os.getcwd()  # Invoke-Step 以仓库为 cwd 执行 seed',
    "args=sys.argv[1:]",
    "name=args[args.index('-NativeName')+1] if '-NativeName' in args else 'case-a'",
    'fail_for=os.environ.get("STUB_SEED_FAIL")',
    'if fail_for and fail_for==name: sys.exit(3)',
    'if os.environ.get("STUB_SEED_NOOP")=="1": sys.exit(0)',
    'if os.environ.get("STUB_SEED_ESCAPE")=="1":',
    '    open(os.path.join(app,"docs/上线准备/x-fixture.json"),"w",encoding="utf-8").write(json.dumps({"runtime":os.path.join(os.environ["TEMP"],"escaped-runtime")})); sys.exit(0)',
    'owned=os.path.join(app,".test-tmp","release-x",uuid.uuid4().hex[:12]); runtime=os.path.join(owned,"runtime")',
    'os.makedirs(runtime,exist_ok=True)',
    'open(os.path.join(owned,".test-owner.json"),"w").write(json.dumps({"purpose":"prepare regression"}))',
    'entry=os.path.join(owned,"entry.cjs"); open(entry,"w").write("// stub")',
    'open(os.path.join(app,"docs/上线准备/x-fixture.json"),"w",encoding="utf-8").write(json.dumps({"runtime":runtime,"entry":entry},ensure_ascii=False))',
  ].join('\n'));
  // 原生步骤以 desktop 为 cwd（script 相对 desktop）；stub 原生真实读取本项 fixture 并把
  // 结果 json 写到 docs/上线准备/stub-native.json —— 这正是 evidence/result.json 的来源。
  fs.writeFileSync(path.join(app,'desktop','tests','stub-native.cjs'),[
    "const fs=require('node:fs'),path=require('node:path');",
    "const repo=path.resolve(__dirname,'../..');",
    "const fx=JSON.parse(fs.readFileSync(path.join(repo,'docs/上线准备/x-fixture.json'),'utf8'));",
    "const mode=process.env.STUB_NATIVE_MODE;",
    "if(mode!=='no-output')fs.writeFileSync(path.join(repo,'docs/上线准备/stub-native.json'),JSON.stringify({state:mode==='failed-state'?'failed':'finished',runtime:mode==='wrong-runtime'?'foreign-runtime':fx.runtime,checks:{fixture_consumed:mode!=='false-check'}}));",
  ].join('\n'));
  const scripts={};for(const name of ['check:ui','check','check:tools','check:bundle'])scripts[name]='node -e "process.exit(0)"';
  scripts['build:ui']=o.failBuild?'node -e "process.exit(7)"':'node -e "process.exit(0)"';
  fs.writeFileSync(path.join(app,'desktop/package.json'),JSON.stringify({scripts}));
  fs.writeFileSync(path.join(app,'desktop/tests/stub.test.cjs'),"require('node:test')('ok',()=>{});");
  return app;
}
function prepPs(app,args,extraEnv){
  const env=Object.assign({},process.env,extraEnv||{},{TEMP:root,TMP:root,NODE_TEST_CONTEXT:'',ICE_DESKTOP_RUNTIME:'',ICE_PACKAGED_EXE:'',ICE_PYTHON:''});
  // 注意：数组形如 case-a,case-b 必须不加引号，PowerShell 才会按列表解析绑定 [string[]]。
  const q=v=>/[ '"]/.test(v)?("'"+v.replace(/'/g,"''")+"'"):v;
  const script="'"+path.join(app,'tools/verify-workspace.ps1').replace(/'/g,"''")+"'";
  const cmdline='& '+script+' '+args.map(q).join(' ');
  return spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',cmdline],{cwd:app,windowsHide:true,encoding:'utf8',env});
}

test('prepare mode seeds an independent fixture per native; same family yields distinct runtimes and pinned evidence',{skip:process.platform!=='win32'},()=>{
  const app=buildPrepareApp('independent');
  const out=path.join(app,'.test-tmp/report-a');
  const r=prepPs(app,['-Scope','quick','-Native','case-a,case-b','-PrepareNativeFixtures','-PythonExe',process.env.PY||'python','-OutputDir',out]);
  assert.equal(r.status,0,r.stderr||r.stdout);
  const report=json(path.join(out,'report.json'));
  assert.equal(report.complete,true);
  const seeds=report.steps.filter(s=>s.name.indexOf('seed:')===0);
  assert.equal(seeds.length,2,r.stdout);
  const runtimes=seeds.map(s=>(s.note||'').replace('seeded runtime: ',''));
  assert.notEqual(runtimes[0],runtimes[1],'same-family natives must get distinct runtimes');
  assert.ok(runtimes.every(t=>t.indexOf('release-x')>=0),runtimes.join(','));
  for(const name of ['case-a','case-b']){
    assert.ok(fs.existsSync(path.join(out,'native-evidence',name,'fixture.json')),name+' fixture snapshot');
    assert.ok(fs.existsSync(path.join(out,'native-evidence',name,'result.json')),name+' result snapshot');
  }
  const rt1=json(path.join(out,'native-evidence','case-a','fixture.json')).runtime;
  const rt2=json(path.join(out,'native-evidence','case-b','fixture.json')).runtime;
  assert.notEqual(rt1,rt2,'evidence must pin the data each native actually used');
  for(const name of ['case-a','case-b']){
    const fx=json(path.join(out,'native-evidence',name,'fixture.json'));
    const res=json(path.join(out,'native-evidence',name,'result.json'));
    assert.equal(res.runtime,fx.runtime,name+' result must reflect the fixture it consumed');
  }
});

test('default mode never seeds; a failed seed blocks only its native while independent items continue',{skip:process.platform!=='win32'},()=>{
  const app=buildPrepareApp('defaults');
  const outDefault=path.join(app,'.test-tmp/report-default');
  const d=prepPs(app,['-Native','case-a','-OutputDir',outDefault]);
  assert.equal(d.status,1,d.stderr||d.stdout);
  const rd=json(path.join(outDefault,'report.json'));
  assert.equal(rd.steps.find(s=>s.name==='native:case-a').status,'skipped:missing-fixture');
  assert.equal(rd.steps.filter(s=>s.name.indexOf('seed:')===0).length,0,'default mode must not seed');
  const outFail=path.join(app,'.test-tmp/report-fail');
  const f=prepPs(app,['-Native','case-a,case-b','-PrepareNativeFixtures','-PythonExe',process.env.PY||'python','-OutputDir',outFail],{STUB_SEED_FAIL:'case-a'});
  assert.equal(f.status,1,f.stderr||f.stdout);
  const rf=json(path.join(outFail,'report.json'));
  assert.equal(rf.steps.find(s=>s.name==='seed:case-a').status,'failed');
  assert.equal(rf.steps.find(s=>s.name==='native:case-a').status,'blocked:seed-failed');
  assert.equal(rf.steps.find(s=>s.name==='seed:case-b').status,'passed');
  assert.equal(rf.steps.find(s=>s.name==='native:case-b').status,'passed');
  assert.equal(rf.complete,false);
});

test('prepare mode still enforces fixture boundary guards and build prerequisites',{skip:process.platform!=='win32'},()=>{
  const app=buildPrepareApp('guards');
  const outEsc=path.join(app,'.test-tmp/report-esc');
  const e=prepPs(app,['-Native','case-a','-PrepareNativeFixtures','-PythonExe',process.env.PY||'python','-OutputDir',outEsc],{STUB_SEED_ESCAPE:'1'});
  assert.equal(e.status,1,e.stderr||e.stdout);
  const re=json(path.join(outEsc,'report.json'));
  assert.equal(re.steps.find(s=>s.name==='native:case-a').status,'blocked:invalid-fixture');
  const app2=buildPrepareApp('buildfail',{failBuild:true});
  const outB=path.join(app2,'.test-tmp/report-b');
  const b=prepPs(app2,['-Native','case-a','-PrepareNativeFixtures','-PythonExe',process.env.PY||'python','-OutputDir',outB]);
  assert.equal(b.status,1,b.stderr||b.stdout);
  const rb=json(path.join(outB,'report.json'));
  assert.equal(rb.steps.find(s=>s.name==='build-ui').status,'failed');
  assert.equal(rb.steps.find(s=>s.name==='check-bundle').status,'skipped:dependency');
  assert.equal(rb.steps.find(s=>s.name==='seed:case-a').status,'skipped:dependency');
  assert.equal(fs.existsSync(path.join(app2,'docs/上线准备/x-fixture.json')),false,'build failure must not seed unused data');
  assert.equal(rb.steps.find(s=>s.name==='native:case-a').status,'skipped:dependency');
  assert.equal(rb.complete,false);
});



test('a successful no-op seed cannot reuse an older fixture as fresh evidence',{skip:process.platform!=='win32'},()=>{
  const app=buildPrepareApp('stale-seed');
  const args=['-Native','case-a','-PrepareNativeFixtures','-PythonExe',process.env.PY||'python'];
  const first=prepPs(app,[...args,'-OutputDir',path.join(app,'.test-tmp/first')]);
  assert.equal(first.status,0,first.stderr||first.stdout);
  const out=path.join(app,'.test-tmp/noop');
  const r=prepPs(app,[...args,'-OutputDir',out],{STUB_SEED_NOOP:'1'});
  assert.equal(r.status,1,'a zero-exit seed without new fixture must be incomplete');
  const report=json(path.join(out,'report.json'));
  assert.equal(report.complete,false);
  assert.equal(report.steps.find(s=>s.name==='native:case-a').status,'blocked:stale-fixture');
  assert.equal(fs.existsSync(path.join(out,'native-evidence/case-a/result.json')),false,'blocked run must not copy an old result');
});

test('a zero-exit native must produce a fresh, successful result for its own runtime',{skip:process.platform!=='win32'},()=>{
  for(const mode of ['no-output','stale-output','wrong-runtime','failed-state','false-check']){
    const app=buildPrepareApp('evidence-'+mode),out=path.join(app,'.test-tmp/report');
    if(mode==='stale-output')fs.writeFileSync(path.join(app,'docs/上线准备/stub-native.json'),JSON.stringify({state:'finished',runtime:'old-runtime'}));
    const r=prepPs(app,['-Native','case-a','-PrepareNativeFixtures','-PythonExe',process.env.PY||'python','-OutputDir',out],{STUB_NATIVE_MODE:mode==='stale-output'?'no-output':mode});
    assert.equal(r.status,1,mode+' must not pass on process exit alone');
    const report=json(path.join(out,'report.json')),step=report.steps.find(s=>s.name==='native:case-a');
    assert.equal(report.complete,false,mode);
    assert.equal(step.status,'failed',mode);
    assert.equal(step.exitCode,0,'preserve actual process exit code: '+mode);
    assert.match(step.evidenceStatus,/^(missing|stale|runtime-mismatch|incomplete)-result$/,mode);
    if(['no-output','stale-output'].includes(mode))assert.equal(fs.existsSync(path.join(out,'native-evidence/case-a/result.json')),false,mode+' must not archive stale evidence');
  }
});
