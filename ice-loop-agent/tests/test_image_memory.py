"""Actual concurrent image previews; no cached response or fake decoder success."""
import base64
import io
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from PIL import Image

from ice_agent.desktop_service import DesktopService
from ice_agent.domain.store import Store
from ice_agent.workspace_assets import WorkspaceAssets
from ice_agent.providers.tapnow import validate_image_file
from tests import REPO, temp_dir


class TestImageDecodeMemory(unittest.TestCase):
    def setUp(self):
        root = temp_dir('image-memory-')
        self.service = DesktopService(REPO,root/'runtime',root/'articles',auto_consumer=False)
        self.addCleanup(self.service.close)
        _,_,store = self.service._app()
        self.addCleanup(store.close)
        file = root/'large.png'
        with Image.new('RGB',(2600,1800),'#2448db') as source:
            source.save(file)
        self.resource = WorkspaceAssets(store,self.service.runtime,'ice-loop').import_image(file)
        self.db = self.service.runtime/'app.db'

    def test_concurrent_real_previews_do_not_overlap_heavy_decoders(self):
        lock = threading.Lock(); active = {}; peak = 0
        original = Image.Image.convert
        def convert(image,*args,**kwargs):
            nonlocal peak
            identity = threading.get_ident()
            with lock:
                active[identity] = active.get(identity,0)+1
                peak = max(peak,len(active))
            try:
                time.sleep(.08)  # expose overlap while retaining real pixel buffers
                return original(image,*args,**kwargs)
            finally:
                with lock:
                    active[identity] -= 1
                    if not active[identity]: del active[identity]
        barrier = threading.Barrier(6)
        def preview(_):
            store = Store(self.db)
            try:
                barrier.wait(timeout=15)
                return WorkspaceAssets(store,self.service.runtime,'ice-loop').preview(self.resource['resource_id'])
            finally: store.close()
        with patch.object(Image.Image,'convert',convert), ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(preview,range(6)))
        self.assertEqual(peak,1,'parallel previews retain multiple full-size pixel buffers')
        self.assertEqual(active,{})
        for result in results:
            with Image.open(io.BytesIO(base64.b64decode(result['data_url'].split(',',1)[1]))) as image:
                self.assertLessEqual(image.width,1000)
                self.assertLessEqual(image.height,700)

    def test_failed_decode_releases_capacity_for_the_next_real_preview(self):
        store = Store(self.db)
        self.addCleanup(store.close)
        box = WorkspaceAssets(store,self.service.runtime,'ice-loop')
        with patch.object(Image.Image,'convert',side_effect=OSError('fixture decoding failure')):
            with self.assertRaises(OSError): box.preview(self.resource['resource_id'])
        result = box.preview(self.resource['resource_id'])
        self.assertTrue(result['data_url'].startswith('data:image/png;base64,'))

    def test_review_validation_with_a_sql_writer_does_not_deadlock_a_preview_decoder(self):
        ready,begin,converting,release = (threading.Event() for _ in range(4))
        errors = []
        original = Image.Image.convert
        def convert(image,*args,**kwargs):
            if threading.current_thread().name == 'owned-image-preview':
                converting.set()
                if not release.wait(6): raise RuntimeError('fixture decoder not released')
            return original(image,*args,**kwargs)
        def preview():
            store = None
            try:
                store = Store(self.db);ready.set()
                if not begin.wait(6):raise RuntimeError('fixture preview not started')
                WorkspaceAssets(store,self.service.runtime,'ice-loop').preview(self.resource['resource_id'])
            except Exception as error: errors.append(error)
            finally:
                if store is not None:store.close()
        writer = Store(self.db);self.addCleanup(writer.close)
        timer = None
        with patch.object(Image.Image,'convert',convert):
            thread = threading.Thread(target=preview,name='owned-image-preview',daemon=True);thread.start()
            try:
                self.assertTrue(ready.wait(6))
                with writer.transaction():
                    writer.conn.execute('UPDATE publication_resources SET updated_at=updated_at')
                    begin.set();self.assertTrue(converting.wait(6))
                    timer = threading.Timer(.05,release.set);timer.start()
                    # Asset review performs this validation inside a SQL writer.
                    # The other decoder must not need that writer to finish.
                    self.assertTrue(validate_image_file(Path(self.resource['file_path']))[0])
            finally:
                begin.set();release.set();thread.join(10)
                if timer is not None:timer.join(2)
        self.assertFalse(thread.is_alive());self.assertEqual(errors,[])


class TestThumbnailGeometry(unittest.TestCase):
    def test_all_exif_orientations_preserve_geometry_colors_and_original(self):
        from PIL import ImageDraw,ImageOps
        from ice_agent.image_memory import thumbnail_data_url
        import hashlib
        root=temp_dir('thumbnail-orientation-')
        for orientation in range(1,9):
            with self.subTest(orientation=orientation):
                file=root/f'{orientation}.png'
                with Image.new('RGB',(1600,800),'#2448DB') as source:
                    ImageDraw.Draw(source).rectangle((0,0,799,799),fill='#FF0000')
                    exif=Image.Exif();exif[274]=orientation;source.save(file,exif=exif)
                digest=hashlib.sha256(file.read_bytes()).hexdigest()
                with Image.open(file) as source,ImageOps.exif_transpose(source).convert('RGBA') as expected:
                    expected.thumbnail((1000,700))
                    with Image.open(io.BytesIO(base64.b64decode(thumbnail_data_url(file).split(',',1)[1]))) as actual:
                        self.assertEqual(actual.size,expected.size)
                        for point in [(20,20),(actual.width-21,20),(20,actual.height-21)]:
                            self.assertEqual(actual.getpixel(point),expected.getpixel(point))
                self.assertEqual(hashlib.sha256(file.read_bytes()).hexdigest(),digest)
    def test_rgb_expansion_is_bounded_and_alpha_survives(self):
        from ice_agent.image_memory import thumbnail_data_url
        root=temp_dir('thumbnail-buffers-');file=root/'rgb.png'
        with Image.new('RGB',(3000,2000),'#2448DB') as source:source.save(file)
        sizes=[];original=Image.Image.convert
        def convert(image,*args,**kwargs):sizes.append(image.width*image.height);return original(image,*args,**kwargs)
        with patch.object(Image.Image,'convert',convert):thumbnail_data_url(file)
        self.assertTrue(sizes);self.assertLessEqual(max(sizes),1000*700,'RGB original must not expand to full-size RGBA')
        with Image.new('RGBA',(2000,1000),(12,34,56,0)) as source:
            source.paste((200,30,40,128),(500,250,1500,750));source.save(file)
        with Image.open(io.BytesIO(base64.b64decode(thumbnail_data_url(file).split(',',1)[1]))) as actual:
            self.assertEqual(actual.mode,'RGBA');self.assertEqual(actual.getpixel((0,0))[3],0);self.assertEqual(actual.getpixel((500,250))[3],128)
