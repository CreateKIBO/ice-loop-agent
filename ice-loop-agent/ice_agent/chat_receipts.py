"""Durable acceptance receipts. Replaying a request never starts a second model turn."""
import json
import re
from .domain.types import sha256_json

class SendConflict(ValueError):
    code='IDEMPOTENCY_CONFLICT'

class ChatBudgetExceeded(ValueError):
    code='BUDGET_EXCEEDED'

def identity(params):
    request_id=params.get('request_id')
    if request_id is None:
        return None
    if not isinstance(request_id,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',request_id):
        raise ValueError('发送请求标识需为1至100个英文、数字、下划线或短横线')
    payload={key:value for key,value in params.items() if key not in ('account_id','conversation_id','request_id')}
    try:
        encoded=json.dumps(payload,ensure_ascii=False,sort_keys=True,allow_nan=False)
    except (TypeError,ValueError) as error:
        raise ValueError('发送参数不是有效的JSON数据') from error
    if len(encoded.encode('utf-8'))>1024*1024:
        raise ValueError('发送参数过大，请减少附加资料')
    return {'request_id':request_id,'input_hash':sha256_json(payload)}

def replay(store,account_id,conversation_id,request):
    if request is None:
        return None
    row=store.conn.execute('SELECT input_hash,state,message_id,user_message_id FROM creative_send_receipts WHERE account_id=? AND conversation_id=? AND request_id=?',
        (account_id,conversation_id,request['request_id'])).fetchone()
    if not row:
        return None
    if row['input_hash']!=request['input_hash']:
        raise SendConflict('[IDEMPOTENCY_CONFLICT] 发送请求标识与之前的内容冲突，请使用新的发送请求')
    if row['state']=='cancelled':
        return {'accepted':False,'cancelled':True,'request_id':request['request_id']}
    message=store.conn.execute("SELECT status FROM creative_messages WHERE id=? AND conversation_id=? AND role='assistant'",(row['message_id'],conversation_id)).fetchone()
    user=store.conn.execute("SELECT 1 FROM creative_messages WHERE id=? AND conversation_id=? AND role='user'",(row['user_message_id'],conversation_id)).fetchone()
    if not message or not user:
        raise ValueError('原发送回执对应的消息不完整，未重新生成；请检查工作区资料')
    return {'message_id':row['message_id'],'user_message_id':row['user_message_id'],'started':False,
            'accepted':True,'replayed':True,'status':message['status']}

def record(store,account_id,conversation_id,request,message_id,user_message_id,created_at):
    if request is not None:
        store.conn.execute("INSERT INTO creative_send_receipts VALUES (?,?,?,?,'accepted',?,?,?)",
            (account_id,conversation_id,request['request_id'],request['input_hash'],message_id,user_message_id,created_at))


def cancel(store,account_id,conversation_id,request,created_at):
    store.conn.execute("INSERT INTO creative_send_receipts VALUES (?,?,?,?,'cancelled',NULL,NULL,?)",
        (account_id,conversation_id,request['request_id'],request['input_hash'],created_at))
    return {'accepted':False,'cancelled':True,'request_id':request['request_id']}
