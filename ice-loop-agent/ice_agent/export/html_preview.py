"""Offline, script-free article preview. Raw HTML and remote images stay inert."""
import html
import re

PREVIEW_NAME = '04-阅读与排版预览.html'


def inline(text):
    escaped = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>',
                     re.sub(r'`([^`]+)`', r'<code>\1</code>', html.escape(text)))
    return re.sub(r'\[([^\]]+)\]\((https?://[^\s)]+)\)',
                  r'<a href="\2" rel="noreferrer noopener">\1</a>', escaped)


def article_html(markdown, title, readiness, figures, colors=None):
    parts, paragraph, code = [], [], None
    def flush():
        if paragraph:
            parts.append('<p>' + inline(' '.join(paragraph)) + '</p>')
            paragraph.clear()
    for line in markdown.splitlines():
        if line.lstrip().startswith('```'):
            flush()
            if code is None:
                code = []
            else:
                parts.append('<pre><code>' + html.escape('\n'.join(code)) + '</code></pre>')
                code = None
            continue
        if code is not None:
            code.append(line)
            continue
        if re.match(r'^\s*<!--.*-->\s*$', line):
            continue
        heading = re.match(r'^(#{1,4})\s+(.+)', line)
        image = re.match(r'^!\[([^\]]*)\]\(([^)]*)\)\s*$', line)
        if heading:
            flush()
            level = len(heading[1])
            parts.append(f'<h{level}>{inline(heading[2])}</h{level}>')
        elif image:
            flush()
            number=re.match(r'图(\d+)[:：]',image[1])
            source = image[2] if image[2] in figures.values() else figures.get(int(number[1]),'') if number else ''
            if re.fullmatch(r'images/figure-\d+\.(png|jpg|jpeg|webp)', source):
                parts.append(f'<figure><img src="{source}" alt="{html.escape(image[1], quote=True)}"><figcaption>{html.escape(image[1])}</figcaption></figure>')
            else:
                parts.append('<aside class="missing">待配图 · ' + html.escape(image[1]) + '</aside>')
        elif line.startswith('>'):
            flush()
            parts.append('<blockquote>' + inline(line[1:].lstrip()) + '</blockquote>')
        elif re.match(r'^[-*]\s', line):
            flush()
            parts.append('<p>• ' + inline(line[2:]) + '</p>')
        elif not line.strip():
            flush()
        else:
            paragraph.append(line)
    if code is not None:
        parts.append('<pre><code>' + html.escape('\n'.join(code)) + '</code></pre>')
    flush()
    status = '发布检查已通过 · 发布前请在公众号后台预览' if readiness == 'ready_for_publish' else '草稿预览 · 仍有审核或配图待办，请先复检'
    document = '''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>''' + html.escape(title) + '''</title><style>
*{box-sizing:border-box}body{margin:0;background:#F3F2ED;color:#15191F;font:17px/1.8 system-ui,"Microsoft YaHei",sans-serif}
main{max-width:740px;margin:36px auto;padding:40px;background:#fff}h1{font-size:30px;line-height:1.4}h2{font-size:23px;margin-top:40px;border-left:3px solid #2448DB;padding-left:14px}h3{font-size:20px}
p{margin:20px 0;overflow-wrap:anywhere}pre{background:#F3F2ED;padding:18px;overflow:auto;font:14px/1.7 Consolas,monospace}code{font-family:Consolas,monospace;white-space:pre-wrap}figure{margin:30px 0}img{max-width:100%;height:auto}figcaption{font-size:13px;color:#666;text-align:center}blockquote{border-left:2px solid #2448DB;margin:20px 0;padding-left:16px}
.status,.missing{font-size:14px;padding:16px;background:#F3F2ED;border:1px solid #ddd}.status{max-width:740px;margin:24px auto}footer{font-size:13px;color:#666;margin-top:40px}@media(max-width:600px){main{margin:0;padding:24px}.status{margin:16px}h1{font-size:26px}}@media print{body{background:white}.status{display:none}main{margin:0;max-width:none}}
</style></head><body><aside class="status">''' + status + '</aside><main>' + '\n'.join(parts) + '''<footer>本地阅读与排版预览。图片随文章包保存；正式排版和手机预览请在公众号后台完成。</footer></main></body></html>'''
    valid_colors = [color for color in colors or [] if isinstance(color,str) and re.fullmatch(r'#[0-9a-fA-F]{6}',color)]
    if valid_colors:
        # Substitute stylesheet constants only; never alter article or code text.
        style = document.split('<style>',1)[1].split('</style>',1)[0]
        style = style.replace('#2448DB',valid_colors[0])
        if len(valid_colors)>=3:
            style=style.replace('#15191F',valid_colors[1]).replace('#F3F2ED',valid_colors[2])
        document=document.split('<style>',1)[0]+'<style>'+style+'</style>'+document.split('</style>',1)[1]
    return document
