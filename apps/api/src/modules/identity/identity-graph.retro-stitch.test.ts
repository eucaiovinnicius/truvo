import assert from 'node:assert/strict';
import test from 'node:test';
import Redis from 'ioredis';
import { enqueueRetroStitch, closeRedis } from './identity.infra';
// Order 045: reuses the EXISTING retro-stitch queue (consumer side) — no parallel
// queue is introduced. api/consumer don't share code outside packages (documented
// convention already used by identity.constants.ts/stitch-queue.ts), hence the
// cross-package relative import for this proof only.
import { ensureConsumerGroup, readNewEntries, ackEntry, reclaimStale, type StitchEntry } from '../../../../consumer/src/identity/stitch-queue';

/**
 * Order 045 §"Runtime validation" — "If Redis is needed for retro-stitch runtime
 * tests, use disposable/local Redis." Proves the producer (`enqueueRetroStitch`,
 * shared by v1 `identify()` and v2 `IdentityGraphService`) round-trips through the
 * REAL consumer-group queue: read → ack is a checkpoint (never reprocessed), and an
 * unacked entry (simulated worker crash) is reclaimable — the idempotent/reprocessable
 * guarantee retroactive stitching depends on.
 *
 * Matches by STAMP-unique canonical_id rather than exact stream length: a shared
 * disposable Redis may carry leftover undelivered entries from other test runs in
 * the same container, and asserting on our own job specifically is both correct and
 * more representative of a real shared stream.
 */
let reachable: boolean | undefined;
async function checkReachable(): Promise<boolean> {
  if (reachable !== undefined) return reachable;
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const probe = new Redis(url, { lazyConnect: true, connectTimeout: 1000, maxRetriesPerRequest: 1 });
  try {
    await probe.connect();
    await probe.ping();
    reachable = true;
  } catch {
    reachable = false;
  } finally {
    probe.disconnect();
  }
  return reachable;
}

const STAMP = Date.now();
const CANONICAL_1 = `usr_retro_test_${STAMP}`;
const CANONICAL_2 = `usr_retro_test_2_${STAMP}`;

/** Drains up to `count` entries, tolerating leftover entries from other runs. */
async function readUntilFound(
  redis: Redis,
  consumer: string,
  canonicalId: string,
): Promise<{ found: StitchEntry; rest: StitchEntry[] }> {
  const { entries } = await readNewEntries(redis, consumer, 50, 500);
  const found = entries.find((e) => e.job.canonical_id === canonicalId);
  if (!found) throw new Error(`job canonical_id=${canonicalId} não apareceu no read`);
  return { found, rest: entries.filter((e) => e.job.canonical_id !== canonicalId) };
}

test('retro-stitch queue: enqueue→read→ack is a checkpoint; unacked entries are reclaimable for retry', async (t) => {
  if (!(await checkReachable())) {
    t.skip('REDIS_URL não alcançável neste ambiente — ver HANDOFF (Redis dev unreachable)');
    return;
  }

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  try {
    await ensureConsumerGroup(redis);

    await enqueueRetroStitch({
      workspace_id: 'ws_retro_test',
      canonical_id: CANONICAL_1,
      merged_from: ['anon_retro_test'],
      reason: 'test',
      enqueued_at: new Date().toISOString(),
    });

    const { found: first, rest } = await readUntilFound(redis, 'consumer-a', CANONICAL_1);
    assert.equal(first.job.workspace_id, 'ws_retro_test');
    assert.equal(first.job.merged_from[0], 'anon_retro_test');
    // ack any leftover entries from prior runs too, so they stop polluting future runs.
    for (const leftover of rest) await ackEntry(redis, leftover.id);

    // ack our own entry (checkpoint) — reclaiming afterwards must not surface it again.
    await ackEntry(redis, first.id);
    const reclaimAfterAck = await reclaimStale(redis, 'consumer-b', 0, 50);
    assert.ok(
      !reclaimAfterAck.entries.some((e) => e.job.canonical_id === CANONICAL_1),
      'entrada ACKada não deve reaparecer via reclaim',
    );

    // a SECOND job read but never acked (simulates a worker crash) must be
    // reclaimable by a different consumer — proves reprocessability.
    await enqueueRetroStitch({
      workspace_id: 'ws_retro_test',
      canonical_id: CANONICAL_2,
      merged_from: ['anon_retro_test_2'],
      reason: 'test',
      enqueued_at: new Date().toISOString(),
    });
    const { found: second } = await readUntilFound(redis, 'consumer-crashed', CANONICAL_2);
    assert.equal(second.job.canonical_id, CANONICAL_2); // read but intentionally NOT acked

    const reclaimed = await reclaimStale(redis, 'consumer-b', 0, 50);
    const reclaimedOurs = reclaimed.entries.find((e) => e.job.canonical_id === CANONICAL_2);
    assert.ok(reclaimedOurs, 'entrada não-ACKada deve ser reivindicável por outro consumer');
    await ackEntry(redis, reclaimedOurs!.id);

    // idempotent: acking + reclaiming again finds our job gone from the pending set.
    const finalReclaim = await reclaimStale(redis, 'consumer-b', 0, 50);
    assert.ok(!finalReclaim.entries.some((e) => e.job.canonical_id === CANONICAL_2));
  } finally {
    await redis.quit().catch(() => redis.disconnect());
    closeRedis();
  }
});
