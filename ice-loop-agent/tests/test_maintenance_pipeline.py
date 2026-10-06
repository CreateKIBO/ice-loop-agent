"""Backup/restore a completed article with real local execution and image assets."""
import unittest
from pathlib import Path

from PIL import Image

from ice_agent.desktop_service import DesktopService
from ice_agent.export.html_preview import PREVIEW_NAME
from tests import REPO, temp_dir
from tests.test_workflow import demo_spec


class TestMaintenancePipeline(unittest.TestCase):
    def test_full_article_backup_restores_assets_evidence_and_export(self):
        root=temp_dir('maintenance-pipeline-')
        service=DesktopService(REPO,root/'runtime',root/'articles')
        engine,_,store=service._app(demo=True)
        try:
            job,article=engine.create_job({**demo_spec(),'demo':True,'account_id':'ice-loop','article_root':str(root/'articles')})
            for _ in range(5):
                result=engine.run(job)
                if result['state']=='completed':break
                approval=store.pending_approval(job)
                self.assertIsNotNone(approval,result)
                engine.decide(job,approval['approval_id'],'approve',expect_hash=approval['content_hash'])
            self.assertEqual(store.get_job(job)['state'],'completed')
            file=root/'image.png';Image.new('RGB',(1200,600),'#2448DB').save(file)
            for slot in store.article_slots(article):
                engine.import_asset(job,slot['figure_no'],file)
            engine.refinalize(job)
            original=service.call('jobs.get',{'job_id':job})
            self.assertEqual(len(original['runs']),3)
            self.assertTrue(all(slot['valid'] for slot in original['slots']))
            package=service.call('backup.create',{'file_path':str(root/'backup.zip')})
            restore=service.call('backup.restore',{'file_path':package['file_path'],'destination':str(root/'restored'),'package_hash':package['package_hash']})
            restored_service=DesktopService(REPO,Path(restore['runtime_root']))
            try:
                restored=restored_service.call('jobs.get',{'job_id':job})
                self.assertEqual(restored['body'],original['body'])
                # 恢复会把运行记录里的绝对路径重映射到新 runtime 根（backup.relocate），
                # 因此除路径前缀外必须逐字段一致。
                from ice_agent.backup import relocate
                expected_runs=relocate(original['runs'],[(root/'runtime',Path(restore['runtime_root']))])
                self.assertEqual(restored['runs'],expected_runs)
                self.assertTrue(all(slot['valid'] for slot in restored['slots']))
                self.assertTrue(Path(restored['export']['folder']).is_relative_to(root/'restored'))
                self.assertTrue((Path(restored['export']['folder'])/PREVIEW_NAME).is_file())
                output=restored_service.call('articles.finalize',{'job_id':job})
                self.assertEqual(output['readiness'],original['article']['readiness'])
            finally:restored_service.close()
        finally:store.close();service.close()


if __name__=='__main__':unittest.main()
