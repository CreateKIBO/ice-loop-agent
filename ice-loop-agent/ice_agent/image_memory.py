"""Bound full-size pixel buffers across callers, without holding SQL/network locks.

Only pure image/file work belongs in this gate. Database writes and model IO
must happen outside it, since an image review can validate while holding SQL.
"""
import base64
import io
import threading
from functools import wraps

IMAGE_DECODE_GATE = threading.RLock()


def serialized_image_decode(function):
    @wraps(function)
    def bounded(*args, **kwargs):
        with IMAGE_DECODE_GATE:
            return function(*args, **kwargs)
    return bounded


@serialized_image_decode
def thumbnail_data_url(path):
    from PIL import Image, ImageOps
    with Image.open(path) as source:
        # Resize before copying/expanding full-size pixels. JPEG thumbnail() can also
        # use decoder draft scaling while the source remains lazily opened.
        orientation = source.getexif().get(274, 1)
        source.thumbnail((700, 1000) if orientation in (5, 6, 7, 8) else (1000, 700))
        with ImageOps.exif_transpose(source) as oriented:
            with oriented.convert('RGBA') as image:
                output = io.BytesIO()
                image.save(output,format='PNG')
    return 'data:image/png;base64,'+base64.b64encode(output.getvalue()).decode('ascii')
