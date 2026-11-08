"""v3.22 同步到公众号草稿箱：用假的微信接口验证预检、资源上传与缓存、新建/更新、后台改动冲突、结果未知与 IP 白名单提示。"""
from __future__ import annotations

import base64
import io
import json
import unittest
import urllib.parse

from PIL import Image

from ice_agent.desktop_service import DesktopService
from ice_agent.documents.schema import DocumentError
from ice_agent.wechat import client as wx_client
from ice_agent.wechat.client import WeChatError
from ice_agent.wechat.sync import prepare_image, remote_fingerprint
from tests import REPO, temp_dir

APPID = 'wx1234567890abcdef'


class Drafts(dict):
    """media_id → 文章列表；drafts[media_id] 取头条（单篇草稿的旧写法照常可用）。"""
    def __getitem__(self, key):
        return dict.__getitem__(self, key)[0]


class FakeWeChat:
    def __init__(self):
        self.calls, self.drafts, self.fail = [], Drafts(), {}
        self.counter = 0
        self.updates = []

    def __call__(self, method, url, *, body=None, headers=None, timeout=None):
        path = urllib.parse.urlparse(url).path
        self.calls.append(path)
        if path in self.fail:
            failure = self.fail.pop(path)
            if failure == 'network':
                raise WeChatError('network', '连接微信接口失败：timed out', outcome=wx_client.UNKNOWN_OUTCOME)
            return failure
        if path == '/cgi-bin/stable_token':
            return {'access_token': 'TOKEN', 'expires_in': 7200}
        if path == '/cgi-bin/media/uploadimg':
            assert b'name="media"' in body
            self.counter += 1
            return {'url': f'http://mmbiz.qpic.cn/img{self.counter}'}
        if path == '/cgi-bin/material/add_material':
            return {'media_id': 'THUMB1', 'url': 'http://mmbiz.qpic.cn/cover'}
        data = json.loads(body)
        if path == '/cgi-bin/draft/add':
            self.counter += 1
            media_id = f'DRAFT{self.counter}'
            dict.__setitem__(self.drafts, media_id, [{**a, 'content': '<section data-wx="1">' + a['content'] + '</section>'}
                                                     for a in data['articles']])
            return {'media_id': media_id}
        if path == '/cgi-bin/draft/update':
            if data['media_id'] not in self.drafts:
                return {'errcode': 40007, 'errmsg': 'invalid media_id'}
            items = dict.__getitem__(self.drafts, data['media_id'])
            if data['index'] >= len(items):
                return {'errcode': 40007, 'errmsg': 'invalid index'}
            self.updates.append((data['media_id'], data['index']))
            items[data['index']] = {**data['articles'], 'content': '<p class="x">' + data['articles']['content'] + '</p>'}
            return {'errcode': 0}
        if path == '/cgi-bin/draft/get':
            if data['media_id'] not in self.drafts:
                return {'errcode': 40007, 'errmsg': 'invalid media_id'}
            return {'news_item': list(dict.__getitem__(self.drafts, data['media_id']))}
        raise AssertionError(path)


def png(color=(20, 120, 220), size=(64, 40)):
    buffer = io.BytesIO()
    Image.new('RGB', size, color).save(buffer, 'PNG')
    return 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()


class Base(unittest.TestCase):
    def setUp(self):
        wx_client._TOKENS.clear()
        self.root = temp_dir('v3-wechat-')
        self.service = DesktopService(REPO, self.root / 'runtime', self.root / 'articles')
        self.account = self.service.call('bootstrap')['account']
        self.fake = FakeWeChat()
        self.service.wechat_transport = self.fake

    def tearDown(self):
        self.service.workers.shutdown(wait=True)
        self.service.close()

    def call(self, method, **params):
        return self.service.call(method, {'account_id': self.account['id'], **params})

    def sync(self, document_id, **params):
        revision = self.call('documents.get', document_id=document_id)['revision']
        return self.call('wechat.draft_sync', document_id=document_id, base_revision=revision, **params)

    def configure(self):
        self.call('wechat.configure', appid=APPID)
        self.service.call('secrets.set', {'keys': {'wechat-' + self.account['id']: 'SECRET'}})

    def article(self, text='第一段正文。', images=1):
        image = self.call('documents.image_import_data', data_url=png(), name='图')
        created = self.call('documents.create', kind='blank', title='同步测试')
        blocks = [{'type': 'paragraph', 'attrs': {'id': 'b0000000001'}, 'content': [{'type': 'text', 'text': text}]}]
        blocks += [{'type': 'articleImage', 'attrs': {'id': f'b00000000i{i}', 'resourceId': image['resource_id'], 'caption': '', 'width': 100}}
                   for i in range(images)]
        self.call('documents.save_working', document_id=created['document_id'], base_revision=created['revision'],
                  content={'schema': 1, 'style': {}, 'doc': {'type': 'doc', 'content': blocks}})
        return created['document_id']

    def edit(self, document_id, text):
        detail = self.call('documents.get', document_id=document_id)
        content = detail['content']
        content['doc']['content'][0]['content'][0]['text'] = text
        self.call('documents.save_working', document_id=document_id, base_revision=detail['revision'], content=content)


