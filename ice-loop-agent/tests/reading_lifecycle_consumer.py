"""Harness-only controls; real queue, worker and demo engine in an owned fixture.

No drain calls, synthetic job states, approval decisions or external model calls.
The observer delegates unchanged to the production worker on its actual thread.
"""
import copy
import threading
import time

from ice_agent.domain.store import Store
from ice_agent.tasks import TaskQueue
from ice_agent.tasks import worker


class ConsumerProbe:
    def __init__(self, repo, runtime):
        root = runtime.parent
        assert root.parent == repo / '.test-tmp/release-interaction-lists'
        assert (root / '.test-owner.json').is_file()
        self.runtime = runtime
        self.events = []
        self.lock = threading.Lock()
        self.task_id = None
        original = worker._run_claimed

        def observed(service, store, queue, claimed, stop_event):
            # Fail closed if this isolated process somehow sees a non-demo task.
            assert claimed['payload']['spec']['demo'] is True
            event = {'task_id': claimed['task_id'], 'thread': threading.current_thread().name,
                     'started': time.time() * 1000, 'claimed_state': claimed['state'],
                     'attempt': claimed['attempt'], 'leased': bool(claimed['lease_token'])}
            with self.lock:
                self.events.append(event)
            try:
                result = original(service, store, queue, claimed, stop_event)
                with self.lock:
                    event['outcome'] = result
                return result
            finally:
                with self.lock:
                    event['finished'] = time.time() * 1000

        worker._run_claimed = observed

    def call(self, service, method, params):
        if not method.startswith('test.consumer.'):
            return service.call(method, params)
        assert service.runtime == self.runtime
        store = Store(self.runtime / 'app.db')
        try:
            queue = TaskQueue(store)
            if method == 'test.consumer.enqueue':
                assert self.task_id is None, 'Exactly one bounded production task'
                account = params['account_id']
                spec = {'series': 'PY', 'episode': 91, 'topic': '离线消费者生命周期验收',
                        'demo': True, 'account_id': account, 'approve_local_exec': False}
                task = queue.enqueue(account, 'production', {'spec': spec},
                                     idempotency_key='codex1-consumer', max_attempts=1)
                self.task_id = task['task_id']
                return task
            assert method == 'test.consumer.snapshot' and self.task_id
            task = queue.get(self.task_id)
            job_id = queue.bound_job(self.task_id)
            job = store.get_job(job_id) if job_id else None
            article = store.get_article(job['article_id']) if job else None
            with self.lock:
                events = copy.deepcopy(self.events)
            return {'task': task, 'job_id': job_id, 'job': job,
                    'spec': article['spec'] if article else None,
                    'approval': store.pending_approval(job_id) if job_id else None,
                    'thread_alive': service._consumer_thread.is_alive(),
                    'events': events}
        finally:
            store.close()
