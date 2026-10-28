"""Bounded node-IO gate for the real consumer; never fabricates worker results.

Only used in the owned codex2 fixture process. The engine has persisted running
and acquired its job lease before entering NODE_FUNCS. Stop is the real jobs.stop
RPC, then the original demo node resumes and the production engine handles it.
"""
import copy
import threading
import time

from ice_agent.workflow.nodes import NODE_FUNCS
from tests.reading_lifecycle_consumer import ConsumerProbe


class CancelProbe(ConsumerProbe):
    def __init__(self, repo, runtime):
        super().__init__(repo, runtime)
        self.release = threading.Event()
        self.node = None
        original = NODE_FUNCS['topic']

        def gated(ctx):
            assert ctx.state['spec']['demo'] is True
            assert threading.current_thread().name == 'ice-queue-consumer'
            job = ctx.store.get_job(ctx.job['job_id'])
            assert job['state'] == 'running' and job['lease']
            with self.lock:
                assert self.node is None, 'Only one node entry in this fixture'
                self.node = {'job_id': job['job_id'], 'article_id': job['article_id'],
                             'account_id': ctx.article['spec']['account_id'],
                             'entered': time.time() * 1000, 'state': job['state'],
                             'leased': bool(job['lease']), 'thread': threading.current_thread().name}
            try:
                assert self.release.wait(45), 'Bounded node gate timed out'
                with self.lock:
                    self.node['released'] = time.time() * 1000
                return original(ctx)
            finally:
                with self.lock:
                    self.node['finished'] = time.time() * 1000

        NODE_FUNCS['topic'] = gated

    def call(self, service, method, params):
        if method == 'test.consumer.release':
            assert service.runtime == self.runtime and self.task_id and self.node
            self.release.set()
            return {'released': True}
        result = super().call(service, method, params)
        if method == 'test.consumer.snapshot':
            with self.lock:
                result['node'] = copy.deepcopy(self.node)
        return result