class TestWeChatDrafts(Base):
    def test_status_and_configuration(self):
        status = self.call('wechat.status')
        self.assertEqual((status['configured'], status['secret_set']), (False, False))
        with self.assertRaises(DocumentError):
            self.call('wechat.configure', appid='not-an-appid')
        self.configure()
        status = self.call('wechat.status')
        self.assertEqual((status['appid'], status['secret_set']), (APPID, True))
        self.assertTrue(self.call('wechat.test')['ok'])

    def test_ip_whitelist_message(self):
        self.configure()
        self.fake.fail['/cgi-bin/stable_token'] = {'errcode': 40164, 'errmsg': 'invalid ip 203.0.113.7 ipv6 ::ffff, not in whitelist'}
        result = self.call('wechat.test')
        self.assertFalse(result['ok'])
        self.assertIn('203.0.113.7', result['message'])
        self.assertIn('IP 白名单', result['message'])

    def test_requires_configuration(self):
        document_id = self.article()
        with self.assertRaisesRegex(DocumentError, 'AppID'):
            self.sync(document_id)

    def test_create_then_update_reuses_assets(self):
        self.configure()
        document_id = self.article(images=2)
        first = self.sync(document_id)
        self.assertEqual((first['action'], first['media_id']), ('created', 'DRAFT2'))
        self.assertEqual(first['uploaded'], 2)  # 两个位置是同一张图：正文上传一次 + 封面一次
        self.assertEqual(first['reused'], 1)
        draft = self.fake.drafts['DRAFT2']
        self.assertEqual(draft['title'], '同步测试')
        self.assertEqual(draft['thumb_media_id'], 'THUMB1')
        self.assertIn('https://mmbiz.qpic.cn/img1', draft['content'])
        self.assertNotIn('data:image', draft['content'])
        detail = self.call('documents.get', document_id=document_id)
        self.assertEqual([d['kind'] for d in detail['deliveries']], ['wechat_draft'])
        self.edit(document_id, '第一段改过了。')
        uploads = self.fake.calls.count('/cgi-bin/media/uploadimg')
        second = self.sync(document_id)
        self.assertEqual((second['action'], second['media_id'], second['uploaded']), ('updated', 'DRAFT2', 0))
        self.assertEqual(self.fake.calls.count('/cgi-bin/media/uploadimg'), uploads)
        self.assertIn('第一段改过了', self.fake.drafts['DRAFT2']['content'])
        self.assertEqual(self.call('wechat.status', document_id=document_id)['draft']['media_id'], 'DRAFT2')

    def test_remote_edit_is_a_conflict(self):
        self.configure()
        document_id = self.article()
        media_id = self.sync(document_id)['media_id']
        self.fake.drafts[media_id]['content'] += '<p>作者在后台加了一段</p>'
        self.edit(document_id, '本地也改了。')
        result = self.sync(document_id)
        self.assertTrue(result['conflict'])
        self.assertNotIn('本地也改了', self.fake.drafts[media_id]['content'])  # 没有覆盖
        fresh = self.sync(document_id, mode='new')
        self.assertNotEqual(fresh['media_id'], media_id)
        self.assertIn('作者在后台加了一段', self.fake.drafts[media_id]['content'])
        self.fake.drafts[fresh['media_id']]['content'] += '<p>又改</p>'
        forced = self.sync(document_id, mode='overwrite')
        self.assertEqual(forced['action'], 'updated')

    def test_deleted_remote_draft_is_recreated(self):
        self.configure()
        document_id = self.article()
        media_id = self.sync(document_id)['media_id']
        del self.fake.drafts[media_id]
        result = self.sync(document_id)
        self.assertEqual(result['action'], 'recreated')
        self.assertTrue(any('已删除' in w for w in result['warnings']))

    def test_unknown_outcome_asks_before_retry(self):
        self.configure()
        document_id = self.article()
        self.fake.fail['/cgi-bin/draft/add'] = 'network'
        with self.assertRaisesRegex(DocumentError, '结果未知'):
            self.sync(document_id)
        adds = self.fake.calls.count('/cgi-bin/draft/add')
        check = self.sync(document_id)
        self.assertTrue(check['needs_check'])
        self.assertEqual(self.fake.calls.count('/cgi-bin/draft/add'), adds)  # 没有盲目再建
        self.assertIsNotNone(self.call('wechat.status', document_id=document_id)['unknown_operation'])
        done = self.sync(document_id, checked_unknown=True)
        self.assertEqual(done['action'], 'created')
        self.assertIsNone(self.call('wechat.status', document_id=document_id)['unknown_operation'])

    def test_preflight(self):
        self.configure()
        created = self.call('documents.create', kind='blank', title='没有图')
        self.call('documents.save_working', document_id=created['document_id'], base_revision=created['revision'],
                  content={'schema': 1, 'style': {}, 'doc': {'type': 'doc', 'content': [
                      {'type': 'paragraph', 'attrs': {'id': 'b0000000001'}, 'content': [{'type': 'text', 'text': '正文'}]}]}})
        with self.assertRaisesRegex(DocumentError, '封面'):
            self.sync(created['document_id'])
        self.assertNotIn('/cgi-bin/draft/add', self.fake.calls)

    def test_secret_isolated_per_account(self):
        self.configure()
        self.assertEqual(self.service.wechat_secrets, {self.account['id']: 'SECRET'})
        self.service.call('secrets.set', {'keys': {'wechat-' + self.account['id']: ''}})
        self.assertFalse(self.call('wechat.status')['secret_set'])


