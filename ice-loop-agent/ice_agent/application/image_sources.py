"""Private desktop capability source; renderer never receives a filesystem path."""
from pathlib import Path
import hashlib
from . import Handler,register
from ..providers.tapnow import validate_image_file
from ..workspace_assets import WorkspaceAssets

@register
class ImageSources(Handler):
    METHODS=frozenset({'images.original_source'})
    def handle(self, method, params):
        service=self.service;account=service._account()['id']
        if params.get('account_id')!=account:
            raise ValueError('公众号已切换，请重新打开图片')
        kind=params.get('kind')
        if kind=='candidate':
            _,_,store=service._job_app(params['job_id'])
            try:
                job=store.get_job(params['job_id']);candidate=store.get_candidate(params['candidate_id'])
                if not candidate or candidate['slot_id'] not in {s['slot_id'] for s in store.article_slots(job['article_id'])}:
                    raise ValueError('图片不属于当前文章')
                return self._source(candidate['file_path'],candidate['sha256'],account)
            finally:store.close()
        if kind=='resource':
            _,_,store=service._app()
            try:
                row=WorkspaceAssets(store,service.runtime,account).resource(params['resource_id'])
                return self._source(row['file_path'],row['sha256'],account)
            finally:store.close()
        raise ValueError('原图来源类型无效')

    @staticmethod
    def _source(file,sha,account):
        path=Path(file);ok,mime,size=validate_image_file(path)
        if not ok:
            raise ValueError('图片已改变或损坏，请重新导入')
        with path.open('rb') as stream:
            digest=hashlib.file_digest(stream,'sha256').hexdigest()
        if digest!=sha:
            raise ValueError('图片已改变或损坏，请重新导入')
        from PIL import Image
        with Image.open(path) as image:width,height=image.size
        return {'file_path':str(path.resolve()),'sha256':sha,'mime':mime,'size':size,
                'width':width,'height':height,'account_id':account}
