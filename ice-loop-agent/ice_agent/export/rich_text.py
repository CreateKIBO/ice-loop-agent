"""Inline style clipboard HTML, without scripts or remote fetches."""
import re
from .html_preview import article_html

def rich_text(markdown,title,figures,colors=None):
    html=article_html(markdown,title,'draft',figures,colors).split('<main>',1)[1].split('<footer>',1)[0]
    styles={'p':'font-size:17px;line-height:1.8;margin:20px 0;color:#15191F;',
        'h1':'font-size:28px;line-height:1.4;margin:24px 0;',
        'h2':'font-size:23px;line-height:1.5;margin:32px 0 18px;border-left:3px solid #2448DB;padding-left:12px;',
        'h3':'font-size:20px;line-height:1.5;margin:24px 0 16px;',
        'pre':'font-size:14px;line-height:1.7;white-space:pre-wrap;background:#F3F2ED;padding:16px;',
        'code':'font-family:Consolas,monospace;white-space:pre-wrap;',
        'blockquote':'border-left:2px solid #2448DB;padding-left:16px;margin:20px 0;',
        'figure':'margin:24px 0;','img':'max-width:100%;height:auto;','figcaption':'font-size:13px;color:#666;text-align:center;'}
    for tag,style in styles.items():html=re.sub(r'<'+tag+r'(?=[ >])',lambda m:'<'+tag+' style="'+style+'"',html)
    return '<section style="font-family:Microsoft YaHei,sans-serif;font-size:17px;line-height:1.8;">'+html+'</section>'
