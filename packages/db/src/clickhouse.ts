import { createClient, type ClickHouseClient } from '@clickhouse/client';

/**
 * Client ClickHouse (eventos). Toda query DEVE filtrar por workspace_id (regra 1).
 * Config via env (Docker local em dev; Railway em prod).
 */
export function createClickHouse(): ClickHouseClient {
  return createClient({
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER ?? 'truvo',
    password: process.env.CLICKHOUSE_PASSWORD ?? 'truvo_local',
    database: process.env.CLICKHOUSE_DB ?? 'truvo',
  });
}

export type { ClickHouseClient };
