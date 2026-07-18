import { Injectable } from '@nestjs/common';
import type { ReportBranding, ReportSnapshot } from '@truvo/db';

/**
 * M13 — Renderização white-label.
 *
 * Gera o HTML self-contained (CSS inline) do relatório a partir do SNAPSHOT congelado +
 * branding. Serve tanto ao link web read-only (GET /public/:token?format=html) quanto ao
 * corpo do email. As cores/logo/rodapé vêm do branding da agência (fallback p/ o tema Truvo).
 *
 * PDF: // TODO(live) — não usamos lib pesada (puppeteer/headless chrome). `renderPdf`
 * devolve o HTML pronto para impressão + um aviso; a conversão binária deve ser feita por
 * um renderer externo (serviço de print, ou lib leve tipo `@react-pdf`/`pdfkit` num worker).
 */

export interface ReportRenderContext {
  reportName: string;
  branding: ReportBranding;
  snapshot: ReportSnapshot;
  periodLabel: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  generatedAt: string;
}

interface Theme {
  primary: string;
  accent: string;
  bg: string;
  text: string;
  muted: string;
  companyName: string;
  logoUrl: string | null;
  footerText: string;
}

@Injectable()
export class ReportRenderService {
  /** HTML completo (documento) do relatório white-label. */
  renderHtml(ctx: ReportRenderContext): string {
    const t = resolveTheme(ctx.branding);
    const widgets = Array.isArray(ctx.snapshot?.widgets) ? ctx.snapshot.widgets : [];
    const period = formatPeriod(ctx);

    const body = widgets.length
      ? widgets.map((w) => this.renderWidget(w, t)).join('\n')
      : `<p style="color:${t.muted}">Nenhum widget neste relatório.</p>`;

    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(ctx.reportName)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; background:${t.bg}; color:${t.text}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 32px 24px 64px; }
  .head { display:flex; align-items:center; justify-content:space-between; gap:16px; border-bottom:3px solid ${t.primary}; padding-bottom:16px; margin-bottom:24px; flex-wrap:wrap; }
  .brand { display:flex; align-items:center; gap:12px; }
  .brand img { max-height:44px; max-width:180px; object-fit:contain; }
  .brand .name { font-size:18px; font-weight:700; color:${t.primary}; }
  .meta { text-align:right; font-size:13px; color:${t.muted}; }
  h1 { font-size:22px; margin:0 0 4px; }
  .period { font-size:14px; color:${t.muted}; margin:0 0 24px; }
  .widget { border:1px solid ${hexAlpha(t.text, 0.12)}; border-radius:12px; padding:18px 20px; margin-bottom:18px; background:${hexAlpha(t.primary, 0.03)}; }
  .widget h3 { margin:0 0 12px; font-size:15px; color:${t.primary}; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px,1fr)); gap:12px; }
  .kpi { background:${t.bg}; border:1px solid ${hexAlpha(t.text, 0.1)}; border-radius:10px; padding:12px 14px; }
  .kpi .label { font-size:12px; color:${t.muted}; text-transform:uppercase; letter-spacing:.03em; }
  .kpi .value { font-size:20px; font-weight:700; margin-top:4px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid ${hexAlpha(t.text, 0.1)}; }
  th { color:${t.muted}; font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:.03em; }
  .err { color:#b42318; font-size:13px; }
  .foot { margin-top:40px; border-top:1px solid ${hexAlpha(t.text, 0.12)}; padding-top:16px; font-size:12px; color:${t.muted}; }
  .foot a { color:${t.accent}; text-decoration:none; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <div class="brand">
        ${t.logoUrl ? `<img src="${esc(t.logoUrl)}" alt="${esc(t.companyName)}" />` : `<span class="name">${esc(t.companyName)}</span>`}
      </div>
      <div class="meta">Gerado em ${esc(fmtDate(ctx.generatedAt))}</div>
    </div>
    <h1>${esc(ctx.reportName)}</h1>
    <p class="period">${esc(period)}</p>
    ${body}
    <div class="foot">
      ${t.footerText ? `<div>${esc(t.footerText)}</div>` : ''}
      <div>Relatório gerado por ${esc(t.companyName)} · powered by Truvo</div>
    </div>
  </div>
</body>
</html>`;
  }

  /**
   * "PDF". // TODO(live): sem renderer binário aqui — devolve o HTML pronto para print e
   * um aviso. Um worker/serviço externo converte para PDF (ver docstring do módulo).
   */
  renderPdf(ctx: ReportRenderContext): { html: string; contentType: string; note: string } {
    return {
      html: this.renderHtml(ctx),
      contentType: 'text/html',
      note: 'PDF binário requer renderer externo (TODO live) — HTML pronto para impressão devolvido.',
    };
  }

  // ─────────────────────────── widgets ───────────────────────────

  private renderWidget(w: Record<string, unknown>, t: Theme): string {
    const title = typeof w.title === 'string' && w.title ? w.title : titleFromKind(w.kind);
    const inner = this.renderWidgetBody(w, t);
    return `<div class="widget"><h3>${esc(title)}</h3>${inner}</div>`;
  }

  private renderWidgetBody(w: Record<string, unknown>, t: Theme): string {
    if (typeof w.error === 'string' && w.error) {
      return `<p class="err">Falha ao carregar: ${esc(w.error)}</p>`;
    }
    const kind = typeof w.kind === 'string' ? w.kind : '';
    const data = w.data;

    switch (kind) {
      case 'kpis':
        return this.renderKpis(data);
      case 'custom_kpi':
        return this.renderCustomKpi(w, data);
      case 'timeseries':
        return this.renderSeries(data);
      case 'breakdown':
        return this.renderBreakdown(data);
      default:
        return this.renderGeneric(data);
    }
  }

  private renderKpis(data: unknown): string {
    // metrics.nativeKpis → { totals: {...}, ... }. Renderiza os totais como cards.
    const totals = isRecord(data) && isRecord(data.totals) ? data.totals : isRecord(data) ? data : {};
    const cards = Object.entries(totals)
      .filter(([, v]) => isScalar(v))
      .map(([k, v]) => kpiCard(prettyKey(k), fmtNum(v)))
      .join('');
    return cards ? `<div class="kpis">${cards}</div>` : this.renderGeneric(data);
  }

  private renderCustomKpi(w: Record<string, unknown>, data: unknown): string {
    const name = typeof w.name === 'string' ? w.name : 'KPI';
    const value = isRecord(data) ? (data.value ?? data.result ?? data) : data;
    return `<div class="kpis">${kpiCard(name, fmtNum(value))}</div>`;
  }

  private renderSeries(data: unknown): string {
    const points = Array.isArray(data)
      ? data
      : isRecord(data) && Array.isArray(data.series)
        ? data.series
        : isRecord(data) && Array.isArray(data.points)
          ? data.points
          : [];
    if (!points.length) return this.renderGeneric(data);
    return this.renderRows(points as unknown[]);
  }

  private renderBreakdown(data: unknown): string {
    const rows = Array.isArray(data)
      ? data
      : isRecord(data) && Array.isArray(data.rows)
        ? data.rows
        : isRecord(data) && Array.isArray(data.breakdown)
          ? data.breakdown
          : [];
    if (!rows.length) return this.renderGeneric(data);
    return this.renderRows(rows as unknown[]);
  }

  /** Tabela genérica a partir de uma lista de objetos (colunas = união de chaves escalares). */
  private renderRows(rows: unknown[]): string {
    const objs = rows.filter(isRecord).slice(0, 100);
    if (!objs.length) {
      // lista de escalares
      const items = rows.slice(0, 100).map((r) => `<tr><td>${esc(String(r))}</td></tr>`).join('');
      return `<table><tbody>${items}</tbody></table>`;
    }
    const cols: string[] = [];
    for (const o of objs) {
      for (const k of Object.keys(o)) {
        if (!cols.includes(k) && isScalar(o[k])) cols.push(k);
      }
    }
    const head = cols.map((c) => `<th>${esc(prettyKey(c))}</th>`).join('');
    const body = objs
      .map((o) => `<tr>${cols.map((c) => `<td>${esc(cellText(o[c]))}</td>`).join('')}</tr>`)
      .join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  private renderGeneric(data: unknown): string {
    if (isScalar(data)) return `<div class="kpis">${kpiCard('Valor', fmtNum(data))}</div>`;
    if (isRecord(data)) {
      const rows = Object.entries(data)
        .filter(([, v]) => isScalar(v))
        .map(([k, v]) => `<tr><th>${esc(prettyKey(k))}</th><td>${esc(cellText(v))}</td></tr>`)
        .join('');
      if (rows) return `<table><tbody>${rows}</tbody></table>`;
    }
    return '<p>—</p>';
  }
}

// ─────────────────────────── helpers ───────────────────────────

const TRUVO_THEME = {
  primary: '#4f46e5',
  accent: '#0ea5e9',
  bg: '#ffffff',
  text: '#0f172a',
  muted: '#64748b',
};

function resolveTheme(b: ReportBranding | undefined | null): Theme {
  const br = b ?? {};
  return {
    primary: br.primaryColor || TRUVO_THEME.primary,
    accent: br.accentColor || TRUVO_THEME.accent,
    bg: br.backgroundColor || TRUVO_THEME.bg,
    text: br.textColor || TRUVO_THEME.text,
    muted: TRUVO_THEME.muted,
    companyName: br.companyName || 'Truvo',
    logoUrl: br.logoUrl || null,
    footerText: br.footerText || '',
  };
}

function kpiCard(label: string, value: string): string {
  return `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`;
}

function titleFromKind(kind: unknown): string {
  const map: Record<string, string> = {
    kpis: 'Indicadores',
    timeseries: 'Série temporal',
    breakdown: 'Detalhamento',
    custom_kpi: 'KPI customizado',
  };
  return (typeof kind === 'string' && map[kind]) || 'Widget';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isScalar(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return fmtNum(v);
  return String(v);
}

function fmtNum(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Number.isInteger(v) ? v.toLocaleString('pt-BR') : v.toLocaleString('pt-BR', { maximumFractionDigits: 4 });
  }
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? fmtNum(n) : String(v);
}

function prettyKey(k: string): string {
  return k.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('pt-BR', { timeZone: 'UTC' }) + ' UTC';
}

function formatPeriod(ctx: ReportRenderContext): string {
  const label = ctx.periodLabel ? prettyKey(ctx.periodLabel) : null;
  if (ctx.periodStart && ctx.periodEnd) {
    const s = fmtDateOnly(ctx.periodStart);
    const e = fmtDateOnly(ctx.periodEnd);
    return label ? `${label} · ${s} — ${e}` : `${s} — ${e}`;
  }
  return label ?? 'Período completo';
}

function fmtDateOnly(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

/** Escapa HTML (previne injeção via nomes/valores do snapshot). */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Aplica alpha a uma cor hex (#rgb|#rrggbb) → rgba(). Usado só p/ bordas/backgrounds sutis.
 * Cor inválida cai num cinza neutro (nunca quebra o CSS).
 */
function hexAlpha(hexColor: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hexColor);
  if (!m || !m[1]) return `rgba(100,116,139,${alpha})`;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
