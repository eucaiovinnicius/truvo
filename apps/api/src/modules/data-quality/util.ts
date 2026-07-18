/**
 * Utilidades puras (datas/números) do M14. Sem dependência de framework.
 */

import { DEFAULT_RANGE_DAYS } from './constants';

/** Arredonda para 2 casas (dinheiro). */
export function money(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

/** Converte valor desconhecido (string/number/null) em número seguro. */
export function toNum(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/**
 * Normaliza uma entrada de data (`YYYY-MM-DD` ou ISO datetime) para um dia UTC
 * `YYYY-MM-DD`. Retorna `null` se inválida.
 */
export function toDayUtc(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  // Aceita 'YYYY-MM-DD' direto (sem passar por Date p/ evitar shift de fuso).
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Dia UTC de hoje (`YYYY-MM-DD`). */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Adiciona `days` (pode ser negativo) a um dia `YYYY-MM-DD`, retornando `YYYY-MM-DD`. */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve a janela [startDay, endDay] (ambos inclusivos, `YYYY-MM-DD`) a partir
 * de entradas opcionais. Default: últimos {@link DEFAULT_RANGE_DAYS} dias até hoje.
 * Garante start <= end (troca se vier invertido).
 */
export function resolveRange(
  startInput: string | undefined,
  endInput: string | undefined,
): { startDay: string; endDay: string } {
  const end = toDayUtc(endInput) ?? todayUtc();
  const start = toDayUtc(startInput) ?? addDays(end, -(DEFAULT_RANGE_DAYS - 1));
  if (start > end) return { startDay: end, endDay: start };
  return { startDay: start, endDay: end };
}

/** Lista inclusiva de dias `YYYY-MM-DD` de startDay até endDay. */
export function eachDay(startDay: string, endDay: string): string[] {
  const out: string[] = [];
  let cur = startDay;
  // Guarda de segurança (evita loop infinito por entrada absurda): teto ~5 anos.
  for (let i = 0; i < 1830 && cur <= endDay; i++) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/**
 * Formata um dia `YYYY-MM-DD` como o INÍCIO daquele dia em DateTime do ClickHouse
 * ('YYYY-MM-DD 00:00:00.000'). Para o fim-exclusivo, passe `endDay + 1 dia`.
 */
export function dayToChDateTime(day: string): string {
  return `${day} 00:00:00.000`;
}

/**
 * `reconciliation_gap = |truvo - gateway| / gateway`. Retorna `null` quando não há
 * ground truth (gateway == 0) — o chamador decide o status 'no_ground_truth'.
 */
export function computeGap(truvoRevenue: number, gatewayRevenue: number): number | null {
  if (gatewayRevenue <= 0) return null;
  return Math.abs(truvoRevenue - gatewayRevenue) / gatewayRevenue;
}
