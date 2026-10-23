import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { PgBoss } from 'pg-boss';
import { startCompanionWorker } from '../src/worker/worker-service.js';

function database() {
  const chain: any = { from() { return this; }, where() { return this; }, for() { return this; }, async limit() { return []; }, then(resolve: (value: unknown[]) => unknown) { return Promise.resolve([]).then(resolve); } };
  return { db: { async execute() { return { rows: [{ job_table: 'job', queue_table: 'queue', version_table: 'version' }] }; }, async transaction(fn: (tx: any) => unknown) { return fn({ select: () => chain, update: () => chain }); } } } as any;
}
function bossDouble(failAt?: string) {
  const events: string[] = [];
  const emitter = new EventEmitter();
  const boss: any = {
    async start() { events.push('start'); if (failAt === 'start') throw marker; },
    async createQueue(q: string) { events.push(`queue:${q}`); if (failAt === `queue:${q.endsWith('process') ? 'process' : 'deliver'}`) throw marker; },
    async work(q: string) { events.push(`work:${q}`); if (failAt === `work:${q.endsWith('process') ? 'process' : 'deliver'}`) throw marker; return q; },
    async offWork(q: string) { events.push(`off:${q}`); if (failAt === `off:${q.endsWith('process') ? 'process' : 'deliver'}`) throw marker; },
    async stop() { events.push('stop'); },
    on(event: string, listener: (...args: any[]) => void) { events.push('on'); emitter.on(event, listener); return this; },
    off(event: string, listener: (...args: any[]) => void) { events.push('off-error'); emitter.off(event, listener); return this; },
    async send() { return 'id'; },
  };
  return { boss: boss as PgBoss, events };
}
const marker = new Error('original failure');
const url = 'postgresql://compat:compat-test-only@127.0.0.1:55432/oh_bot_worker_compat';

test('startup failures release earlier owned resources and preserve original error', async () => {
  for (const point of ['start', 'queue:process', 'queue:deliver', 'work:process', 'work:deliver']) {
    const { boss, events } = bossDouble(point);
    await assert.rejects(startCompanionWorker({ database: database(), databaseUrl: url, bossFactory: () => boss }), (error) => error === marker);
    assert.ok(events.includes('stop'), `${point} should stop owned boss`);
    if (events.includes('work:process')) assert.ok(events.includes('off:companion.process'));
    if (events.includes('on')) assert.ok(events.includes('off-error'));
  }
});

test('stop shares cleanup, continues after individual offWork errors and preserves caller boss', async () => {
  const { boss, events } = bossDouble('off:process');
  const worker = await startCompanionWorker({ database: database(), databaseUrl: url, boss, dispatchIntervalMs: 60_000 });
  const first = worker.stop();
  const second = worker.stop();
  assert.equal(first, second);
  await first;
  assert.ok(events.includes('off:companion.process'));
  assert.ok(events.includes('off:companion.deliver'));
  assert.ok(events.includes('off-error'));
  assert.equal(events.includes('stop'), false);
});
