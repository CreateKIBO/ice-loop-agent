"""Non-destructive crop/redaction and deterministic Chinese cover text layers."""
import hashlib
import re
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps
from .domain.types import new_id,now_iso
from .paths import ensure_dir

def rectangle(raw,size):
    if not isinstance(raw,list) or len(raw)!=4 or any(type(n) is not int for n in raw):raise ValueError('区域格式：[左,上,右,下]整数像素')
    x,y,r,b=raw
    if not 0<=x<r<=size[0] or not 0<=y<b<=size[1]:raise ValueError('区域必须在原图范围内')
    return tuple(raw)

def load(box,params):
    row=box.resource(params.get('resource_id'))
    if row['content_hash']!=params.get('content_hash'):raise ValueError('资源已变化，请刷新')
    path=Path(row['file_path'])
    if hashlib.sha256(path.read_bytes()).hexdigest()!=row['sha256']:raise ValueError('原图哈希不匹配')
    with Image.open(path) as source:image=ImageOps.exif_transpose(source).convert('RGB')
    return row,image

def save(box,image,parent,operation):
    directory=ensure_dir(box.runtime/'image-variants');file=directory/(new_id('image')+'.png');image.save(file)
    result=box.import_image(file);result.pop('content_hash',None)
    result['derivation']={'parent_resource_id':parent['resource_id'],'parent_sha256':parent['sha256'],'created_at':now_iso(),**operation}
    box.save_resource(result);return box.resource(result['resource_id'])

def transform(box,params):
    row,image=load(box,params);reason=params.get('reason','').strip()
    if not 1<=len(reason)<=300:raise ValueError('请记录裁切或遮挡原因')
    redactions=params.get('redactions',[])
    if not isinstance(redactions,list) or len(redactions)>20:raise ValueError('最多20个遮挡区')
    # Redact first in original coordinates, then crop. Original pixels stay immutable.
    draw=ImageDraw.Draw(image)
    for raw in redactions:
        x,y,r,b=rectangle(raw,image.size);draw.rectangle((x,y,r-1,b-1),fill='#15191F')
    crop=params.get('crop')
    if crop:image=image.crop(rectangle(crop,image.size))
    if not crop and not redactions:raise ValueError('至少指定裁切区域或遮挡区域')
    return save(box,image,row,{'kind':'crop_redaction','crop':crop,'redactions':redactions,'reason':reason})

def color(value):
    if not isinstance(value,str) or not re.fullmatch(r'#[a-fA-F0-9]{6}',value):raise ValueError('请使用HEX颜色')
    return value

def cover(box,params):
    row,image=load(box,params);title=params.get('title','').strip();period=params.get('period','').strip()
    if not 1<=len(title)<=80 or not 1<=len(period)<=50:raise ValueError('标题需1–80字，期号需1–50字')
    rect=rectangle(params.get('text_rect'),image.size);bg=color(params.get('background','#F3F2ED'));ink=color(params.get('color','#15191F'))
    # Only this explicitly selected text layer region is painted. Logos elsewhere remain pixel-identical.
    x,y,r,b=rect;ImageDraw.Draw(image).rectangle((x,y,r-1,b-1),fill=bg)
    font_path=Path(os.environ.get('WINDIR','C:/Windows'))/'Fonts'/'msyh.ttc'
    if not font_path.is_file():raise ValueError('未找到微软雅黑字体，无法保证中文文字准确，请在Windows安装字体')
    layer=Image.new('RGB',(r-x,b-y),bg);draw=ImageDraw.Draw(layer);pad=max(4,min(30,(r-x)//20));chosen=None
    for size in range(min(120,(b-y)//2),11,-1):
        font=ImageFont.truetype(str(font_path),size);small=ImageFont.truetype(str(font_path),max(12,size//3));lines=[];line=''
        for char in title:
            if draw.textlength(line+char,font=font)>layer.width-2*pad and line:lines.append(line);line=''
            line+=char
        if line:lines.append(line)
        height=len(lines)*(size+10)+max(12,size//3)+20
        if height<=layer.height-2*pad and draw.textlength(period,font=small)<=layer.width-2*pad:
            chosen=(font,small,lines,size);break
    if not chosen:raise ValueError('文字区域过小，请放大区域或缩短标题')
    font,small,lines,size=chosen;pos=pad
    draw.text((pad,pos),period,font=small,fill=ink,anchor='lt');pos+=max(12,size//3)+20
    for line in lines:draw.text((pad,pos),line,font=font,fill=ink,anchor='lt');pos+=size+10
    image.paste(layer,(x,y))
    return save(box,image,row,{'kind':'cover_text_layer','title':title,'period':period,'text_rect':list(rect),'background':bg,'color':ink,'font':'Microsoft YaHei','baked_text_outside_rect_preserved':True})
