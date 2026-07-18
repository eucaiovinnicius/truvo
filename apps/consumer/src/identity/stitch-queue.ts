import type Redis from 'ioredis';

/**
 * M8 — Fila de STITCHING RETROATIVO (lado consumer).
 *
 * Redis STREAM + consumer group → at-least-once com CHECKPOINT (XACK). O stitching
 * retroativo é o processamento mais pesado e propenso a inconsistência do sistema
 * (PRD §15): precisa ser idempotente, reprocessável e com fila dedicada. Um crash
 * no meio deixa a entrada PENDING → é reclamada por XAUTOCLAIM e reprocessada.
 *
 * ⚠️ Estes nomes/shape DUPLICAM `apps/api/src/modules/identity/identity.constants.ts`
 * (api e consumer não compartilham código fora dos packages) — manter em sincronia.
 */
export const IDENTITY_STITCH_STREAM = process.env.IDENTITY_STITCH_STREAM ?? 'identity.stitch';
export const IDENTITY_STITCH_GROUP = process.env.IDENTITY_STITCH_GROUP ?? 'identity-stitch-workers';

/** Payload do job (campos são strings no stream). */
export interface StitchJob {
  workspace_id: string;
  canonical_id: string;
  merged_from: string[];
  reason: string;
  enqueued_at: string;
}

/** Entrada lida do stream: id do Redis + job parseado. */
export interface StitchEntry {
  id: string;
  job: StitchJob;
}

/** Cria o consumer group (idempotente — ignora BUSYGROUP se já existir). MKSTREAM cria o stream. */
export async function ensureConsumerGroup(redis: Redis): Promise<void> {
  try {
    await redis.xgroup('CREATE', IDENTITY_STITCH_STREAM, IDENTITY_STITCH_GROUP, '$', 'MKSTREAM');
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (!msg.includes('BUSYGROUP')) throw err;
  }
}

/** Converte o array plano [k,v,k,v,...] do XREADGROUP num record. */
function fieldsToRecord(fields: string[]): Record<string, string> {
  const rec: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const k = fields[i];
    const v = fields[i + 1];
    if (k !== undefined && v !== undefined) rec[k] = v;
  }
  return rec;
}

/** Parseia um record de stream num StitchJob válido (ou null se malformado). */
export function parseStitchJob(rec: Record<string, string>): StitchJob | null {
  const workspace_id = rec.workspace_id;
  const canonical_id = rec.canonical_id;
  if (!workspace_id || !canonical_id) return null;

  let merged_from: string[] = [];
  try {
    const parsed: unknown = JSON.parse(rec.merged_from ?? '[]');
    if (Array.isArray(parsed)) merged_from = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    merged_from = [];
  }

  return {
    workspace_id,
    canonical_id,
    merged_from,
    reason: rec.reason ?? '',
    enqueued_at: rec.enqueued_at ?? '',
  };
}

/** Forma (parcial) da resposta do XREADGROUP/XAUTOCLAIM que nos interessa. */
type StreamEntriesReply = Array<[string, string[]]>;

/** Extrai StitchEntry[] de um bloco de entradas [id, fields][]. `malformed` recebe ids a descartar. */
function collectEntries(entries: StreamEntriesReply, out: StitchEntry[], malformed: string[]): void {
  for (const entry of entries) {
    const id = entry[0];
    const fields = entry[1];
    if (typeof id !== 'string' || !Array.isArray(fields)) continue;
    const job = parseStitchJob(fieldsToRecord(fields));
    if (job) out.push({ id, job });
    else malformed.push(id);
  }
}

export interface ReadResult {
  entries: StitchEntry[];
  /** ids malformados que devem ser ACKados p/ não travar o group (TODO: dead-letter). */
  malformed: string[];
}

/**
 * Lê novas entradas (`>`), bloqueando até `blockMs`. Retorna [] se nada chegar.
 */
export async function readNewEntries(
  redis: Redis,
  consumer: string,
  count: number,
  blockMs: number,
): Promise<ReadResult> {
  // ioredis tipa a resposta como `unknown[]`; na prática é
  // [[stream, [[id, fields], ...]]] ou `null` (timeout do BLOCK). Cast via unknown.
  const reply = (await redis.xreadgroup(
    'GROUP',
    IDENTITY_STITCH_GROUP,
    consumer,
    'COUNT',
    count,
    'BLOCK',
    blockMs,
    'STREAMS',
    IDENTITY_STITCH_STREAM,
    '>',
  )) as unknown as Array<[string, StreamEntriesReply]> | null;

  const entries: StitchEntry[] = [];
  const malformed: string[] = [];
  if (reply) {
    for (const stream of reply) {
      const streamEntries = stream[1];
      if (Array.isArray(streamEntries)) collectEntries(streamEntries, entries, malformed);
    }
  }
  return { entries, malformed };
}

/**
 * Reivindica entradas PENDING ociosas há mais de `minIdleMs` (jobs de um worker que
 * caiu). Reprocessáveis com segurança (o recompute é idempotente).
 */
export async function reclaimStale(
  redis: Redis,
  consumer: string,
  minIdleMs: number,
  count: number,
): Promise<ReadResult> {
  // XAUTOCLAIM <key> <group> <consumer> <min-idle> <start> COUNT <n>
  // XAUTOCLAIM devolve [nextCursor, [[id, fields], ...], deletedIds]. Cast via unknown.
  const reply = (await redis.xautoclaim(
    IDENTITY_STITCH_STREAM,
    IDENTITY_STITCH_GROUP,
    consumer,
    minIdleMs,
    '0-0',
    'COUNT',
    count,
  )) as unknown as [string, StreamEntriesReply, ...unknown[]] | null;

  const entries: StitchEntry[] = [];
  const malformed: string[] = [];
  const claimed = reply?.[1];
  if (Array.isArray(claimed)) collectEntries(claimed, entries, malformed);
  return { entries, malformed };
}

/** Marca a entrada como processada (checkpoint). */
export async function ackEntry(redis: Redis, id: string): Promise<void> {
  await redis.xack(IDENTITY_STITCH_STREAM, IDENTITY_STITCH_GROUP, id);
}
