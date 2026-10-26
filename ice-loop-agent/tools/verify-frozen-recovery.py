"""Exercise the actual packaged recovery engine on pinned, owned offline fixtures."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import queue
import threading
import time
import uuid


def main():
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--fixture', required=True)
    args = parser.parse_args()
    candidate, fixture = Path(args.candidate).resolve(), Path(args.fixture).resolve()
    if not candidate.is_relative_to(repo / '.test-tmp/candidates') or not fixture.is_relative_to(repo / '.test-tmp'):
        parser.error('candidate and pinned fixture must belong to project .test-tmp')
    meta = json.loads((candidate / 'CANDIDATE.json').read_text(encoding='utf-8'))
    if meta['state'] != 'built' or meta['project'] != str(repo):
        parser.error('candidate is not a completed build of this project')
    for audit in ('asar-audit.json', 'payload-audit.json'):
        if json.loads((candidate / audit).read_text(encoding='utf-8'))['state'] != 'passed':
            parser.error('candidate payload audits are required')
    f = json.loads(fixture.read_text(encoding='utf-8-sig'))
    source = Path(f['root']).resolve()
    if (source.parent != repo / '.test-tmp/release-backup'
            or not (source / '.test-owner.json').is_file()
            or Path(f['runtime']).resolve() != source / 'runtime'
            or Path(f['package']).resolve().parent != source):
        parser.error('fixture is not a controlled startup recovery workspace')
    engine = Path(meta['executable']).parent / 'resources/engine/ice-engine.exe'
    project = engine.parent.parent / 'engine-project'
    if not (project / 'BUILD.json').is_file():
        parser.error('candidate bundled project resources are missing')
    root = repo / '.test-tmp/frozen-recovery' / uuid.uuid4().hex[:12]
    root.mkdir(parents=True)
    (root / '.test-owner.json').write_text('{"purpose":"frozen recovery verification"}')
    scratch = root / 'scratch'; scratch.mkdir()
    report = {'state':'running', 'runtime':str(root), 'candidate':str(candidate), 'engine':str(engine),
              'fixture':str(fixture), 'checks':{}, 'success':False,
              'scope':'actual packaged frozen engine; controlled offline fixtures; development PATH removed'}
    def save():
        (root / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    def digest(file):
        return hashlib.sha256(file.read_bytes()).hexdigest()
    def check(name, value):
        if not value:
            raise AssertionError(name)
        report['checks'][name] = True; save()
    env = {**os.environ, 'TEMP':str(scratch), 'TMP':str(scratch), 'ICE_PACKAGED':'1',
           'PATH':str(Path(os.environ['SystemRoot']) / 'System32'), 'PYTHONUTF8':'1', 'PYTHONIOENCODING':'utf-8'}
    for key in list(env):
        if any(word in key.upper() for word in ('API_KEY','ACCESS_TOKEN','AUTHORIZATION')) or key in ('PYTHONPATH','VIRTUAL_ENV','ICE_PYTHON','ICE_TEACHING_PYTHON'):
            env.pop(key, None)
    counter = 0
    def call(operation, params, expected_code=0):
        nonlocal counter
        counter += 1
        child = subprocess.run([str(engine), '--project-root', str(project), '--runtime-root', str(scratch),
                '--recovery-operation', operation], input=json.dumps(params).encode('utf-8'), capture_output=True,
                cwd=project, env=env, timeout=60)
        (root / f'{counter}-stdout.bin').write_bytes(child.stdout)
        (root / f'{counter}-stderr.bin').write_bytes(child.stderr)
        if child.returncode != expected_code:
            raise AssertionError(f'{operation}: unexpected exit {child.returncode}')
        try:
            response = json.loads(child.stdout.decode('utf-8'))
        except UnicodeDecodeError as error:
            raise AssertionError(f'{operation}: frozen recovery output is not UTF-8') from error
        if expected_code:
            assert 'error' in response
            return response
        return response['result']
    try:
        save()
        files = [source / 'runtime/app.db', source / 'future/app.db', Path(f['package'])]
        before = {str(file):digest(file) for file in files}
        report['engine_sha256'] = digest(engine)
        copy = root / '中文工作区'
        shutil.copytree(source / 'runtime', copy)
        settings_file = copy / 'settings.json'
        settings = json.loads(settings_file.read_text(encoding='utf-8'))
        settings['accounts'][settings['active_account_id']]['name'] = '中文恢复验收公众号'
        settings_file.write_text(json.dumps(settings, ensure_ascii=False), encoding='utf-8')
        info = call('workspace.inspect', {'runtime_root':str(copy)})
        check('unicode-workspace-name-roundtrip', info['accounts'][0]['name'] == '中文恢复验收公众号')
        check('workspace-inspected-through-frozen-entry', info['database_target_schema'] == f['target_schema'])
        refused = call('workspace.inspect', {'runtime_root':str(source / 'future')}, 1)
        check('unicode-future-schema-error-roundtrip', bool(refused['error']) and any(ord(c) > 127 for c in refused['error']))
        summary = call('backup.inspect', {'file_path':f['package']})
        check('frozen-backup-preview', summary['database_checked'] and summary['database_target_schema'] == f['target_schema'])
        restored = call('backup.restore', {'file_path':f['package'], 'destination':str(root / '恢复后资料'), 'package_hash':summary['package_hash']})
        check('unicode-restored-path-roundtrip', '恢复后资料' in restored['runtime_root'] and Path(restored['runtime_root']).is_dir())
        with closing(sqlite3.connect((Path(restored['runtime_root']) / 'app.db').as_uri()+'?mode=ro', uri=True)) as db:
            check('restored-current-schema', db.execute('PRAGMA user_version').fetchone()[0] == f['target_schema'])
            check('no-model-invocations', db.execute('SELECT COUNT(*) FROM model_invocations').fetchone()[0] == 0)
            check('restored-queue-paused', all(row[0] == 'paused' for row in db.execute('SELECT state FROM tasks')))
        # Real frozen DesktopService startup, before live schema migration.
        upgrade_runtime = Path(restored['runtime_root'])
        with closing(sqlite3.connect(upgrade_runtime/'app.db')) as db:
            db.execute('DROP TABLE creative_send_receipts')
            db.execute('DELETE FROM schema_migrations WHERE version=21')
            db.execute('PRAGMA user_version=20'); db.commit()
            db.execute('PRAGMA journal_mode=DELETE')
        startup = subprocess.run([str(engine),'--project-root',str(project),'--runtime-root',str(upgrade_runtime),
            '--startup-session',uuid.uuid4().hex],input=b'{"id":1,"method":"bootstrap"}\n',capture_output=True,cwd=project,env=env,timeout=60)
        (root/'startup-stdout.bin').write_bytes(startup.stdout)
        (root/'startup-stderr.bin').write_bytes(startup.stderr)
        replies = [json.loads(line.decode('utf-8')) for line in startup.stdout.splitlines() if line.strip()]
        check('frozen-upgrade-starts-with-utf8-progress',startup.returncode==0 and any(item.get('phase')=='save_recovery_point' for item in replies))
        check('frozen-upgrade-bootstrap-replies',any(item.get('id')==1 and item.get('result',{}).get('runtime_root')==str(upgrade_runtime) for item in replies))
        points = call('recovery.list',{'runtime_root':str(upgrade_runtime)})['points']
        check('frozen-owned-point-is-complete',len(points)==1 and points[0]['state']=='ready' and points[0]['source_schema']==20)
        point_summary = call('recovery.inspect',{'runtime_root':str(upgrade_runtime),'point_id':points[0]['point_id']})
        point_restore = call('recovery.restore',{'runtime_root':str(upgrade_runtime),'point_id':points[0]['point_id'],
            'destination':str(root/'升级恢复点还原'),'package_hash':point_summary['package_hash']})
        check('frozen-point-restores-into-new-directory',point_restore['database_schema']==f['target_schema'] and Path(point_restore['runtime_root']).is_dir())
        with closing(sqlite3.connect(Path(point_restore['runtime_root'])/'app.db')) as db:
            check('frozen-point-restore-has-no-paid-work',db.execute('SELECT COUNT(*) FROM model_invocations').fetchone()[0]==0 and all(row[0]=='paused' for row in db.execute('SELECT state FROM tasks')))
        # Use the packaged project directory, with no source tree/Python on PATH.
        # Keep stdin open while the real async model worker completes; EOF would
        # legitimately cancel pending pool work and prove nothing about delivery.
        live_runtime = Path(point_restore['runtime_root'])
        live_settings = live_runtime / 'settings.json'
        config = json.loads(live_settings.read_text(encoding='utf-8'))
        profile = f['offline_profile']
        assert profile['adapter'] == 'mock' and profile['base_url'] == 'mock://local'
        config['profiles'] = {'offline':profile}; config['max_chat_calls'] = 1
        for route in config['routes'].values():
            route.update(primary=profile['profile_id'],fallbacks=[])
        live_settings.write_text(json.dumps(config,ensure_ascii=False),encoding='utf-8')

        def live_session(label, work):
            child = subprocess.Popen([str(engine),'--project-root',str(project),'--runtime-root',str(live_runtime)],
                stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,cwd=project,env=env)
            report.setdefault('owned_child_pids',[]).append(child.pid); save()
            incoming = queue.Queue(); buffered = {}; serial = 0
            def stdout_reader():
                try:
                    with (root / (label+'-stdout.bin')).open('wb') as log:
                        for raw in child.stdout:
                            log.write(raw)
                            try: incoming.put(json.loads(raw.decode('utf-8')))
                            except Exception as error: incoming.put(error)
                finally: incoming.put(EOFError('packaged engine closed its output'))
            def stderr_reader():
                remaining=1024*1024
                with (root / (label+'-stderr.bin')).open('wb') as log:
                    while True:
                        raw=child.stderr.read(4096)
                        if not raw:break
                        log.write(raw[:remaining]); remaining=max(0,remaining-len(raw))
            readers=[threading.Thread(target=stdout_reader,daemon=True),threading.Thread(target=stderr_reader,daemon=True)]
            for reader in readers:reader.start()
            def ask(method,params):
                nonlocal serial
                serial+=1; request_id=str(serial)
                child.stdin.write((json.dumps({'id':request_id,'method':method,'params':params},ensure_ascii=False)+'\n').encode('utf-8'));child.stdin.flush()
                deadline=time.monotonic()+30
                while request_id not in buffered:
                    item=incoming.get(timeout=max(.001,deadline-time.monotonic()))
                    if isinstance(item,Exception):raise item
                    if item.get('kind')=='response':buffered[str(item['id'])]=item
                    if time.monotonic()>=deadline:raise TimeoutError(method)
                return buffered.pop(request_id)
            try:
                return work(ask)
            finally:
                child.stdin.close()
                try:child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.terminate()
                    try:child.wait(timeout=3)
                    except subprocess.TimeoutExpired:child.kill();child.wait(timeout=3)
                for reader in readers:reader.join(timeout=3)
                child.stdout.close();child.stderr.close()
                check(label+'-owned-child-exited',child.returncode==0 and all(not r.is_alive() for r in readers))

        request={}
        def send_work(ask):
            created=ask('chat.create',{'title':'冻结版发送回执验收'})['result']
            request.update(conversation_id=created['conversation']['id'],text='讨论公众号文章结构',request_id='frozen-send-once')
            accepted=ask('chat.send',request)['result']
            repeated=ask('chat.send',request)['result']
            check('frozen-send-replay-keeps-original-message',accepted['accepted'] and repeated['replayed'] and accepted['message_id']==repeated['message_id'])
            deadline=time.monotonic()+20
            while True:
                chat=ask('chat.get',{'conversation_id':request['conversation_id']})['result']
                if not any(row['status']=='streaming' for row in chat['messages']):break
                if time.monotonic()>=deadline:raise TimeoutError('offline frozen reply did not finish')
                time.sleep(.05)
            check('frozen-offline-turn-finishes-exactly-once',len(chat['messages'])==2 and chat['messages'][-1]['status']=='completed')
            conflict=ask('chat.send',{**request,'text':'同键但内容不同'})
            check('frozen-conflicting-send-is-explicit',conflict.get('error',{}).get('code')=='IDEMPOTENCY_CONFLICT')
            cancelled={**request,'request_id':'frozen-cancel-before-send','text':'取消尚未发送的需求'}
            check('frozen-unaccepted-request-cancelled',ask('chat.cancel_send',cancelled)['result'].get('cancelled') is True)
            check('frozen-late-send-cannot-bypass-cancellation',ask('chat.send',cancelled)['result'].get('cancelled') is True)
            return accepted['message_id']
        accepted_id=live_session('live-send',send_work)
        def restart_work(ask):
            receipt=ask('chat.receipt',request)['result']
            replay=ask('chat.send',request)['result']
            check('frozen-restart-finds-durable-original-receipt',receipt['message_id']==accepted_id and replay['message_id']==accepted_id and replay['replayed'])
        live_session('live-restart',restart_work)
        with closing(sqlite3.connect((live_runtime/'app.db').as_uri()+'?mode=ro',uri=True)) as db:
            check('frozen-replay-restart-cancel-use-only-one-offline-invocation',db.execute('SELECT COUNT(*) FROM model_invocations').fetchone()[0]==1)
        check('frozen-live-project-is-bundled-not-source-tree',project.parent==engine.parent.parent and not (project/'ice_agent').exists())
        check('source-and-zip-bytes-unchanged', all(digest(file) == before[str(file)] for file in files))
        check('scratch-clean-no-service-or-worker-database', not list(scratch.iterdir()))
        report['success'] = True
    except Exception as error:
        report['error'] = str(error)
    finally:
        report['state'] = 'finished'; save()
        (candidate / 'recovery-audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'success':report['success'], 'checks':len(report['checks']), 'result':str(root / 'result.json'), 'error':report.get('error')}, ensure_ascii=False))
    return 0 if report['success'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
