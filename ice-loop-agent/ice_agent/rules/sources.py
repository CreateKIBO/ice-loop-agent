"""Typed rules with immutable provenance and explicit conflict decisions.

Document text is reference data. Only validated rule keys alter executable checks.
"""
import copy
import json
from pathlib import Path

from ..domain.types import new_id, now_iso, sha256_json, sha256_text

PRIORITY={'task':100,'agents':90,'brand':80,'schedule':70,'template':60,'article_craft':50,'khazix':40,'history':10}
KEYS={'title_max_chars','words_range','code_blocks','code_block_max_lines','required_ending_heading','banned_brand_words'}

def validate_rules(rules):
    if not isinstance(rules,dict) or set(rules)-KEYS:
        raise ValueError('规则仅支持：'+', '.join(sorted(KEYS)))
    for key,value in rules.items():
        if key in ('title_max_chars','code_block_max_lines'):
            if type(value) is not int or not 1<=value<=200: raise ValueError(key+'应为1–200的整数')
        elif key in ('words_range','code_blocks'):
            maximum=10000 if key=='words_range' else 30
            if not isinstance(value,list) or len(value)!=2 or any(type(n) is not int for n in value) or not 0<=value[0]<=value[1]<=maximum: raise ValueError(key+'区间无效')
        elif key=='required_ending_heading':
            if not isinstance(value,str) or not 1<=len(value)<=50: raise ValueError('结尾标题需1–50字')
        elif not isinstance(value,list) or len(value)>100 or any(not isinstance(n,str) or not 1<=len(n)<=60 for n in value):
            raise ValueError('禁用词需最多100项，每项1–60字')
    return rules

class RuleSources:
    def __init__(self,store,account_id):
        self.store,self.aid=store,account_id
        store.conn.executescript('''CREATE TABLE IF NOT EXISTS rule_sources(source_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,data_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rule_decisions(account_id TEXT NOT NULL,rule_key TEXT NOT NULL,context_hash TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(account_id,rule_key));''')

    def rows(self):
        return [json.loads(r[0]) for r in self.store.conn.execute('SELECT data_json FROM rule_sources WHERE account_id=? ORDER BY rowid',(self.aid,))]

    def save(self,params):
        kind=params.get('kind','brand'); text=params.get('text','');name=params.get('name','').strip()
        if kind not in PRIORITY or not name or len(name)>150 or not isinstance(text,str) or len(text)>200000: raise ValueError('请填写有效来源名称、类型和文档')
        rules=validate_rules(params.get('rules',{}));sid=new_id('rule')
        row={'source_id':sid,'name':name,'kind':kind,'priority':PRIORITY[kind],'text':text,'rules':rules,
             'sha256':sha256_text(text),'imported_at':now_iso(),'version':1,'modified_at':params.get('modified_at')}
        row['source_path']=str(params.get('source_path',''))[:1000]
        file_hash=params.get('file_sha256')
        if file_hash is not None and (not isinstance(file_hash,str) or len(file_hash)!=64 or any(c not in '0123456789abcdef' for c in file_hash)):raise ValueError('来源文件哈希无效')
        row['file_sha256']=file_hash
        self.store.conn.execute('INSERT INTO rule_sources VALUES(?,?,?)',(sid,self.aid,json.dumps(row,ensure_ascii=False)));self.store.conn.commit()
        return self.list()

    def list(self):
        rows=self.rows();effective={};conflicts=[];provenance={}
        for key in KEYS:
            candidates=[r for r in rows if key in r['rules']]
            if not candidates: continue
            top=max(r['priority'] for r in candidates);winners=[r for r in candidates if r['priority']==top]
            fingerprint=sha256_json([{'id':r['source_id'],'hash':r['sha256'],'rules':r['rules']} for r in winners])
            chosen=winners[-1]
            if len({sha256_json(r['rules'][key]) for r in winners})>1:
                decision=self.store.conn.execute('SELECT source_id FROM rule_decisions WHERE account_id=? AND rule_key=? AND context_hash=?',(self.aid,key,fingerprint)).fetchone()
                chosen=next((r for r in winners if decision and r['source_id']==decision[0]),None)
                if chosen is None:
                    conflicts.append({'key':key,'context_hash':fingerprint,'candidates':[{'source_id':r['source_id'],'name':r['name'],'value':r['rules'][key]} for r in winners]});continue
            effective[key]=chosen['rules'][key];provenance[key]={'source_id':chosen['source_id'],'name':chosen['name'],'sha256':chosen['sha256']}
        return {'sources':[{k:v for k,v in r.items() if k!='text'} for r in rows],'effective':effective,'conflicts':conflicts,'provenance':provenance,'context_hash':sha256_json(rows)}

    def resolve(self,params):
        conflict=next((r for r in self.list()['conflicts'] if r['key']==params.get('key')),None)
        if not conflict or conflict['context_hash']!=params.get('context_hash') or params.get('source_id') not in [r['source_id'] for r in conflict['candidates']]: raise ValueError('冲突已变化，请刷新后重新裁定')
        self.store.conn.execute('INSERT OR REPLACE INTO rule_decisions VALUES(?,?,?,?)',(self.aid,conflict['key'],conflict['context_hash'],params['source_id']));self.store.conn.commit();return self.list()

    def remove(self,params):
        state=self.list()
        if params.get('context_hash')!=state['context_hash']:raise ValueError('来源已变化，请刷新')
        self.store.conn.execute('DELETE FROM rule_sources WHERE account_id=? AND source_id=?',(self.aid,params['source_id']));self.store.conn.commit();return self.list()

    def apply(self,profile):
        result=copy.deepcopy(profile);state=self.list()
        for key,value in state['effective'].items():
            if key=='banned_brand_words':result[key]=value
            else:result['article'][key]=value
        result['rule_sources_snapshot']=state
        result['rule_source_documents']=[{'name':row['name'],'priority':row['priority'],'text':row['text'],'sha256':row['sha256']} for row in sorted(self.rows(),key=lambda row:row['priority'],reverse=True)]
        return result