class TestArticleOptions(Base):
    """v3.23 留言设置与封面裁切随文章设置冻结，同步时写入草稿。"""

    def test_comments_and_cover_crop(self):
        self.configure()
        document_id = self.article()
        detail = self.call('documents.get', document_id=document_id)
        resource = next(b for b in detail['content']['doc']['content'] if b['type'] == 'articleImage')['attrs']['resourceId']
        content = detail['content']
        content['info'] = {'comments': 'fans', 'coverCrop': {'for': resource, '235': [0, 0.1, 1, 0.5255], '11': [0.2, 0, 0.8, 1]}}
        self.call('documents.save_working', document_id=document_id, base_revision=detail['revision'], content=content)
        media_id = self.sync(document_id)['media_id']
        draft = self.fake.drafts[media_id]
        self.assertEqual((draft['need_open_comment'], draft['only_fans_can_comment']), (1, 1))
        self.assertEqual((draft['pic_crop_235_1'], draft['pic_crop_1_1']), ('0_0.1_1_0.5255', '0.2_0_0.8_1'))
        # 换了封面：旧裁切不再套用
        other = self.call('documents.image_import_data', data_url=png((200, 10, 10), (90, 90)), name='另一张')
        detail = self.call('documents.get', document_id=document_id)
        content = detail['content']
        content['info'] = {**content['info'], 'coverResourceId': other['resource_id'], 'comments': 'all'}
        self.call('documents.save_working', document_id=document_id, base_revision=detail['revision'], content=content)
        self.sync(document_id, mode='overwrite')
        draft = self.fake.drafts[media_id]
        self.assertNotIn('pic_crop_235_1', draft)
        self.assertEqual((draft['need_open_comment'], draft['only_fans_can_comment']), (1, 0))

    def test_info_validation(self):
        from ice_agent.documents.schema import normalize_info
        self.assertEqual(normalize_info({'comments': 'off'}), {})
        for bad in ({'comments': 'yes'}, {'coverCrop': {'235': [0, 0, 1, 1]}}, {'coverCrop': {'for': 'resource-a', '235': [0.5, 0, 0.4, 1]}},
                    {'coverCrop': {'for': 'resource-a', '43': [0, 0, 1, 1]}}, {'coverCrop': {'for': 'resource-a', '11': [0, 0, 1]}}):
            with self.assertRaises(DocumentError):
                normalize_info(bad)


