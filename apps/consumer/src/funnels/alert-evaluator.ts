// NOTA DE INTEGRAÇÃO: `funnels`/`Funnel` são expostos por @truvo/db após o barrel
// `schema/index.ts` re-exportar `./funnels` (integração M5 — ver openTODOs).
import { createClickHouse, createDb, funnels, type ClickHouseClient, type Database, type Funnel } from '@truvo/db';
import { overallConversion } from './funnel-calc';
import { structuredLog } from '@truvo/observability';

/**
 * M5 — Worker de alertas de funil. Varre os funis ATIVOS com alerta ligado,
 * calcula a conversão geral recente (ClickHouse, regras 1 e 11) e, quando cai
 * abaixo do limiar, monta o disparo.
 *
 * A ENTREGA da notificação é do M12 (onda futura): `dispatch` marca o ponto de
 * integração (publicar em `truvo.notifications` / chamar NotificationsService).
 *
 * NÃO está plugado no `main.ts` do consumer (evita conflito com módulos
 * paralelos). Um scheduler/cron deve chamar `runFunnelAlertSweep()` — ver notes.
 */

const MIN_SAMPLE = Number(process.env.FUNNEL_ALERT_MIN_SAMPLE ?? 20);
const DEFAULT_LOOKBACK_DAYS = Number(process.env.FUNNEL_ALERT_WINDOW_DAYS ?? 7);

export interface FunnelAlertHit {
  workspace_id: string;
  funnel_id: string;
  funnel_name: string;
  threshold: number;
  observed_conversion_rate: number;
  entered: number;
  channels: Array<'email' | 'slack' | 'in_app'>;
  triggered_at: string;
}

export class FunnelAlertEvaluator {
  private _db: Database | null = null;
  private _ch: ClickHouseClient | null = null;

  constructor(private readonly lookbackDays = DEFAULT_LOOKBACK_DAYS) {}

  private db(): Database {
    if (!this._db) this._db = createDb(); // lança se DATABASE_URL ausente
    return this._db;
  }

  private ch(): ClickHouseClient {
    if (!this._ch) this._ch = createClickHouse();
    return this._ch;
  }

  /** Uma varredura completa. Retorna os alertas rompidos (já despachados). */
  async sweep(): Promise<FunnelAlertHit[]> {
    const rows = await this.db().select().from(funnels);
    const active = rows.filter((f) => f.status === 'active' && Boolean(f.alert?.enabled));

    const hits: FunnelAlertHit[] = [];
    for (const f of active) {
      try {
        const hit = await this.evaluateOne(f);
        if (hit) {
          hits.push(hit);
          await this.dispatch(hit);
        }
      } catch (err) {
        structuredLog('warn', 'funnel_alert_evaluation_failed', { workspaceId: f.workspaceId, funnelId: f.id, errorType: (err as Error).name });
      }
    }
    return hits;
  }

  private async evaluateOne(f: Funnel): Promise<FunnelAlertHit | null> {
    const { rate, entered } = await overallConversion(
      this.ch(),
      f.workspaceId,
      f.steps,
      f.attributionWindowDays,
      this.lookbackDays,
    );
    const threshold = f.alert.min_overall_conversion_rate ?? 0;
    // Amostra mínima evita disparo por ruído (poucos visitantes).
    if (entered < MIN_SAMPLE || rate >= threshold) return null;

    return {
      workspace_id: f.workspaceId,
      funnel_id: f.id,
      funnel_name: f.name,
      threshold,
      observed_conversion_rate: rate,
      entered,
      channels: f.alert.channels ?? ['in_app'],
      triggered_at: new Date().toISOString(),
    };
  }

  /**
   * TODO(live): M12 — publicar o alerta (Kafka `truvo.notifications` ou
   * NotificationsService). O M12 resolve destinatários por `channels` e aplica
   * de-dup/rate-limit; aqui apenas registramos.
   */
  private async dispatch(hit: FunnelAlertHit): Promise<void> {
    structuredLog('warn', 'funnel_conversion_alert', { workspaceId: hit.workspace_id, funnelId: hit.funnel_id, observedConversionRate: hit.observed_conversion_rate, threshold: hit.threshold, entered: hit.entered });
  }

  async close(): Promise<void> {
    if (this._ch) await this._ch.close();
  }
}

/** Entry-point p/ um scheduler/cron: roda uma varredura e encerra o client. */
export async function runFunnelAlertSweep(): Promise<FunnelAlertHit[]> {
  const evaluator = new FunnelAlertEvaluator();
  try {
    return await evaluator.sweep();
  } finally {
    await evaluator.close();
  }
}
