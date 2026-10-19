import unittest
from datetime import datetime,timedelta

from ice_agent.desktop_service import DesktopService
from ice_agent.rules.facts import evidenced_claims,claim_verified,check_facts
from ice_agent.rules.markdown_ast import parse_markdown
from tests import REPO,temp_dir
from tests.test_workflow import demo_spec


class TestDeliveryClaimEvidence(unittest.TestCase):
    def setUp(self):
        root=temp_dir('delivery-evidence-')
        self.s=DesktopService(REPO,root/'runtime',root/'articles',auto_consumer=False)
        self.engine,_,self.store=self.s._app(demo=True)
        self.job,self.article=self.engine.create_job({**demo_spec(),'demo':True,'account_id':'ice-loop'})
        state=self.engine._load_state(self.job);state.update(integrated_md='# 算式核对\n\n本例算式数量。',runs={})
        self.engine._save_state(self.job,state)
        self.store.add_claim({'claim_id':'fixture-arithmetic','article_id':self.article,'text':'本例共有45个算式','risk_type':'stable','status':'qualified'})

    def tearDown(self):
        self.store.close();self.s.close()

    def verify(self):
        self.s.call('claims.verify',{'job_id':self.job,'claim_id':'fixture-arithmetic',
            'url':'https://docs.python.org/3/library/functions.html#sum','evidence':'本地算式夹具实际求和结果为45，对照Python求和定义核对。'})

    def test_manual_verification_loads_evidence_in_actual_delivery_rules(self):
        self.verify()
        claim=evidenced_claims(self.store,self.article)[0]
        self.assertTrue(claim_verified(claim))
        self.assertTrue(check_facts(parse_markdown('本例算式数量。'),[claim]).passed)
        snapshot=self.s.call('articles.delivery_snapshot',{'job_id':self.job})
        self.assertFalse(snapshot['claims'])
        self.assertFalse(any(item['kind']=='claims' for item in snapshot['blocking']))
        self.assertFalse(any(item['rule']=='fact.unresolved_claim' for item in snapshot['rules']['blocking']))

    def test_missing_or_foreign_sources_never_become_verified_evidence(self):
        self.verify()
        claim=self.store.article_claims(self.article)[0]
        source_id=claim['source_ids'][0]
        for source in (None,'other-article'):
            self.store.conn.execute('UPDATE sources SET article_id=? WHERE source_id=?',(source,source_id));self.store.conn.commit()
            self.assertFalse(claim_verified(evidenced_claims(self.store,self.article)[0]))
        self.store.conn.execute('DELETE FROM sources WHERE source_id=?',(source_id,));self.store.conn.commit()
        self.assertFalse(claim_verified(evidenced_claims(self.store,self.article)[0]))
        self.assertTrue(self.s.call('articles.delivery_snapshot',{'job_id':self.job})['claims'])

    def test_stale_day_sensitive_claim_is_visible_in_delivery_blockers(self):
        self.verify()
        stale=(datetime.now().astimezone()-timedelta(days=2)).isoformat()
        self.store.conn.execute("UPDATE claims SET risk_type='version',publish_day_check_required=1,verified_at=? WHERE claim_id='fixture-arithmetic'",(stale,));self.store.conn.commit()
        self.assertFalse(claim_verified(evidenced_claims(self.store,self.article)[0]))
        snapshot=self.s.call('articles.delivery_snapshot',{'job_id':self.job})
        self.assertEqual(snapshot['claims'][0]['claim_id'],'fixture-arithmetic')

    def test_identical_verification_in_another_article_does_not_reassign_the_source(self):
        self.verify()
        original=self.store.article_claims(self.article)[0]['source_ids']
        other_job,other_article=self.engine.create_job({**demo_spec(),'demo':True,'account_id':'ice-loop'})
        self.store.add_claim({'claim_id':'fixture-other-arithmetic','article_id':other_article,'text':'本例共有45个算式','risk_type':'stable','status':'qualified'})
        self.s.call('claims.verify',{'job_id':other_job,'claim_id':'fixture-other-arithmetic',
            'url':'https://docs.python.org/3/library/functions.html#sum','evidence':'本地算式夹具实际求和结果为45，对照Python求和定义核对。'})
        self.assertNotEqual(self.store.article_claims(other_article)[0]['source_ids'],original)
        self.assertTrue(claim_verified(evidenced_claims(self.store,self.article)[0]))
        self.assertTrue(claim_verified(evidenced_claims(self.store,other_article)[0]))
