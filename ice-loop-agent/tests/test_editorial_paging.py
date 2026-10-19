"""SQL pages, exact lookup and unchanged history/title-review semantics."""
import json
import unittest
from unittest.mock import patch

from ice_agent.desktop_service import DesktopService
from ice_agent.domain.store import Store
from ice_agent.domain.types import sha256_json
from ice_agent.editorial_topics import EditorialTopics
from ice_agent.publication_history import PublicationHistory
from tests import REPO,temp_dir


class TestEditorialPaging(unittest.TestCase):
    def setUp(self):
        self.root=temp_dir('editorial-pages-')
        self.service=DesktopService(REPO,self.root/'runtime',self.root/'articles',auto_consumer=False)
        self.addCleanup(self.service.close)
        self.account=self.service._account()
        self.service.accounts_save({'account':{**self.account,'library_root':''}})
        self.account=self.service._account()
        self.store=Store(self.service.runtime/'app.db');self.addCleanup(self.store.close)
        self.topics=EditorialTopics(self.store,self.account)
        self.history=PublicationHistory(self.store,self.account)

    def topic(self,issue,series='PY',account='ice-loop',title=None):
        self.store.conn.execute('INSERT INTO editorial_topics VALUES (?,?,?,?,?,?,?,?,?,?)',
            (f'topic-{account}-{series}-{issue}',account,series,issue,title or f'Topic {issue:03}',
             '完整内容要点','读者收益','预告','测试来源','2026-10-18'))
        self.store.conn.commit()

    def record(self,issue,series='PY',account='ice-loop',body=None,title=None,status='draft'):
        identifier=f'history-{account}-{series}-{issue}'
        self.store.conn.execute('INSERT INTO publication_history VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            (identifier,account,identifier,series,issue,title or f'History {issue:03}',body or f'# 完整正文{issue}\n正文尾部{issue}',
             status,'2026-10-01' if status=='published' else '',1,'2026-10-18'))
        self.store.conn.commit()
        return identifier

    def test_topic_pages_cover_every_issue_once_and_keep_legacy_response(self):
        for issue in range(1,28):self.topic(issue)
        self.topic(1,'JV');self.topic(1,account='foreign')
        all_rows=self.service.call('outlines.list')['rows']
        paged=[]
        for page in range(3):
            data=self.service.call('outlines.list',{'series':'PY','page_size':10,'page':page})
            self.assertEqual(data['total'],27);self.assertEqual(data['pages'],3)
            self.assertLessEqual(len(data['rows']),10);paged.extend(data['rows'])
        self.assertEqual(paged,[r for r in all_rows if r['series']=='PY'])
        self.assertEqual([r['episode'] for r in paged],list(range(1,28)))

    def test_topic_search_is_literal_account_scoped_and_empty_pages_are_clamped(self):
        self.topic(100,title="100%_ '观察")
        self.topic(101,title='Topic Uppercase')
        self.topic(102,'JV',title="100%_ '观察")
        for query,expected in (("%_ '",[100]),('UPPERCASE',[101]),('100',[100])):
            with self.subTest(query=query):
                result=self.topics.page({'page_size':10,'series':'PY','query':query})
                self.assertEqual([r['episode'] for r in result['rows']],expected)
        self.assertEqual(self.topics.page({'page_size':10,'query':'absent','page':99})['page'],0)
        self.assertEqual(self.topics.page({'page_size':1,'series':'PY','page':100})['page'],1)

    def test_exact_lookup_and_match_do_not_load_all_topics(self):
        for issue in (11,12,100,101):self.topic(issue)
        self.topic(100,'JV')
        expected=self.topics.list()
        with patch.object(EditorialTopics,'list',side_effect=AssertionError('full topic list forbidden')):
            row=self.topics.get('topic-ice-loop-PY-100')
            found=self.service.call('outlines.match',{'series':'PY','episode':100,'include_available':False})
            self.assertEqual(found['topic'],row);self.assertEqual(found['next_title'],'Topic 101');self.assertEqual(found['available'],[])
            self.assertEqual(row,next(r for r in expected if r['topic_id']==row['topic_id']))
            self.assertEqual(self.topics.page({'page_size':2,'series':'PY'})['total'],4)
        self.assertEqual(len(self.topics.match('PY',100)['available']),4)

    def test_streamed_base_hash_matches_original_canonical_contract(self):
        for issue in (11,100):self.topic(issue,title=f'中文标题 {issue}')
        self.topic(1,'JV')
        expected=sha256_json({'columns':self.account['columns'],'rows':self.topics.list()})
        with patch.object(EditorialTopics,'list',side_effect=AssertionError('all notes should not be retained')):
            self.assertEqual(self.topics.base_hash(),expected)
            text='## PY\n### 第012期：新增题目'
            preview=self.topics.preview({'text':text})
            result=self.topics.save({'text':text,'rows':preview['rows'],'source_name':preview['source_name'],
                'base_hash':preview['base_hash'],'preview_hash':preview['preview_hash'],'return_rows':False})
            self.assertEqual(result,{'saved':1,'rows':[]})
        self.assertEqual(len(self.topics.list()),4)

    def test_topic_updates_reject_colliding_or_foreign_identity(self):
        self.topic(11);self.topic(12);self.topic(11,account='foreign')
        row=self.topics.get('topic-ice-loop-PY-11')
        with patch.object(EditorialTopics,'list',side_effect=AssertionError('full scan forbidden')):
            with self.assertRaisesRegex(ValueError,'期号已有选题'):self.topics.update({**row,'episode':12})
            with self.assertRaisesRegex(ValueError,'不属于'):self.topics.get('topic-foreign-PY-11')

    def test_history_pages_keep_hashes_and_can_save_existing_publication_record(self):
        for issue in range(1,24):self.record(issue)
        self.record(100,'JV');self.record(100,account='foreign')
        legacy=self.service.call('history.list')
        rows=[]
        for page in range(3):
            result=self.service.call('history.list',{'series':'PY','page_size':10,'page':page,'refresh':False})
            self.assertEqual(result['total'],23);self.assertLessEqual(len(result['rows']),10)
            rows.extend(result['rows'])
        self.assertEqual(rows,[r for r in legacy if r['series']=='PY'])
        self.assertTrue(all(r['body'] is None for r in rows))
        self.service.call('history.update',{**rows[0],'status':'published','published_at':'2026-10-01'})
        full=self.service.call('history.get',{'history_id':rows[0]['history_id']})
        self.assertIn('正文尾部23',full['body']);self.assertEqual(full['status'],'published')

    def test_history_filters_cover_status_unclassified_and_literal_query(self):
        self.record(11,status='published',title="Published %_'")
        self.record(12,title='PY草稿');self.record(1,series='',title='未分类')
        self.record(11,'JV',title="Published %_'")
        result=self.history.page({'page_size':10,'series':'PY','status':'published','query':"%_'"})
        self.assertEqual(result['total'],1);self.assertEqual(result['rows'][0]['episode'],11)
        result=self.history.page({'page_size':10,'series':'PY','include_unclassified':True})
        self.assertEqual(result['total'],3);self.assertIn('',[r['series'] for r in result['rows']])

    def test_page_and_option_validation_never_falls_back_to_a_full_response(self):
        for method in ('outlines.list','history.list'):
            for invalid in ({'page_size':0},{'page_size':True},{'page_size':101},{'page_size':10,'page':-1},
                            {'page_size':10,'page':1.1},{'page_size':10,'series':'foreign'},
                            {'page_size':10,'query':'\x00'},{'page_size':10,'query':'a'*201}):
                with self.subTest(method=method,params=invalid),self.assertRaises(ValueError):self.service.call(method,invalid)
        with self.assertRaises(ValueError):self.history.page({'page_size':10,'status':'invalid'})
        with self.assertRaises(ValueError):self.topics.match('PY',1,include_available='false')
        with self.assertRaises(ValueError):self.history.context('PY',include_titles='false')

    def test_model_history_is_complete_and_ui_summary_omits_only_title_payload(self):
        for issue in range(1,71):self.record(issue,body='# 标题\n'+'前文'*1000+f'完整正文尾部{issue}',status='published')
        self.record(99,'JV',body='其他栏目不能混入')
        full=self.history.context('PY',11)
        self.assertEqual([r['episode'] for r in full['history']],[10,9,8,7,6])
        self.assertIn('完整正文尾部10',full['history'][0]['body_excerpt'])
        self.assertEqual(len(full['known_titles']),70)
        lightweight=self.service.call('planning.context',{'series':'PY','episode':11,'include_titles':False})
        self.assertEqual(lightweight['history'],full['history']);self.assertEqual(lightweight['known_titles'],[])
        self.assertEqual(lightweight['title_history_count'],70);self.assertEqual(lightweight['context_hash'],full['context_hash'])
        # A body outside the five selected issues must still invalidate the
        # history confirmation fingerprint, even if its title is unchanged.
        self.store.conn.execute("UPDATE publication_history SET body='changed outside the selected five' WHERE history_id=?",('history-ice-loop-PY-70',));self.store.conn.commit()
        self.assertNotEqual(self.history.context('PY',11)['context_hash'],full['context_hash'])

    def test_single_history_read_never_calls_the_full_record_loader(self):
        identifier=self.record(100)
        with patch.object(PublicationHistory,'records',side_effect=AssertionError('full record loader forbidden')):
            result=self.service.call('history.get',{'history_id':identifier})
            self.assertIn('正文尾部100',result['body'])
            chat=self.service.call('chat.create',{'target':{'type':'history','id':identifier}})
            self.assertIn('正文尾部100',chat['current']['body'])
        with self.assertRaisesRegex(ValueError,'没有这篇'):self.history.get('foreign-history')

    def test_library_refresh_is_streamed_and_does_not_rewrite_source_files(self):
        library=self.root/'library';file=library/'PY'/'011-测试'/'01-公众号正文.md';file.parent.mkdir(parents=True)
        body='# 第十一期\n\n完整正文尾部。\n';file.write_text(body,encoding='utf-8')
        account={**self.account,'library_root':str(library)}
        with patch('ice_agent.article_library.library_entries',side_effect=AssertionError('full body list forbidden')):
            records=PublicationHistory(self.store,account).records()
            self.assertEqual(len(records),1);self.assertEqual(records[0]['episode'],11)
        self.assertEqual(file.read_text(encoding='utf-8'),body)
