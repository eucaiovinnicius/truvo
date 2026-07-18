import type { ReportFrequency, ReportSchedule } from '@truvo/db';
import { resolveWindow } from '../metrics/metrics.constants';

/**
 * M13 — utilidades de agendamento e janela.
 *
 * // TODO(live): o cálculo de próxima execução é NAÏVE em UTC — não aplica o fuso do
 * workspace/`schedule.timezone` (precisaria de uma lib de tz, ex.: luxon/Intl com
 * offset por data). Para o MVP, `hour` é interpretado como hora UTC. Documentado p/
 * substituir por resolução real de fuso quando o worker durável entrar.
 */

const DAY_MS = 24 * 3600_000;

/**
 * Calcula o próximo instante de execução (UTC) a partir de `from`.
 * Retorna null para frequency 'manual' (sem agendamento).
 */
export function computeNextRun(
  frequency: ReportFrequency,
  schedule: ReportSchedule | undefined,
  from: Date = new Date(),
): Date | null {
  if (frequency === 'manual') return null;

  const hour = clampInt(schedule?.hour, 0, 23, 8);

  if (frequency === 'daily') {
    return nextAtHour(from, hour);
  }

  if (frequency === 'weekly') {
    const targetDow = clampInt(schedule?.weekday, 0, 6, 1); // default segunda
    let candidate = nextAtHour(from, hour);
    // avança dia a dia (no máx. 7) até bater no dia da semana desejado.
    for (let i = 0; i < 7; i++) {
      if (candidate.getUTCDay() === targetDow) return candidate;
      candidate = new Date(candidate.getTime() + DAY_MS);
      candidate.setUTCHours(hour, 0, 0, 0);
    }
    return candidate;
  }

  // monthly
  const targetDom = clampInt(schedule?.dayOfMonth, 1, 28, 1);
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  let candidate = new Date(Date.UTC(y, m, targetDom, hour, 0, 0, 0));
  if (candidate.getTime() <= from.getTime()) {
    candidate = new Date(Date.UTC(y, m + 1, targetDom, hour, 0, 0, 0));
  }
  return candidate;
}

/** Próximo instante em que o relógio bate `hour:00` (UTC), estritamente após `from`. */
function nextAtHour(from: Date, hour: number): Date {
  const c = new Date(from.getTime());
  c.setUTCHours(hour, 0, 0, 0);
  if (c.getTime() <= from.getTime()) {
    c.setTime(c.getTime() + DAY_MS);
    c.setUTCHours(hour, 0, 0, 0);
  }
  return c;
}

function clampInt(v: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  const i = Math.trunc(v);
  return Math.min(max, Math.max(min, i));
}

/**
 * Congela a janela [start, end) do período relativo no instante `now`. Reusa a mesma
 * lógica do M6 (resolveWindow) p/ que o snapshot cubra exatamente o intervalo que o
 * dashboard consultaria. Retorna Date de início/fim (para persistir na run).
 */
export function freezeWindow(period: string, now: Date = new Date()): { start: Date; end: Date } {
  return resolveWindow({ period, end: now.toISOString(), defaultDays: 30 });
}
