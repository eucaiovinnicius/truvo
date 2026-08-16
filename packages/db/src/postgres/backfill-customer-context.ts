import { config } from 'dotenv';
import { createHash } from 'node:crypto';
import postgres from 'postgres';

config({ path: '../../.env' });

const BACKFILL_KEY = 'order-030-v1';
const batchSize = Math.max(1, Number(process.env.CUSTOMER_CONTEXT_BACKFILL_BATCH_SIZE ?? 250));
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

interface Candidate {
  canonical_id: string;
  first_seen_at: Date;
  last_seen_at: Date;
  profile_status: 'anonymous' | 'identified' | null;
  email_hash: string | null;
  phone_hash: string | null;
  metrics: unknown;
  profile_observed_at: Date | null;
  profile_deleted_at: Date | null;
  merged_into: string | null;
}

interface Checkpoint {
  status: 'pending' | 'running' | 'completed' | 'failed';
  cursor: string | null;
  processed_count: number;
}

const client = postgres(connectionString, { prepare: false, max: 1 });

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 32)}`;
}

async function backfillWorkspace(workspaceId: string): Promise<number> {
  await client`
    insert into customer_context_backfill_checkpoints (workspace_id, backfill_key)
    values (${workspaceId}, ${BACKFILL_KEY})
    on conflict (workspace_id, backfill_key) do nothing
  `;
  const [checkpoint] = await client<Checkpoint[]>`
    select status, cursor, processed_count
    from customer_context_backfill_checkpoints
    where workspace_id = ${workspaceId} and backfill_key = ${BACKFILL_KEY}
  `;
  if (checkpoint?.status === 'completed') return 0;

  let cursor = checkpoint?.cursor ?? '';
  let processed = 0;
  await client`
    update customer_context_backfill_checkpoints
    set status = 'running', started_at = coalesce(started_at, now()), last_error = null,
        completed_at = null, updated_at = now()
    where workspace_id = ${workspaceId} and backfill_key = ${BACKFILL_KEY}
  `;

  try {
    for (;;) {
      const candidates = await client<Candidate[]>`
        with known as (
          select workspace_id, canonical_id, min(first_seen) as first_seen_at,
                 max(first_seen) as last_seen_at
          from identity_links where workspace_id = ${workspaceId}
          group by workspace_id, canonical_id
          union all
          select workspace_id, canonical_id, coalesce(first_seen_at, created_at),
                 coalesce(last_seen_at, updated_at)
          from user_profiles where workspace_id = ${workspaceId}
          union all
          select workspace_id, merged_from, at, at
          from identity_merges where workspace_id = ${workspaceId}
        ), rollup as (
          select canonical_id, min(first_seen_at) as first_seen_at, max(last_seen_at) as last_seen_at
          from known group by canonical_id
        )
        select r.canonical_id, r.first_seen_at, r.last_seen_at,
               p.status::text as profile_status, p.email_hash, p.phone_hash, p.metrics,
               coalesce(p.recomputed_at, p.updated_at) as profile_observed_at,
               p.tombstoned_at as profile_deleted_at,
               m.canonical_id as merged_into
        from rollup r
        left join user_profiles p on p.workspace_id = ${workspaceId} and p.canonical_id = r.canonical_id
        left join lateral (
          select canonical_id from identity_merges
          where workspace_id = ${workspaceId} and merged_from = r.canonical_id
          order by at desc limit 1
        ) m on true
        where r.canonical_id > ${cursor}
        order by r.canonical_id
        limit ${batchSize}
      `;
      if (candidates.length === 0) break;

      await client.begin(async (tx) => {
        for (const row of candidates) {
          const status = row.merged_into
            ? 'merged'
            : row.profile_status ?? (row.canonical_id.startsWith('usr_') ? 'identified' : 'anonymous');
          await tx`
            insert into customers (
              workspace_id, id, legacy_canonical_id, status, merged_into_customer_id,
              source_namespace, provenance, first_seen_at, last_seen_at, deleted_at
            ) values (
              ${workspaceId}, ${row.canonical_id}, ${row.canonical_id}, ${status}, ${row.merged_into},
              'truvo.v3', ${tx.json({ imported_by: 'order-030-backfill' })},
              ${row.first_seen_at}, ${row.last_seen_at}, ${row.profile_deleted_at}
            )
            on conflict (workspace_id, id) do update set
              status = excluded.status,
              merged_into_customer_id = excluded.merged_into_customer_id,
              first_seen_at = least(customers.first_seen_at, excluded.first_seen_at),
              last_seen_at = greatest(customers.last_seen_at, excluded.last_seen_at),
              deleted_at = excluded.deleted_at,
              updated_at = now()
          `;

          const identifiers = await tx<Array<{ identifier: string; identifier_type: string; first_seen: Date }>>`
            select identifier, identifier_type::text, first_seen
            from identity_links
            where workspace_id = ${workspaceId} and canonical_id = ${row.canonical_id}
            order by identifier_type, identifier
          `;
          if (row.email_hash && !identifiers.some((i) => i.identifier_type === 'email_hash' && i.identifier === row.email_hash)) {
            identifiers.push({ identifier: row.email_hash, identifier_type: 'email_hash', first_seen: row.first_seen_at });
          }
          if (row.phone_hash && !identifiers.some((i) => i.identifier_type === 'phone_hash' && i.identifier === row.phone_hash)) {
            identifiers.push({ identifier: row.phone_hash, identifier_type: 'phone_hash', first_seen: row.first_seen_at });
          }
          for (const identifier of identifiers) {
            await tx`
              insert into customer_identifiers (
                workspace_id, id, customer_id, identifier_type, provider_namespace,
                identifier_value, source_namespace, provenance, first_seen_at, last_seen_at
              ) values (
                ${workspaceId}, ${deterministicId('cid', workspaceId, 'truvo.identity', identifier.identifier_type, identifier.identifier)},
                ${row.canonical_id}, ${identifier.identifier_type}, 'truvo.identity',
                ${identifier.identifier}, 'truvo.identity', ${tx.json({ imported_by: 'order-030-backfill' })},
                ${identifier.first_seen}, ${row.last_seen_at}
              )
              on conflict (workspace_id, provider_namespace, identifier_type, identifier_value)
              do update set customer_id = excluded.customer_id,
                            last_seen_at = greatest(customer_identifiers.last_seen_at, excluded.last_seen_at),
                            deleted_at = null, updated_at = now()
            `;
          }

          if (row.profile_observed_at) {
            const traits = [
              { key: 'status', type: 'string', value: row.profile_status ?? status },
              { key: 'metrics', type: 'json', value: row.metrics ?? {} },
            ];
            for (const trait of traits) {
              await tx`
                insert into customer_traits (
                  workspace_id, id, customer_id, trait_namespace, trait_key, value_type,
                  value, source_namespace, provenance, observed_at
                ) values (
                  ${workspaceId}, ${deterministicId('ctr', workspaceId, row.canonical_id, 'truvo.profile', trait.key)},
                  ${row.canonical_id}, 'truvo.profile', ${trait.key}, ${trait.type},
                  ${tx.json(trait.value as postgres.JSONValue)}, 'truvo.profile', ${tx.json({ imported_by: 'order-030-backfill' })},
                  ${row.profile_observed_at}
                )
                on conflict (workspace_id, customer_id, trait_namespace, trait_key)
                do update set value_type = excluded.value_type, value = excluded.value,
                              source_namespace = excluded.source_namespace,
                              provenance = excluded.provenance, observed_at = excluded.observed_at,
                              deleted_at = null, updated_at = now()
                where customer_traits.observed_at <= excluded.observed_at
              `;
            }
          }
        }

        cursor = candidates[candidates.length - 1]!.canonical_id;
        await tx`
          update customer_context_backfill_checkpoints
          set cursor = ${cursor}, processed_count = processed_count + ${candidates.length}, updated_at = now()
          where workspace_id = ${workspaceId} and backfill_key = ${BACKFILL_KEY}
        `;
      });
      processed += candidates.length;
    }

    await client`
      update customer_context_backfill_checkpoints
      set status = 'completed', completed_at = now(), updated_at = now()
      where workspace_id = ${workspaceId} and backfill_key = ${BACKFILL_KEY}
    `;
    return processed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await client`
      update customer_context_backfill_checkpoints
      set status = 'failed', last_error = ${message.slice(0, 4000)}, updated_at = now()
      where workspace_id = ${workspaceId} and backfill_key = ${BACKFILL_KEY}
    `;
    throw error;
  }
}

async function main(): Promise<void> {
  try {
    const workspaces = await client<Array<{ workspace_id: string }>>`
      select distinct workspace_id from (
        select workspace_id from identity_links
        union all select workspace_id from identity_merges
        union all select workspace_id from user_profiles
      ) source order by workspace_id
    `;
    let total = 0;
    for (const { workspace_id } of workspaces) {
      const count = await backfillWorkspace(workspace_id);
      total += count;
      console.log(`[customer-context:backfill] workspace=${workspace_id} processed=${count}`);
    }
    console.log(`[customer-context:backfill] completed workspaces=${workspaces.length} processed=${total}`);
  } finally {
    await client.end();
  }
}

void main().catch((error: unknown) => {
  console.error('[customer-context:backfill] failed', error);
  process.exitCode = 1;
});
