"""Replay a fixed historical Store/TaskQueue snapshot in a new owned directory.

Uses local Git objects only. No checkout reset, personal database or network.
The old source runs on today's Python/dependencies, not an old installed EXE.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
from uuid import uuid4
import zipfile

REPO = Path(__file__).resolve().parents[1]
HISTORICAL_REF = '6b5d63c'
GENERATOR = r'''
import hashlib,json,socket,sys
from pathlib import Path

def denied(*args, **kwargs):
    raise RuntimeError('Network disabled in historical Store validation')
socket.socket.connect=denied
socket.socket.connect_ex=denied
from ice_agent import __version__
from ice_agent.domain.store import Store
from ice_agent.tasks import TaskQueue
import ice_agent
root=Path(sys.argv[1]);store=Store(root/'historical.db')
try:
    body='# 历史正文\n\n必须逐字保留。'
    store.conn.execute('INSERT INTO articles(article_id,series,episode,topic,readiness,spec_json,created_at) VALUES(?,?,?,?,?,?,?)',('legacy-article','PY',11,'历史源码生成文章','draft',json.dumps({'article_root':str(root/'articles')},ensure_ascii=False),'2026-10-07'))
    store.conn.execute('INSERT INTO article_revisions(revision_id,article_id,kind,content,content_hash,created_at) VALUES(?,?,?,?,?,?)',('legacy-revision','legacy-article','draft',body,hashlib.sha256(body.encode()).hexdigest(),'2026-10-07'))
    store.conn.commit()
    TaskQueue(store).enqueue('ice-loop','production',{'spec':{'article_root':str(root/'articles'),'topic':'历史源码生成文章'}},idempotency_key='legacy-key',task_id='legacy-task')
    store.conn.execute("UPDATE tasks SET state='paused' WHERE task_id='legacy-task'")
    store.conn.commit()
    result={'module':str(Path(ice_agent.__file__).resolve()),'app_version':__version__,'python':sys.version,'schema':store.conn.execute('PRAGMA user_version').fetchone()[0],
        'history':[list(r) for r in store.conn.execute('SELECT * FROM schema_migrations ORDER BY version')],
        'articles':[list(r) for r in store.conn.execute('SELECT article_id,series,episode,topic,readiness,spec_json,created_at FROM articles')],
        'revisions':[list(r) for r in store.conn.execute('SELECT revision_id,article_id,kind,content,content_hash,created_at FROM article_revisions')],
        'tasks':[list(r) for r in store.conn.execute('SELECT task_id,account_id,kind,state,input_hash,idempotency_key,payload,created_at,updated_at FROM tasks')]}
finally:
    store.close()
print(json.dumps(result,ensure_ascii=False))
'''


def sha(file):
    with Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def run(output):
    output = Path(output)
    if not output.is_absolute():
        output = REPO / output
    output = output.resolve()
    output.relative_to(REPO / '.test-tmp')
    for parent in [output, *output.parents]:
        if parent == REPO:
            break
        if parent.is_symlink() or parent.is_junction():
            raise ValueError('Historical verification output must not contain links')
    output.mkdir(parents=True, exist_ok=False)
    (output / '.test-owner.json').write_text(json.dumps({'purpose':'historical Store verification','commit':HISTORICAL_REF}),encoding='utf-8')
    result = {'state':'running','output':str(output),'checks':{},'scope':'actual historical source with current interpreter/dependencies; not a customer archive or historical EXE'}
    def save():
        (output / 'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    def check(name, value):
        if not value:
            raise AssertionError(name)
        result['checks'][name]=True
        save()
    try:
        git_root = Path(subprocess.check_output(['git','-C',str(REPO),'rev-parse','--show-toplevel'],text=True,encoding='utf-8').strip())
        commit = subprocess.check_output(['git','-C',str(git_root),'rev-parse','--verify',HISTORICAL_REF+'^{commit}'],text=True,encoding='utf-8').strip()
        result['historical_commit']=commit
        package = (REPO / 'ice_agent').relative_to(git_root).as_posix()
        archive = output / 'source.zip'
        subprocess.run(['git','-C',str(git_root),'archive','--format=zip','--output='+str(archive),commit,package],check=True,capture_output=True)
        result['archive_sha256']=sha(archive)
        sources=output/'source';sources.mkdir()
        with zipfile.ZipFile(archive) as bundle:
            for entry in bundle.infolist():
                if entry.is_dir() or not entry.filename.endswith('.py'):
                    continue
                parts=PurePosixPath(entry.filename).parts
                if entry.filename.startswith('/') or '..' in parts or '\\' in entry.filename or stat.S_ISLNK(entry.external_attr>>16):
                    raise ValueError('Unsafe historical source entry')
                target=sources.joinpath(*parts);target.resolve().relative_to(sources)
                target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(bundle.read(entry))
        environment=dict(os.environ)
        for key in ('PYTHONPATH','DASHSCOPE_API_KEY','DEEPSEEK_API_KEY','MOONSHOT_API_KEY','BIGMODEL_API_KEY','ARK_API_KEY','MINIMAX_API_KEY'):
            environment.pop(key,None)
        temporary=output/'temp';temporary.mkdir()
        environment.update(TEMP=str(temporary),TMP=str(temporary),PYTHONDONTWRITEBYTECODE='1',PYTHONUTF8='1')
        old_root=sources/REPO.relative_to(git_root)
        child=subprocess.run([sys.executable,'-X','utf8','-B','-c',GENERATOR,str(output)],cwd=old_root,env=environment,capture_output=True,text=True,encoding='utf-8',timeout=60)
        (output/'generator.log').write_text(child.stdout+child.stderr,encoding='utf-8')
        if child.returncode:
            raise RuntimeError('Historical generation failed; see generator.log')
        before=json.loads(child.stdout);result['before']=before
        check('historical_module_really_loaded',Path(before['module']).is_relative_to(sources))
        check('historical_schema_11_created',before['schema']==11)
        original=output/'historical.db';original_sha=sha(original);result['original_db_sha256']=original_sha
        current=output/'migrated-copy.db';shutil.copy2(original,current)
        sys.path.insert(0,str(REPO))
        from ice_agent.domain.store import Store
        from ice_agent.migrations import MAX_KNOWN_VERSION, verify_migrations
        from ice_agent.tasks import TaskQueue, canonical_input_hash
        store=Store(current)
        try:
            after={'schema':store.conn.execute('PRAGMA user_version').fetchone()[0],
                'history':[list(r) for r in store.conn.execute('SELECT * FROM schema_migrations ORDER BY version')],
                'articles':[list(r) for r in store.conn.execute('SELECT article_id,series,episode,topic,readiness,spec_json,created_at FROM articles')],
                'revisions':[list(r) for r in store.conn.execute('SELECT revision_id,article_id,kind,content,content_hash,created_at FROM article_revisions')],
                'tasks':[list(r) for r in store.conn.execute('SELECT task_id,account_id,kind,state,input_hash,idempotency_key,payload,created_at,updated_at FROM tasks')],
                'audit':verify_migrations(store.conn)}
            result['after_migration']=after
            check('current_schema_reached',after['schema']==MAX_KNOWN_VERSION)
            for name in ('articles','revisions','tasks'):
                check(name+'_preserved',before[name]==after[name])
            check('historical_receipts_preserved',before['history']==after['history'][:len(before['history'])])
            check('current_audit_passes',not after['audit']['problems'])
            queue=TaskQueue(store);old_task=queue.get('legacy-task')
            replay=queue.enqueue('ice-loop','production',old_task['payload'],idempotency_key='legacy-key')
            result['task_after_replay']=replay
            check('legacy_replay_uses_original_identity',replay['task_id']=='legacy-task')
            check('legacy_replay_preserves_paused_state',replay['state']=='paused' and replay['attempt']==0)
            check('legacy_hash_promoted_for_identical_payload',replay['input_hash']==canonical_input_hash(old_task['payload']))
            check('no_duplicate_task_or_paid_call',store.conn.execute('SELECT COUNT(*) FROM tasks').fetchone()[0]==1 and store.conn.execute('SELECT COUNT(*) FROM model_invocations').fetchone()[0]==0)
        finally:
            store.close()
        check('original_database_unchanged',sha(original)==original_sha)
        result['state']='finished';save()
    except BaseException as error:
        result['state']='failed';result['error']=str(error);save();raise
    return result


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir',default=str(REPO/'.test-tmp/historical-store'/uuid4().hex[:12]))
    args=parser.parse_args()
    try:
        result=run(args.output_dir)
        print(json.dumps({'state':result['state'],'output':result['output'],'checks':len(result['checks'])}))
    except Exception as error:
        print(str(error),file=sys.stderr)
        raise SystemExit(1)