class TestGroupDrafts(Base):
    """v3.24 多图文：几篇文章按顺序合成一篇草稿；每篇用最近的稳定版本。"""

    def stable(self, text):
        document_id = self.article(text=text)
        revision = self.call('documents.get', document_id=document_id)['revision']
        self.call('documents.commit_version', document_id=document_id, base_revision=revision)
        return document_id

    def commit(self, document_id, text):
        self.edit(document_id, text)
        revision = self.call('documents.get', document_id=document_id)['revision']
        return self.call('documents.commit_version', document_id=document_id, base_revision=revision)['version_id']

    def test_preview_checks_each_article(self):
        self.configure()
        a, b = self.stable('头条正文'), self.stable('次条正文')
        blank = self.call('documents.create', kind='blank', title='没有正文')['document_id']
        preview = self.call('wechat.group_preview', document_ids=[a, b, blank])
        self.assertFalse(preview['ready'])
        self.assertEqual([bool(i['problem']) for i in preview['items']], [False, False, True])
        self.assertIsNone(preview['group'])
        for bad in ([a], [a, a], [a] * 9):
            with self.assertRaises(DocumentError):
                self.call('wechat.group_preview', document_ids=bad)
        self.edit(a, '还没保存成版本的修改')
        preview = self.call('wechat.group_preview', document_ids=[a, b])
        self.assertTrue(preview['ready'])
        self.assertTrue(preview['items'][0]['unversioned'])

    def test_create_update_changed_positions_and_order(self):
        self.configure()
        a, b, c = self.stable('第一篇'), self.stable('第二篇'), self.stable('第三篇')
        self.edit(b, '工作副本里的新内容')  # 没保存成版本：不会被带上
        first = self.call('wechat.group_sync', document_ids=[a, b, c])
        self.assertEqual((first['action'], first['count']), ('created', 3))
        items = dict.__getitem__(self.fake.drafts, first['media_id'])
        self.assertEqual(len(items), 3)
        self.assertIn('第二篇', items[1]['content'])
        self.assertNotIn('工作副本里的新内容', items[1]['content'])
        self.assertTrue(any('稳定版本' in w for w in first['warnings']))
        uploads = self.fake.calls.count('/cgi-bin/media/uploadimg')
        self.assertEqual(uploads, 1)  # 三篇用同一张图：只上传一次
        preview = self.call('wechat.group_preview', document_ids=[a, b, c])
        self.assertTrue(preview['group']['current'])
        # 只改第三篇：只更新第三个位置
        self.commit(c, '第三篇改过了')
        self.assertFalse(self.call('wechat.group_preview', document_ids=[a, b, c])['group']['current'])
        second = self.call('wechat.group_sync', document_ids=[a, b, c])
        self.assertEqual((second['action'], second['media_id']), ('updated', first['media_id']))
        self.assertEqual(self.fake.updates, [(first['media_id'], 2)])
        self.assertIn('第三篇改过了', dict.__getitem__(self.fake.drafts, first['media_id'])[2]['content'])
        # 换了顺序：是另一篇多图文
        third = self.call('wechat.group_sync', document_ids=[c, a, b])
        self.assertEqual(third['action'], 'created')
        self.assertNotEqual(third['media_id'], first['media_id'])

    def test_status_lists_groups_of_document(self):
        self.configure()
        a, b = self.stable('甲'), self.stable('乙')
        self.assertEqual(self.call('wechat.status', document_id=b)['groups'], [])
        media_id = self.call('wechat.group_sync', document_ids=[a, b])['media_id']
        self.call('wechat.group_sync', document_ids=[b, a])
        groups = self.call('wechat.status', document_id=b)['groups']
        self.assertEqual(sorted(g['position'] for g in groups), [1, 2])
        mine = next(g for g in groups if g['media_id'] == media_id)
        self.assertEqual((mine['position'], mine['document_ids'], mine['current']), (2, [a, b], True))
        self.assertEqual([m['title'] for m in mine['members']], ['同步测试', '同步测试'])
        self.commit(b, '乙改了')
        self.assertFalse(any(g['current'] for g in self.call('wechat.status', document_id=b)['groups']))
        self.assertTrue(all(g['current'] for g in self.call('wechat.status', document_id=a)['groups']))
        self.call('documents.trash', document_id=a)
        mine = next(g for g in self.call('wechat.status', document_id=b)['groups'] if g['media_id'] == media_id)
        self.assertEqual([m['available'] for m in mine['members']], [False, True])

    def test_remote_edit_conflict_and_overwrite(self):
        self.configure()
        a, b = self.stable('甲'), self.stable('乙')
        media_id = self.call('wechat.group_sync', document_ids=[a, b])['media_id']
        dict.__getitem__(self.fake.drafts, media_id)[1]['content'] += '<p>后台加的</p>'
        result = self.call('wechat.group_sync', document_ids=[a, b])
        self.assertTrue(result['conflict'])
        self.call('wechat.group_sync', document_ids=[a, b], mode='overwrite')
        self.assertEqual(sorted(i for _, i in self.fake.updates), [0, 1])  # 覆盖时每篇都写
        self.assertNotIn('后台加的', dict.__getitem__(self.fake.drafts, media_id)[1]['content'])
        # 后台删掉一篇：篇目数变了，只能另建
        dict.__getitem__(self.fake.drafts, media_id).pop()
        self.assertTrue(self.call('wechat.group_sync', document_ids=[a, b])['conflict'])
        fresh = self.call('wechat.group_sync', document_ids=[a, b], mode='overwrite')
        self.assertEqual(fresh['action'], 'recreated')
        self.assertNotEqual(fresh['media_id'], media_id)

    def test_version_changed_after_preview_and_unknown_outcome(self):
        self.configure()
        a, b = self.stable('甲'), self.stable('乙')
        versions = [i['version_id'] for i in self.call('wechat.group_preview', document_ids=[a, b])['items']]
        self.commit(b, '乙改了')
        with self.assertRaisesRegex(DocumentError, '重新检查'):
            self.call('wechat.group_sync', document_ids=[a, b], version_ids=versions)
        self.fake.fail['/cgi-bin/draft/add'] = 'network'
        with self.assertRaisesRegex(DocumentError, '结果未知'):
            self.call('wechat.group_sync', document_ids=[a, b])
        self.assertTrue(self.call('wechat.group_sync', document_ids=[a, b])['needs_check'])
        self.assertIsNotNone(self.call('wechat.group_preview', document_ids=[a, b])['unknown_operation'])
        done = self.call('wechat.group_sync', document_ids=[a, b], checked_unknown=True)
        self.assertEqual(done['action'], 'created')

    def test_partial_update_failure_keeps_done_positions(self):
        self.configure()
        a, b = self.stable('甲'), self.stable('乙')
        media_id = self.call('wechat.group_sync', document_ids=[a, b])['media_id']
        self.commit(a, '甲改了')
        self.commit(b, '乙改了')
        real = self.fake.__call__
        seen = []

        def flaky(method, url, **kw):
            if url.split('?')[0].endswith('/cgi-bin/draft/update'):
                seen.append(1)
                if len(seen) == 2:
                    return {'errcode': 45009, 'errmsg': 'reach max api daily quota limit'}
            return real(method, url, **kw)
        self.service.wechat_transport = flaky
        with self.assertRaisesRegex(DocumentError, '第2篇没有更新成功'):
            self.call('wechat.group_sync', document_ids=[a, b])
        self.service.wechat_transport = self.fake
        self.fake.updates.clear()
        again = self.call('wechat.group_sync', document_ids=[a, b])  # 第一篇已更新且后台指纹已记下：不算冲突，只补第二篇
        self.assertEqual(again['action'], 'updated')
        self.assertEqual(self.fake.updates, [(media_id, 1)])


