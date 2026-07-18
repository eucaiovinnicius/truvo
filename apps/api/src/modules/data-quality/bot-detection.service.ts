import { Injectable } from '@nestjs/common';
import type { TruvoEvent } from '@truvo/event-schema';
import { getClickHouse } from '../events/infra';
import {
  detectBot,
  parseCidrList,
  type BotDetectorConfig,
  type BotSignals,
  type BotVerdict,
} from './bot-detection';
import { resolveRange, toNum } from './util';

export interface BotReportRow {
  day: string;
  source: string;
  total: number;
  bots: number;
  humans: number;
  bot_rate: number;
}

export interface BotReport {
  range: { start: string; end: string };
  totals: { events: number; bots: number; humans: number; bot_rate: number };
  by_day: Array<{ day: string; total: number; bots: number; humans: number; bot_rate: number }>;
  by_source: Array<{ source: string; total: number; bots: number; humans: number; bot_rate: number }>;
  top_bot_user_agents: Array<{ user_agent: string; events: number }>;
}

/**
 * M14 — serviço de bots. Dois papéis:
 *  1. `detect()` — expõe o detector puro do M14 (config vinda do env) para quem
 *     precisar classificar um evento (o consumer do M2 deveria reusar esta lógica —
 *     ver bot-detection.ts e openTODOs).
 *  2. `report()` — GET /v1/data-quality/bot-report: quanto tráfego foi filtrado
 *     como bot, por dia/source, + top user-agents de bot. Lê `bot_stats_daily`
 *     (a única MV que conta bots de propósito) e a tabela raw `events`.
 */
@Injectable()
export class BotDetectionService {
  private readonly config: BotDetectorConfig;

  constructor() {
    const extra = process.env.DATA_QUALITY_BOT_UA_EXTRA;
    this.config = {
      datacenterCidrs: parseCidrList(process.env.DATA_QUALITY_DATACENTER_CIDRS),
      extraUaPattern: extra ? safeRegex(extra) : undefined,
      maxEventsPerSecond: optNum(process.env.BOT_MAX_EVENTS_PER_SECOND),
      maxRequestsPerMinute: optNum(process.env.BOT_MAX_REQUESTS_PER_MINUTE),
    };
  }

  /** Classifica um evento (delega ao detector puro, com config do env). */
  detect(event: TruvoEvent, signals?: BotSignals): BotVerdict {
    return detectBot(event, signals, this.config);
  }

  async report(
    workspaceId: string,
    start: string | undefined,
    end: string | undefined,
  ): Promise<BotReport> {
    const { startDay, endDay } = resolveRange(start, end);
    const ch = getClickHouse();

    // by_day + by_source de bot_stats_daily (SummingMergeTree — barato).
    const statsRs = await ch.query({
      query: `
        SELECT
          toString(day)       AS day,
          source,
          sum(total_events)   AS total,
          sum(bot_events)     AS bots,
          sum(human_events)   AS humans
        FROM bot_stats_daily
        WHERE workspace_id = {workspace_id:String}
          AND day >= {start:Date}
          AND day <= {end:Date}
        GROUP BY day, source
        ORDER BY day, source`,
      query_params: { workspace_id: workspaceId, start: startDay, end: endDay },
      format: 'JSONEachRow',
    });
    const rows = (await statsRs.json()) as Array<Record<string, unknown>>;

    const byDayMap = new Map<string, { total: number; bots: number; humans: number }>();
    const bySourceMap = new Map<string, { total: number; bots: number; humans: number }>();
    let total = 0;
    let bots = 0;
    let humans = 0;

    for (const r of rows) {
      const day = String(r['day']);
      const source = String(r['source'] || '(none)');
      const t = toNum(r['total']);
      const b = toNum(r['bots']);
      const h = toNum(r['humans']);
      total += t;
      bots += b;
      humans += h;
      accumulate(byDayMap, day, t, b, h);
      accumulate(bySourceMap, source, t, b, h);
    }

    // top user-agents classificados como bot (tabela raw).
    const uaRs = await ch.query({
      query: `
        SELECT user_agent, count() AS events
        FROM events
        WHERE workspace_id = {workspace_id:String}
          AND is_bot = 1
          AND user_agent != ''
          AND timestamp >= {start:DateTime64(3)}
          AND timestamp <  {end:DateTime64(3)}
        GROUP BY user_agent
        ORDER BY events DESC
        LIMIT 20`,
      query_params: {
        workspace_id: workspaceId,
        start: `${startDay} 00:00:00.000`,
        end: `${nextDay(endDay)} 00:00:00.000`,
      },
      format: 'JSONEachRow',
    });
    const uaRows = (await uaRs.json()) as Array<Record<string, unknown>>;

    return {
      range: { start: startDay, end: endDay },
      totals: { events: total, bots, humans, bot_rate: rate(bots, total) },
      by_day: [...byDayMap.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([day, v]) => ({ day, ...v, bot_rate: rate(v.bots, v.total) })),
      by_source: [...bySourceMap.entries()]
        .sort((a, b) => b[1].bots - a[1].bots)
        .map(([source, v]) => ({ source, ...v, bot_rate: rate(v.bots, v.total) })),
      top_bot_user_agents: uaRows.map((r) => ({
        user_agent: String(r['user_agent']),
        events: toNum(r['events']),
      })),
    };
  }
}

function accumulate(
  map: Map<string, { total: number; bots: number; humans: number }>,
  key: string,
  total: number,
  bots: number,
  humans: number,
): void {
  const cur = map.get(key) ?? { total: 0, bots: 0, humans: 0 };
  cur.total += total;
  cur.bots += bots;
  cur.humans += humans;
  map.set(key, cur);
}

function rate(bots: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((bots / total) * 10000) / 10000;
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function optNum(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Compila um regex vindo do env sem derrubar o boot se for inválido. */
function safeRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return undefined;
  }
}
