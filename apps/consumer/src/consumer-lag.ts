import type { Admin } from 'kafkajs';
import { emitAlert, metrics, structuredLog, type AlertHook } from '@truvo/observability';

export interface ConsumerLagSample {
  topic: string;
  group: string;
  lag: number;
  partitions: Array<{ partition: number; highWatermark: number; committed: number; lag: number }>;
}

/** Reads lag from broker offsets. Labels are deliberately limited to topic/group;
 * workspace/customer identifiers never participate in the metric key. */
export async function readBrokerConsumerLag(admin: Admin, topic: string, group: string): Promise<ConsumerLagSample> {
  try {
    const [highWatermarks, committedTopics] = await Promise.all([
      admin.fetchTopicOffsets(topic),
      admin.fetchOffsets({ groupId: group, topics: [topic], resolveOffsets: false }),
    ]);
    const committed = new Map(
      (committedTopics.find((entry) => entry.topic === topic)?.partitions ?? [])
        .map((entry) => [entry.partition, Number(entry.offset)]),
    );
    const partitions = highWatermarks.map((entry) => {
      const highWatermark = Number(entry.high);
      const current = committed.get(entry.partition) ?? 0;
      return { partition: entry.partition, highWatermark, committed: current, lag: Math.max(0, highWatermark - current) };
    });
    const lag = partitions.reduce((sum, partition) => sum + partition.lag, 0);
    metrics.gauge(`consumer_group_lag:${topic}:${group}`, lag);
    return { topic, group, lag, partitions };
  } catch (error) {
    metrics.increment('consumer_lag_read_failures_total', { topic, group });
    structuredLog('warn', 'consumer_lag_read_failed', { topic, group, reason: error instanceof Error ? error.name : 'unknown' });
    return { topic, group, lag: 0, partitions: [] };
  }
}

export async function observeBrokerConsumerLag(
  admin: Admin,
  topic: string,
  group: string,
  alertHook?: AlertHook,
  alertThreshold = 1_000,
): Promise<ConsumerLagSample> {
  const sample = await readBrokerConsumerLag(admin, topic, group);
  if (sample.lag >= alertThreshold) {
    emitAlert(alertHook, 'consumer_lag_critical', 'critical', { topic, group, lag: sample.lag });
  }
  return sample;
}