class TestHelpers(unittest.TestCase):
    def test_fingerprint_ignores_markup(self):
        self.assertEqual(remote_fingerprint('<p style="a">你好 世界</p>'), remote_fingerprint('<section><span>你好</span>\n世界</section>'))
        self.assertNotEqual(remote_fingerprint('<p>你好</p>'), remote_fingerprint('<p>你好吗</p>'))

    def test_prepare_image_converts_and_compresses(self):
        root = temp_dir('v3-wechat-img-')
        webp = root / 'a.webp'
        Image.new('RGB', (200, 100), (1, 2, 3)).save(webp, 'WEBP')
        name, data, mime, note = prepare_image(str(webp), 'image/webp', webp.stat().st_size, cover=False)
        self.assertEqual((mime, name), ('image/jpeg', 'image.jpg'))
        self.assertIn('JPEG', note)
        import os
        big = root / 'big.png'
        Image.frombytes('RGB', (1600, 1200), os.urandom(1600 * 1200 * 3)).save(big, 'PNG')
        self.assertGreater(big.stat().st_size, 1024 * 1024)
        _, data, mime, _ = prepare_image(str(big), 'image/png', big.stat().st_size, cover=False)
        self.assertLess(len(data), 1024 * 1024)
        small = root / 'ok.png'
        Image.new('RGB', (10, 10)).save(small, 'PNG')
        self.assertEqual(prepare_image(str(small), 'image/png', small.stat().st_size, cover=False)[3], '')


if __name__ == '__main__':
    unittest.main()
