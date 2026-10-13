"""Account-scoped maintenance and production tools, no arbitrary shell endpoints."""
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from .domain.types import now_iso, sha256_json, sha256_text, new_id
from .paths import ensure_dir, assert_within, atomic_write_text

class Workbench:
    METHODS={'rules.list','rules.save','rules.resolve','rules.remove','tools.status','tools.diagnostics','tools.execution_settings','tools.provider_check',
             'reminders.list','reminders.save','reminders.dismiss','git.preview','git.apply','models.catalog',
             'articles.semantic_review','articles.clipboard','assets.redo','resources.transform','resources.cover','capture.windows','capture.native','capture.web_finish',
             'prompts.generate','prompts.save','prompts.references','resources.import_style','budgets.get','budgets.save'}
    def __init__(self,service):self.s=service

    def call(self,method,params):
        if method.startswith('budgets.'):
            from .model_budgets import ModelBudgets
            return getattr(ModelBudgets(self.s),method.split('.')[1])(params)
        if method.startswith('prompts.'):
            from .image_prompts import PromptWorkbench
            return PromptWorkbench(self.s).call(method,params)
        _,_,store=self.s._app()
        try:
            from .rules.sources import RuleSources
            if method=='resources.import_style':
                from .style_presets import import_ice_style
                return import_ice_style(store,self.s.runtime,self.s._account(),params)
            if method.startswith('rules.'):
                return getattr(RuleSources(store,self.s._account()['id']),method.split('.')[1])(params) if method!='rules.list' else RuleSources(store,self.s._account()['id']).list()
            if method.startswith('reminders.'):
                return self.reminders(store,method,params)
            if method.startswith('git.'):
                return self.git(method,params)
            if method=='tools.status':return self.status(store)
            if method=='tools.provider_check':
                from .llm.adapters import make_adapter,extract_json_block
                from .domain.types import ModelProfile
                profile=self.s.settings['profiles'].get(params.get('provider'))
                if not profile:raise ValueError('供应商不存在')
                response=make_adapter(ModelProfile(**profile)).chat([{'role':'user','content':'这是桌面程序功能自检。请仅返回JSON对象，字段title为一条中文文章标题，article为100至180字中文短文，向第一次使用AI写作的人解释人工审阅标题的重要性。不要虚构事实、来源、个人经历或运行结果。不要生成代码。'}],thinking_policy='prefer_off',want_json=True,timeout=45)
                data=extract_json_block(response.content)
                if not isinstance(data.get('title'),str) or not isinstance(data.get('article'),str) or len(data['article'])<50:raise ValueError('模型自检未返回完整标题和正文')
                file=ensure_dir(self.s.runtime/'selftest')/(params['provider']+'-actual-article.md');atomic_write_text(file,'# '+data['title']+'\n\n'+data['article']+'\n')
                return {'ok':True,'provider':params['provider'],'model':response.raw_model or profile['model_id'],'json_valid':True,'article_characters':len(data['article']),'usage':response.usage or {'usage':'unknown'},'file_path':str(file)}
            if method=='tools.execution_settings':
                mode=params.get('mode');images=params.get('images')
                if mode not in ('docker','local_reviewed') or not isinstance(images,dict) or set(images)!={'python','java'} or any(not isinstance(v,str) or not re.fullmatch(r'[a-z0-9][a-z0-9./:_-]{0,150}',v) for v in images.values()):raise ValueError('请填写有效模式及Python/Java镜像')
                with self.s._settings_guard:
                    self.s.settings['execution']={'mode':mode,'images':images};atomic_write_text(self.s.settings_file,json.dumps(self.s.settings,ensure_ascii=False,indent=2))
                return {'ok':True,'new_tasks_only':True}
            if method=='tools.diagnostics':
                report=self.status(store)
                # Allowlist-only report: no settings, paths, task content, remote response bodies or keys.
                # SQL 一律字面量：计数语句逐表展开，不用表名拼接。
                report['counts']={
                    'articles':store.conn.execute('SELECT COUNT(*) FROM articles').fetchone()[0],
                    'model_invocations':store.conn.execute('SELECT COUNT(*) FROM model_invocations').fetchone()[0],
                    'asset_candidates':store.conn.execute('SELECT COUNT(*) FROM asset_candidates').fetchone()[0]}
                report['counts']['jobs']=len(self.s.jobs_list({}))
                target=ensure_dir(self.s.runtime/'diagnostics')/('diagnostics-'+new_id('report')+'.json')
                atomic_write_text(target,json.dumps(report,ensure_ascii=False,indent=2))
                return {'report':report,'file_path':str(target)}
            if method=='models.catalog':return self.catalog(params)
            if method=='articles.semantic_review':return self.semantic_review(params)
            if method=='articles.clipboard':
                self.s.articles_revisions(params)
                engine,_,job_store=self.s._job_app(params['job_id'])
                try:
                    from .export.rich_text import rich_text
                    from .providers.tapnow import selected_asset
                    job=job_store.get_job(params['job_id']);state=engine._load_state(job['job_id']);figures={};images={};total=0
                    for slot in job_store.article_slots(job['article_id']):
                        selected=selected_asset(job_store,slot)
                        if selected:
                            raw=Path(selected['file_path']).read_bytes();total+=len(raw)
                            if total>15000000:raise ValueError('图片超过15MB，请从文章包手动插入图片')
                            extension=Path(selected['file_path']).suffix.lower().lstrip('.');path=f"images/figure-{slot['figure_no']}.{extension}"
                            figures[slot['figure_no']]=path;images[path]='data:image/'+('jpeg' if extension in ('jpg','jpeg') else extension)+';base64,'+base64.b64encode(raw).decode()
                    body=state.get('integrated_md',state.get('draft_md',''));html=rich_text(body,state.get('final_title',''),figures)
                    for path,uri in images.items():html=html.replace('src="'+path+'"','src="'+uri+'"')
                    return {'html':html,'text':body,'image_count':len(images),'readiness':job_store.get_article(job['article_id'])['readiness']}
                finally:job_store.close()
            if method=='assets.redo':return self.redo(params)
            if method in ('resources.transform','resources.cover'):
                from .image_tools import transform,cover
                from .workspace_assets import WorkspaceAssets
                box=WorkspaceAssets(store,self.s.runtime,self.s._account()['id'])
                return (cover if method.endswith('cover') else transform)(box,params)
            if method=='capture.windows':
                from .native_capture import windows
                return windows()
            if method=='capture.web_finish':
                from .workspace_assets import WorkspaceAssets
                file=Path(params['file_path']);assert_within(file,self.s.runtime/'captures'/'web')
                box=WorkspaceAssets(store,self.s.runtime,self.s._account()['id']);row=box.import_image(file);row.pop('content_hash',None)
                row['capture']={'capture_mode':'web','url':params.get('url'),'selector':params.get('selector'),'captured_at':now_iso(),'ordering_semantics':'rendered_page_pixels'}
                box.save_resource(row);return box.resource(row['resource_id'])
            if method=='capture.native':
                from .native_capture import capture
                from .workspace_assets import WorkspaceAssets
                path,metadata=capture(params,self.s.runtime)
                box=WorkspaceAssets(store,self.s.runtime,self.s._account()['id']);row=box.import_image(path)
                row.pop('content_hash',None);row['capture']=metadata;box.save_resource(row)
                return box.resource(row['resource_id'])
        finally:store.close()

    def status(self,store):
        from . import __version__
        interpreter=os.environ.get('ICE_TEACHING_PYTHON') or ('' if getattr(sys,'frozen',False) else sys.executable)
        checks=[]
        def check(name,ok,detail):checks.append({'name':name,'ok':bool(ok),'detail':detail})
        check('SQLite完整性',store.conn.execute('PRAGMA quick_check').fetchone()[0]=='ok','数据库快速检查')
        check('教学Python',interpreter and Path(interpreter).is_file(),'打包附带运行器' if getattr(sys,'frozen',False) else '本地解释器')
        check('Java工具链',shutil.which('javac') and shutil.which('java'),'Java文章需安装JDK；其他栏目不受影响')
        check('可用磁盘',shutil.disk_usage(self.s.runtime).free>500*1024**2,'建议至少500MB剩余空间')
        check('隔离执行',shutil.which('docker'),'可选Docker；未安装时只能审阅后本机执行')
        return {'app_version':__version__,'os':sys.platform,'schema_version':store.conn.execute('PRAGMA user_version').fetchone()[0],
                'checked_at':now_iso(),'checks':checks,'tapnow_mode':'manual','models':[{'provider':k,'configured':bool(os.environ.get(p['api_key_env'])),'verified':p.get('status')=='verified'} for k,p in self.s.settings['profiles'].items()]}

    def reminders(self,store,method,params):
        aid=self.s._account()['id'];store.conn.execute('CREATE TABLE IF NOT EXISTS local_reminders(reminder_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,title TEXT NOT NULL,due_at TEXT NOT NULL,dismissed INTEGER NOT NULL DEFAULT 0)')
        if method=='reminders.save':
            title=params.get('title','').strip();due=params.get('due_at','')
            parsed=datetime.fromisoformat(due)
            if not 1<=len(title)<=150 or parsed.tzinfo is None:raise ValueError('提醒需有效标题和带时区的时间')
            store.conn.execute('INSERT INTO local_reminders VALUES(?,?,?,?,0)',(new_id('reminder'),aid,title,parsed.isoformat()));store.conn.commit()
        elif method=='reminders.dismiss':
            store.conn.execute('UPDATE local_reminders SET dismissed=1 WHERE reminder_id=? AND account_id=?',(params['reminder_id'],aid));store.conn.commit()
        current=datetime.now(timezone.utc)
        return [{**dict(row),'due':datetime.fromisoformat(row['due_at'])<=current} for row in store.conn.execute('SELECT * FROM local_reminders WHERE account_id=? AND dismissed=0 ORDER BY due_at',(aid,))]

    def git(self,method,params):
        # Repository comes only from the configured publication output directory.
        root=Path(self.s._account()['article_root']).resolve();exe=shutil.which('git')
        if not exe:raise ValueError('未找到Git，请安装后重试')
        def run(args):
            env={k:os.environ[k] for k in ('PATH','SYSTEMROOT','TEMP','TMP','APPDATA','HOME','USERPROFILE','SSH_AUTH_SOCK') if k in os.environ}
            result=subprocess.run([exe,'-c','core.hooksPath=NUL','-c','core.quotepath=false','-C',str(root),*args],capture_output=True,timeout=60,env={**env,'GIT_TERMINAL_PROMPT':'0'},creationflags=0x08000000 if os.name=='nt' else 0)
            if result.returncode:raise ValueError('Git操作失败，请在本机Git客户端检查权限/冲突；程序没有改变TLS校验')
            return result.stdout.decode('utf-8','replace')
        top=Path(run(['rev-parse','--show-toplevel']).strip()).resolve()
        if top!=root:raise ValueError('输出目录必须本身是Git仓库根目录，避免提交上级目录其他文件')
        status_raw=run(['status','--porcelain=v1','-z','--untracked-files=all']);status=status_raw.replace('\x00','\n');diff=run(['diff','--no-ext-diff','--no-textconv','HEAD','--'])
        files=[]
        for line in filter(None,status_raw.split('\x00')):
            name=line[3:]
            if 'R' in line[:2] or 'C' in line[:2] or any(char in name for char in '\r\n\t'):raise ValueError('存在重命名或特殊路径，请使用Git客户端归档')
            file=root/name;assert_within(file,root)
            files.append({'path':name,'sha256':sha256_text(file.read_bytes().hex()) if file.is_file() else 'deleted'})
            if line[:2]=='??' and file.is_file():
                raw=file.read_bytes()
                try:content=raw.decode('utf-8');content=content[:200000]
                except UnicodeDecodeError:content=f'[二进制文件：{len(raw)} bytes，详见文件哈希]'
                diff+='\n+++ 新文件 '+name+'\n'+content
        preview={'status':status,'diff':diff[:200000],'files':files,'branch':run(['branch','--show-current']).strip(),'head':run(['rev-parse','HEAD']).strip()}
        preview['content_hash']=sha256_json(preview)
        if method=='git.preview':return preview
        if params.get('content_hash')!=preview['content_hash']:raise ValueError('仓库内容已变化，请重新查看差异')
        if len(diff)>200000:raise ValueError('差异超过完整预览长度，请使用Git客户端审阅提交')
        action=params.get('action')
        if action=='commit':
            message=params.get('message','').strip()
            if not 1<=len(message)<=200 or not files:raise ValueError('需有效提交说明和待归档文件')
            run(['add','--',*[row['path'] for row in files]]);run(['commit','-m',message])
        elif action=='push':
            if files:raise ValueError('请先提交当前变更并重新预览')
            run(['push'])
        else:raise ValueError('仅支持明确的commit或push操作')
        return {'ok':True,'action':action}

    def catalog(self,params):
        from .llm.transport import validate_endpoint,_NoRedirect
        p=self.s.settings['profiles'].get(params.get('provider'))
        if not p:raise ValueError('模型供应商不存在')
        endpoint=validate_endpoint(p['base_url']);key=os.environ.get(p['api_key_env'])
        if not key:raise ValueError('请先配置该供应商Key')
        request=urllib.request.Request(endpoint+'/models',headers={'Authorization':'Bearer '+key})
        try:
            with urllib.request.build_opener(_NoRedirect).open(request,timeout=25) as response:
                raw=response.read(2_000_001)
            if len(raw)>2_000_000:raise ValueError('模型目录过大')
            rows=json.loads(raw).get('data',[])
            ids=sorted({str(row['id']) for row in rows if isinstance(row,dict) and isinstance(row.get('id'),str) and len(row['id'])<=200})
        except Exception as exc:
            raise ValueError('该服务未提供可用模型目录或连接失败；请在模型设置手动填写官方模型ID') from None
        return {'models':ids,'retrieved_at':now_iso(),'capabilities_verified':False}

    def semantic_review(self,params):
        self.s.articles_revisions(params)
        engine,cfg,store=self.s._job_app(params['job_id'])
        try:
            job=store.get_job(params['job_id']);state=engine._load_state(params['job_id']);body=state.get('integrated_md','');digest=sha256_text(body)
            if digest!=params.get('content_hash') or job['lease']:raise ValueError('正文已变化或任务正在执行，请刷新')
            from .llm.router import LLMRequest
            if state['spec'].get('demo'):
                # No synthetic model quality verdict for offline demos.
                return {'content_hash':digest,'review':'离线演示不模拟AI语义审稿，请检查结构与运行证据或配置真实模型。','demo':True}
            engine.router.restore(job['model_route_snapshot'])
            response=engine.router.generate(LLMRequest(role='reviewer',node='manual_semantic_review',prompt='审阅这篇修改后的文章，指出内容与标题不一致、读者理解断层、无依据断言、代码解释错误和品牌规范问题。不要改写正文，不要宣称事实已经核实。参考规则：'+json.dumps(cfg.profile,ensure_ascii=False)+'\n待审正文：\n'+body),job_id=job['job_id'])
            fresh=engine._load_state(job['job_id'])
            if sha256_text(fresh.get('integrated_md',''))!=digest:raise ValueError('生成审稿期间正文已变化，本次结果未采用')
            fresh['semantic_review']={'content_hash':digest,'review':response.text,'model_id':response.model_id,'at':now_iso()};engine._save_state(job['job_id'],fresh)
            return fresh['semantic_review']
        finally:store.close()

    def redo(self,params):
        engine,_,store=self.s._job_app(params['job_id'])
        try:
            job=store.get_job(params['job_id']);state=engine._load_state(job['job_id'])
            if state['spec'].get('account_id','ice-loop')!=self.s._account()['id'] or job['lease']:raise ValueError('任务不可修改')
            slot=next((r for r in store.article_slots(job['article_id']) if r['figure_no']==params.get('figure_no')),None)
            if not slot:raise ValueError('图位不存在')
            prompt=params.get('prompt','').strip()
            if not 1<=len(prompt)<=15000 or params.get('content_hash')!=sha256_json(slot):raise ValueError('提示词为空或图位已变化，请刷新')
            count=slot.get('redo_count',0)
            if count>=5:raise ValueError('当前图位已重做5次，请先审阅已有候选')
            slot.update(prompt=prompt,selected_candidate=None,redo_count=count+1)
            store.conn.execute('UPDATE asset_slots SET slot_json=? WHERE slot_id=?',(json.dumps(slot,ensure_ascii=False),slot['slot_id']));store.conn.commit()
            store.append_event(job['job_id'],'asset.redo_requested',{'figure_no':slot['figure_no'],'count':count+1,'prompt_hash':sha256_text(prompt)})
            store.update_article(job['article_id'],readiness='review_pending')
            return {'ok':True,'prompt':prompt,'count':count+1,'mode':'manual_tapnow_or_capture'}
        finally:store.close()
