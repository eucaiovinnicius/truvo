/**
 * M17 — constantes e helpers puros (sem estado / sem infra).
 *
 * Espelha o vocabulário fechado de @truvo/db → schema/ai.ts (AI_GOALS etc.). O
 * barrel `schema/index.ts` só re-exporta `./ai` na integração (ver schemaExports);
 * até lá mantemos as constantes locais em sincronia — MESMO padrão do
 * attribution.constants.ts vs. @truvo/db.
 */

/** Objetivos de otimização (espelha @truvo/db → AI_GOALS). */
export const AI_GOALS = [
  'maximize_roas',
  'minimize_cac',
  'maximize_ltv',
  'maximize_cvr',
  'maximize_revenue',
] as const;
export type AiGoal = (typeof AI_GOALS)[number];

export const AI_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type AiRunStatus = (typeof AI_RUN_STATUSES)[number];

export const AI_INSIGHT_SEVERITIES = ['info', 'opportunity', 'warning', 'critical'] as const;
export type AiInsightSeverity = (typeof AI_INSIGHT_SEVERITIES)[number];

/** Janelas de análise permitidas (dias). */
export const AI_WINDOWS = [7, 14, 30, 60, 90] as const;
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * Modelos Claude (ver skill claude-api / model catalog):
 *  · análise de jornadas (Fase 2)  → 'claude-opus-4-8'  (mais capaz)
 *  · Q&A / text-to-query           → 'claude-sonnet-5'  (rápido/barato)
 */
export const ANALYSIS_MODEL = 'claude-opus-4-8';
export const QA_MODEL = 'claude-sonnet-5';

/** Env da chave Anthropic (fail-closed sem ela). */
export const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';

/**
 * Limiar do gap de reconciliação (regra 12): acima disto a janela é "incerta" e o
 * LLM entra em modo incerteza. Alinhado ao RECONCILIATION_GAP_THRESHOLD do M14
 * (default 0.02); lido do env com fallback.
 */
export function reconciliationThreshold(): number {
  const raw = process.env.RECONCILIATION_GAP_THRESHOLD;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0.02;
}

/** Queda relativa de CVR (Wilson) que dispara anomalia (canal com amostra suficiente). */
export const ANOMALY_CVR_DROP = 0.3; // -30%
/** Queda relativa de receita que dispara anomalia. */
export const ANOMALY_REVENUE_DROP = 0.4; // -40%
/** Amostra mínima (pessoas) para considerar uma anomalia de CVR confiável. */
export const ANOMALY_MIN_PERSONS = 50;

const MS_PER_DAY = 86_400_000;

export interface AnalysisWindow {
  start: Date;
  end: Date;
  days: number;
}

/** Resolve a janela de análise [start, end). Default: últimos `days` dias até agora. */
export function resolveWindow(startIso?: string, endIso?: string, days = DEFAULT_WINDOW_DAYS): AnalysisWindow {
  const end = endIso ? new Date(endIso) : new Date();
  const d = coerceWindowDays(days);
  const start = startIso ? new Date(startIso) : new Date(end.getTime() - d * MS_PER_DAY);
  const spanDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / MS_PER_DAY));
  return { start, end, days: spanDays };
}

/** A janela imediatamente anterior de igual duração (baseline p/ anomalias). */
export function previousWindow(win: AnalysisWindow): AnalysisWindow {
  const spanMs = win.end.getTime() - win.start.getTime();
  return { start: new Date(win.start.getTime() - spanMs), end: new Date(win.start.getTime()), days: win.days };
}

/** Normaliza a janela para a allowlist (fallback = default). */
export function coerceWindowDays(v: number | undefined, fallback = DEFAULT_WINDOW_DAYS): number {
  if (v == null) return fallback;
  return (AI_WINDOWS as readonly number[]).includes(v) ? v : fallback;
}

/** Formata Date → 'YYYY-MM-DD' (tipo Date do ClickHouse). */
export function toChDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Divisão segura: null quando o denominador é 0/ausente. */
export function safeDiv(numerator: number, denominator: number): number | null {
  if (!denominator || !Number.isFinite(denominator)) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}

/** Arredonda p/ N casas preservando null. */
export function round(v: number | null, decimals = 4): number | null {
  if (v === null || !Number.isFinite(v)) return v === null ? null : 0;
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/** Converte um valor desconhecido do ClickHouse em número finito. */
export function asNum(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

export const asStr = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
