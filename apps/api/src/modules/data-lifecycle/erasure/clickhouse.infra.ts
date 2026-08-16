import { createClickHouse, type ClickHouseClient } from '@truvo/db';

/**
 * Memoized ClickHouse client for the data-lifecycle module — same singleton +
 * explicit-close-for-short-lived-processes pattern as
 * `apps/api/src/modules/identity/identity.infra.ts` (`getRedis`/`closeRedis`),
 * kept local rather than importing identity's infra to avoid an unnecessary
 * cross-module coupling for a one-line helper.
 */
let _ch: ClickHouseClient | undefined;

export function getClickHouse(): ClickHouseClient {
  if (!_ch) _ch = createClickHouse();
  return _ch;
}

export async function closeClickHouse(): Promise<void> {
  if (!_ch) return;
  const client = _ch;
  _ch = undefined;
  await client.close();
}
