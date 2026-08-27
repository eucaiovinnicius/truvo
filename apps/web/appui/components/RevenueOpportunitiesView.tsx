'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, Download,
  LoaderCircle, RefreshCw, Send, SlidersHorizontal, Users,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useLive } from '@/lib/live';
import { LiveDataBoundary } from '@/lib/live-ui';
import { useSession } from '@/lib/session';
import type { RadarDetail, RadarListItem } from './radar-ui';
import { economicDisclosure, formatMoney, reconciliationCopy, signalLabel } from './opportunity-ui';

type Provenance = {
  radarId: string; radarName: string; radarDefinitionVersion: number; modelVersionId: string;
  opportunityBatchId: string; scoreCutoff: string; materializedAt: string;
  predictionWindowDays: number; freshness: string;
};
type OpportunitySummary = {
  state: string;
  provenance?: Provenance;
  summary?: {
    opportunityCount: number; monetaryOpportunityCount: number; monetaryCoverageRatio: number;
    bands: { high: number; medium: number; low: number };
    expectedRevenue: { currency: string; expected_revenue: string } | null;
    expectedRevenueByCurrency: Array<{ currency: string; expected_revenue: string }>;
    currencyState: 'single' | 'mixed' | 'unavailable';
  };
};
type OpportunityRow = {
  id: string; customer_id: string; probability: string; score_band: string;
  expected_outcome_value: string | null; expected_revenue: string | null; currency: string | null;
  value_provenance: { quality?: string; reason?: string; source?: string; sampleCount?: number };
  reason_codes: string[]; scored_at: string; prediction_window_end: string; recent_activity: string;
};
type OpportunityList = { state: string; items: OpportunityRow[]; nextCursor?: string | null; provenance?: Provenance };
type OpportunityDetail = OpportunityRow & {
  radar_name: string; model_version_id: string; materialized_at: string; recent_activity: string;
  eligibility_state: string; provenance: Provenance;
};
type ActivationPreview = {
  destination: { status: string; reason?: string };
  counts: { requested: number; currentlyEligible: number; suppressed: number; missingDestinationIdentifier: number; duplicatesCollapsed: number; deliverable: number };
};
type ActivationResult = { status: 'success' | 'partial' | 'failed'; replay: boolean; counts: Record<string, number>; remoteAudienceId?: string; decisionBatchId?: string; decisionCount?: number };

const demoRadar: RadarListItem = {
  id: 'demo-revenue-radar', name: 'Radar de recompra (demo)', status: 'active', current_definition_version: 1,
  current_model_reference: 'demo-model-v1', outcome_definition_id: 'purchase', prediction_window_days: 30,
  updated_at: '2026-08-27T12:00:00.000Z',
};
const demoProvenance: Provenance = {
  radarId: demoRadar.id, radarName: demoRadar.name, radarDefinitionVersion: 1, modelVersionId: 'demo-model-v1',
  opportunityBatchId: 'demo-batch-v1', scoreCutoff: '2026-08-27T00:00:00.000Z', materializedAt: '2026-08-27T01:00:00.000Z',
  predictionWindowDays: 30, freshness: 'current',
};
const demoRows: OpportunityRow[] = [
  { id: 'demo-o1', customer_id: 'Cliente Aurora', probability: '0.84', score_band: 'high', expected_outcome_value: '125', expected_revenue: '105', currency: 'BRL', value_provenance: { quality: 'high', source: 'customer', sampleCount: 6 }, reason_codes: ['returning_customer', 'high_engagement'], scored_at: '2026-08-27T00:00:00.000Z', prediction_window_end: '2026-09-26T00:00:00.000Z', recent_activity: '2026-08-26T12:00:00.000Z' },
  { id: 'demo-o2', customer_id: 'Cliente Horizonte', probability: '0.78', score_band: 'high', expected_outcome_value: null, expected_revenue: null, currency: null, value_provenance: { quality: 'unavailable', reason: 'insufficient_monetary_history' }, reason_codes: ['recent_purchase'], scored_at: '2026-08-27T00:00:00.000Z', prediction_window_end: '2026-09-26T00:00:00.000Z', recent_activity: '2026-08-25T12:00:00.000Z' },
];

function stateTone(tone: 'neutral' | 'warning' | 'danger') {
  return tone === 'danger' ? 'border-rose-200 bg-rose-50 text-rose-900'
    : tone === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-900'
      : 'border-slate-200 bg-slate-50 text-slate-800';
}

function selectionBody(batchId: string, selected: Set<string>, allMatching: boolean, query: Record<string, unknown>) {
  return allMatching
    ? { mode: 'all_matching' as const, batchId, query }
    : { mode: 'selected' as const, batchId, ids: [...selected] };
}

export default function RevenueOpportunitiesView() {
  const session = useSession();
  const [radarId, setRadarId] = useState('');
  const [bandFilter, setBandFilter] = useState('');
  const [moneyFilter, setMoneyFilter] = useState('');
  const [currency, setCurrency] = useState('');
  const [sort, setSort] = useState<'expectedRevenue' | 'probability' | 'recentActivity'>('expectedRevenue');
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionState, setActionState] = useState<'idle' | 'exporting' | 'previewing' | 'activating'>('idle');
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<ActivationPreview | null>(null);
  const [activationIdentity, setActivationIdentity] = useState<{ correlationId: string; idempotencyKey: string } | null>(null);

  const radarsState = useLive<RadarListItem[]>('/v1/radars', [refresh]);
  const radars = radarsState.status === 'demo' ? [demoRadar] : radarsState.data ?? [];
  useEffect(() => {
    if (radarsState.status !== 'success' && radarsState.status !== 'demo') return;
    if (!radarId && radars.length) setRadarId(radars[0]!.id);
    if (radarId && !radars.some((radar) => radar.id === radarId)) setRadarId(radars[0]?.id ?? '');
  }, [radarId, radars, radarsState.status]);

  const radarDetailState = useLive<RadarDetail>(radarId ? `/v1/radars/${radarId}` : null, [radarId, refresh]);
  const summaryState = useLive<OpportunitySummary>(radarId ? `/v1/opportunities/summary?radarId=${encodeURIComponent(radarId)}` : null, [radarId, refresh]);
  const query = useMemo(() => ({
    sort, direction: 'desc' as const,
    filters: {
      ...(bandFilter ? { scoreBands: [bandFilter] } : {}),
      ...(moneyFilter ? { monetary: moneyFilter === 'monetary' } : {}),
      ...(currency ? { currency } : {}),
    },
  }), [bandFilter, moneyFilter, currency, sort]);
  const listPath = useMemo(() => {
    if (!radarId) return null;
    const params = new URLSearchParams({ radarId, sort, direction: 'desc', limit: '50' });
    if (bandFilter) params.set('scoreBands', bandFilter);
    if (moneyFilter) params.set('monetary', String(moneyFilter === 'monetary'));
    if (currency) params.set('currency', currency);
    if (cursor) params.set('cursor', cursor);
    return `/v1/opportunities?${params.toString()}`;
  }, [radarId, sort, bandFilter, moneyFilter, currency, cursor]);
  const listState = useLive<OpportunityList>(listPath, [refresh]);
  const detailState = useLive<OpportunityDetail>(detailId ? `/v1/opportunities/${detailId}` : null, [detailId, refresh]);

  const summary: OpportunitySummary = summaryState.status === 'demo' ? {
    state: 'ready', provenance: demoProvenance,
    summary: { opportunityCount: 2, monetaryOpportunityCount: 1, monetaryCoverageRatio: 0.5, bands: { high: 2, medium: 0, low: 0 }, expectedRevenue: { currency: 'BRL', expected_revenue: '105' }, expectedRevenueByCurrency: [{ currency: 'BRL', expected_revenue: '105' }], currencyState: 'single' },
  } : summaryState.data ?? { state: 'loading' };
  const list: OpportunityList = listState.status === 'demo' ? { state: 'current', items: demoRows, nextCursor: null, provenance: demoProvenance } : listState.data ?? { state: 'loading', items: [] };
  const radarDetail = radarDetailState.data;
  const batchId = summary.provenance?.opportunityBatchId ?? list.provenance?.opportunityBatchId ?? '';
  const destinationId = radarDetail?.definition.activation_destination?.connectionId;
  const destinationUnavailable = radarDetail?.activationReadiness.status === 'unavailable';

  useEffect(() => {
    setSelected(new Set()); setAllMatching(false); setCursor(undefined); setCursorHistory([]); setDetailId(null); setPreview(null); setActivationIdentity(null);
  }, [radarId, bandFilter, moneyFilter, currency, sort, batchId]);
  useEffect(() => {
    if (listState.error?.code === 'stale_cursor') {
      setCursor(undefined); setCursorHistory([]); setSelected(new Set()); setAllMatching(false);
      setNotice('A lista foi atualizada. Voltamos à primeira página; revise e selecione novamente.');
    }
  }, [listState.error?.code]);
  useEffect(() => {
    if (summary.summary?.currencyState === 'mixed' && !currency && sort === 'expectedRevenue') setSort('probability');
  }, [summary.summary?.currencyState, currency, sort]);

  const reload = () => { setRefresh((value) => value + 1); setNotice(null); };
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const selectPage = () => setSelected((current) => {
    const next = new Set(current); const pageSelected = list.items.every((row) => next.has(row.id));
    for (const row of list.items) pageSelected ? next.delete(row.id) : next.add(row.id); return next;
  });

  const runExport = async () => {
    if (session.mode === 'demo') { setActionMessage('Exportação demo concluída — nenhum dado real foi enviado.'); return; }
    if (!batchId || (!allMatching && selected.size === 0)) return;
    setActionState('exporting'); setActionMessage(null);
    try {
      const csv = await api<string>('/v1/opportunities/export', { method: 'POST', body: JSON.stringify({ radarId, selection: selectionBody(batchId, selected, allMatching, query), correlationId: crypto.randomUUID() }) });
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'revenue-opportunities.csv'; anchor.click(); URL.revokeObjectURL(url);
      setActionMessage('CSV exportado com a seleção e o batch atuais.');
    } catch (error) { setActionMessage(error instanceof ApiError && error.code === 'stale_selection' ? 'A lista mudou. Atualize e selecione novamente.' : 'A exportação falhou sem alterar a lista.'); }
    finally { setActionState('idle'); }
  };

  const previewActivation = async () => {
    if (session.mode === 'demo') { setActivationIdentity({ correlationId: 'demo-correlation', idempotencyKey: 'demo-idempotency' }); setPreview({ destination: { status: 'ready' }, counts: { requested: 2, currentlyEligible: 2, suppressed: 0, missingDestinationIdentifier: 0, duplicatesCollapsed: 0, deliverable: 2 } }); return; }
    if (!destinationId || !batchId || (!allMatching && selected.size === 0)) return;
    setActionState('previewing'); setActionMessage(null);
    try {
      const identity = { correlationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
      setPreview(await api<ActivationPreview>('/v1/opportunities/activation/preview', { method: 'POST', body: JSON.stringify({ radarId, connectionId: destinationId, selection: selectionBody(batchId, selected, allMatching, query), ...identity }) }));
      setActivationIdentity(identity);
    } catch { setActionMessage('Não foi possível preparar a audiência. Nenhum dado foi enviado ao provedor.'); }
    finally { setActionState('idle'); }
  };

  const activate = async () => {
    if (session.mode === 'demo') { setActionMessage('Audiência demo concluída — nenhum provedor real foi alterado.'); setPreview(null); return; }
    if (!destinationId || !batchId || !activationIdentity) return;
    setActionState('activating');
    try {
      const result = await api<ActivationResult>('/v1/opportunities/activation', { method: 'POST', body: JSON.stringify({ radarId, connectionId: destinationId, selection: selectionBody(batchId, selected, allMatching, query), ...activationIdentity }) });
      const provenance = result.decisionCount ? ` Decision recorded: ${result.decisionCount} (${result.decisionBatchId}).` : '';
      setActionMessage(result.status === 'success' ? `Audiência enviada: ${result.counts.accepted ?? 0} aceitos.${provenance}` : result.status === 'partial' ? `Envio parcial: ${result.counts.accepted ?? 0} aceitos; ${result.counts.providerRejected ?? 0} rejeitados.${provenance}` : 'O provedor não aceitou a audiência. A lista continua disponível.');
      setPreview(null);
      setActivationIdentity(null);
    } catch { setActionMessage('Falha isolada na ativação. A lista e o CSV continuam disponíveis.'); }
    finally { setActionState('idle'); }
  };

  const state = reconciliationCopy(summary.state);
  const rows = list.items;
  const boundaryStates = session.mode === 'demo' ? [] : [radarsState, ...(radarId ? [summaryState, listState] : [])];
  const currencies = summary.summary?.expectedRevenueByCurrency.map((entry) => entry.currency) ?? [];

  return <div className="space-y-6" data-testid="revenue-opportunities">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs font-mono font-bold uppercase tracking-wider text-teal-700">Revenue Opportunities</p><h1 className="mt-1 text-2xl font-bold">Saiba quem vai comprar a seguir</h1><p className="mt-1 text-sm text-slate-500">Ranking operacional versionado por Radar, modelo e score batch.</p></div>
      <div className="flex gap-2"><button onClick={reload} aria-label="Atualizar oportunidades" className="rounded-lg border border-slate-300 bg-white p-2"><RefreshCw className="h-4 w-4" /></button><button onClick={runExport} disabled={actionState !== 'idle' || (!allMatching && selected.size === 0)} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold disabled:opacity-40"><Download className="h-4 w-4" /> Exportar CSV</button><button onClick={previewActivation} disabled={actionState !== 'idle' || !destinationId || destinationUnavailable || (!allMatching && selected.size === 0)} className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-bold text-white disabled:opacity-40"><Send className="h-4 w-4" /> Enviar audiência</button></div>
    </header>
    {session.mode === 'demo' && <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-900"><strong>Modo demonstração:</strong> dados sintéticos determinísticos, claramente separados dos dados ao vivo.</div>}
    <LiveDataBoundary states={boundaryStates} empty={radars.length === 0} label="Revenue Opportunities">
      {radars.length === 0 ? <section className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center"><Users className="mx-auto h-7 w-7 text-slate-400" /><h2 className="mt-2 font-bold">Nenhum Radar disponível</h2><p className="text-sm text-slate-500">Crie e ative um Radar antes de materializar oportunidades.</p></section> : <>
        <section className="grid gap-4 rounded-xl border border-slate-200 bg-white p-5 lg:grid-cols-[minmax(240px,1fr)_2fr]">
          <div><label className="text-xs font-bold uppercase tracking-wide text-slate-500">Radar</label><select aria-label="Radar de oportunidades" value={radarId} onChange={(event) => setRadarId(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">{radars.map((radar) => <option key={radar.id} value={radar.id}>{radar.name}</option>)}</select></div>
          <div className={`rounded-lg border p-3 text-sm ${stateTone(state.tone)}`}><p className="font-bold">{state.title}</p><p className="mt-0.5 text-xs opacity-80">{state.description}</p>{summary.provenance && <p className="mt-2 font-mono text-[10px] opacity-70">Modelo {summary.provenance.modelVersionId} · batch {summary.provenance.opportunityBatchId} · cutoff {new Date(summary.provenance.scoreCutoff).toLocaleString('pt-BR')}</p>}</div>
        </section>
        {summary.summary && <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <article className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs text-slate-500">Oportunidades</p><p className="mt-1 text-2xl font-bold">{summary.summary.opportunityCount}</p></article>
          <article className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs text-slate-500">Alta propensão</p><p className="mt-1 text-2xl font-bold">{summary.summary.bands.high}</p></article>
          <article className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs text-slate-500">Cobertura monetária</p><p className="mt-1 text-2xl font-bold">{Math.round(summary.summary.monetaryCoverageRatio * 100)}%</p></article>
          <article className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs text-slate-500">Receita Esperada</p><p className="mt-1 text-2xl font-bold">{summary.summary.currencyState === 'mixed' ? 'Múltiplas moedas' : formatMoney(summary.summary.expectedRevenue?.expected_revenue ?? null, summary.summary.expectedRevenue?.currency ?? null)}</p><p className="mt-1 text-[10px] text-slate-500">{economicDisclosure(summary.summary.expectedRevenue?.expected_revenue ?? null, summary.summary.currencyState)}</p></article>
        </section>}
        <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center gap-2"><SlidersHorizontal className="h-4 w-4 text-slate-400" /><select aria-label="Filtrar por faixa" value={bandFilter} onChange={(event) => setBandFilter(event.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs"><option value="">Todas as faixas</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select><select aria-label="Filtrar valor monetário" value={moneyFilter} onChange={(event) => setMoneyFilter(event.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs"><option value="">Com e sem valor</option><option value="monetary">Com Receita Esperada</option><option value="non-monetary">Sem Receita Esperada</option></select>{currencies.length > 1 && <select aria-label="Filtrar moeda" value={currency} onChange={(event) => setCurrency(event.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs"><option value="">Escolha uma moeda</option>{currencies.map((entry) => <option key={entry}>{entry}</option>)}</select>}<select aria-label="Ordenar oportunidades" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs"><option value="expectedRevenue">Receita Esperada</option><option value="probability">Probabilidade</option><option value="recentActivity">Atividade recente</option></select><button onClick={() => { setBandFilter('high'); setSort('probability'); }} className="rounded-lg bg-teal-50 px-3 py-1.5 text-xs font-bold text-teal-800">Ver High</button></div>
          {notice && <p role="status" className="rounded-lg bg-sky-50 p-2 text-xs text-sky-900">{notice}</p>}
          <div className="flex flex-wrap items-center gap-3 border-y border-slate-100 py-2 text-xs"><label className="flex items-center gap-2"><input type="checkbox" aria-label="Selecionar página atual" checked={rows.length > 0 && rows.every((row) => selected.has(row.id))} onChange={selectPage} /> Página atual</label><label className="flex items-center gap-2"><input type="checkbox" aria-label="Selecionar todos os filtros" checked={allMatching} onChange={(event) => { setAllMatching(event.target.checked); setSelected(new Set()); }} /> Todos os resultados destes filtros</label><span className="text-slate-500">{allMatching ? 'Seleção imutável por filtros' : `${selected.size} selecionados`} · batch-bound</span></div>
          {rows.length === 0 ? <div className="p-8 text-center"><h2 className="font-bold">Nenhuma oportunidade atual</h2><p className="mt-1 text-sm text-slate-500">Os scores podem ser válidos mesmo quando nenhum cliente está elegível para esta visão.</p></div> : <div className="overflow-x-auto"><table className="w-full min-w-[1050px] text-left text-xs"><thead className="bg-slate-50 text-slate-500"><tr><th className="p-3">Seleção</th><th className="p-3">Cliente</th><th className="p-3">Probabilidade</th><th className="p-3">Faixa</th><th className="p-3">Receita Esperada</th><th className="p-3">Janela</th><th className="p-3">Sinais</th><th className="p-3">Atividade recente</th><th className="p-3">Status</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className="border-t border-slate-100 hover:bg-slate-50"><td className="p-3"><input aria-label={`Selecionar ${row.customer_id}`} type="checkbox" disabled={allMatching} checked={selected.has(row.id)} onChange={() => toggle(row.id)} /></td><td className="p-3"><button onClick={() => setDetailId(row.id)} className="font-bold text-teal-800 hover:underline">{row.customer_id}</button></td><td className="p-3 font-mono font-bold">{(Number(row.probability) * 100).toFixed(1)}%</td><td className="p-3"><span className={`rounded-full px-2 py-1 font-bold ${row.score_band === 'high' ? 'bg-emerald-100 text-emerald-800' : row.score_band === 'medium' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'}`}>{row.score_band}</span></td><td className="p-3"><span className="font-bold">{formatMoney(row.expected_revenue, row.currency)}</span>{row.expected_revenue === null && <span className="block max-w-[190px] text-[10px] text-slate-500">{economicDisclosure(null)}</span>}</td><td className="p-3">até {new Date(row.prediction_window_end).toLocaleDateString('pt-BR')}</td><td className="max-w-[220px] p-3">{row.reason_codes.map((code) => <span key={code} className="mr-1 inline-block rounded bg-slate-100 px-1.5 py-0.5">{signalLabel(code)}</span>)}</td><td className="p-3">{new Date(row.recent_activity).toLocaleDateString('pt-BR')}</td><td className="p-3 text-emerald-700">Elegível · {list.provenance?.freshness ?? 'atual'}</td></tr>)}</tbody></table></div>}
          <div className="flex items-center justify-between"><button disabled={!cursorHistory.length} onClick={() => { const history = [...cursorHistory]; setCursor(history.pop()); setCursorHistory(history); }} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold disabled:opacity-40"><ChevronLeft className="h-3.5 w-3.5" /> Anterior</button><span className="text-[10px] text-slate-500">Página limitada a 50 · filtros e ordenação no servidor</span><button disabled={!list.nextCursor} onClick={() => { setCursorHistory((history) => [...history, cursor]); setCursor(list.nextCursor ?? undefined); }} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold disabled:opacity-40">Próxima <ChevronRight className="h-3.5 w-3.5" /></button></div>
        </section>
      </>}
    </LiveDataBoundary>
    {actionState !== 'idle' && <div aria-live="polite" className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm text-white"><LoaderCircle className="h-4 w-4 animate-spin" /> {actionState === 'exporting' ? 'Exportando…' : actionState === 'previewing' ? 'Preparando preview…' : 'Enviando audiência…'}</div>}
    {actionMessage && <div role="status" className="rounded-xl border border-slate-200 bg-white p-3 text-sm"><CheckCircle2 className="mr-2 inline h-4 w-4 text-teal-700" />{actionMessage}</div>}
    {destinationUnavailable && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><CircleAlert className="mr-2 inline h-4 w-4" />Destino desconectado: ativação indisponível. A lista e a exportação CSV permanecem disponíveis.</div>}
    {preview && <section aria-label="Preview de ativação" className="rounded-xl border border-slate-300 bg-white p-5 shadow-lg"><div className="flex items-start justify-between"><div><h2 className="font-bold">Confirme a audiência</h2><p className="text-xs text-slate-500">Preview somente leitura; o provedor ainda não foi alterado.</p></div><button onClick={() => setPreview(null)} aria-label="Fechar preview">×</button></div><dl className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-6">{Object.entries(preview.counts).map(([key, value]) => <div key={key} className="rounded-lg bg-slate-50 p-3"><dt className="text-[10px] text-slate-500">{key}</dt><dd className="font-bold">{value}</dd></div>)}</dl>{preview.destination.status !== 'ready' ? <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Destino desconectado. A lista e o CSV continuam disponíveis.</p> : <button onClick={activate} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-teal-700 px-4 py-2 text-sm font-bold text-white"><Send className="h-4 w-4" /> Confirmar envio</button>}</section>}
    {detailId && <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/20" onClick={() => setDetailId(null)}><aside className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}><button onClick={() => setDetailId(null)} className="inline-flex items-center gap-1 text-sm font-bold text-slate-600"><ArrowLeft className="h-4 w-4" /> Voltar</button><LiveDataBoundary states={[detailState]} empty={!detailState.data} label="Detalhe da oportunidade">{detailState.data && <div className="mt-6 space-y-5" data-testid="opportunity-detail"><div><p className="text-xs font-mono text-teal-700">{detailState.data.radar_name}</p><h2 className="text-xl font-bold">{detailState.data.customer_id}</h2></div><dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-slate-500">Probabilidade / faixa</dt><dd className="font-bold">{(Number(detailState.data.probability) * 100).toFixed(1)}% · {detailState.data.score_band}</dd></div><div><dt className="text-xs text-slate-500">Horizonte</dt><dd className="font-bold">{new Date(detailState.data.prediction_window_end).toLocaleDateString('pt-BR')}</dd></div><div><dt className="text-xs text-slate-500">Valor estimado</dt><dd className="font-bold">{formatMoney(detailState.data.expected_outcome_value, detailState.data.currency)}</dd></div><div><dt className="text-xs text-slate-500">Receita Esperada</dt><dd className="font-bold">{formatMoney(detailState.data.expected_revenue, detailState.data.currency)}</dd></div><div><dt className="text-xs text-slate-500">Qualidade do valor</dt><dd className="font-bold">{detailState.data.value_provenance.quality ?? 'unavailable'}</dd></div><div><dt className="text-xs text-slate-500">Atividade canônica recente</dt><dd className="font-bold">{new Date(detailState.data.recent_activity).toLocaleString('pt-BR')}</dd></div></dl><section><h3 className="text-sm font-bold">Sinais</h3><p className="text-xs text-slate-500">Sinais explicativos do ranking; não representam causa ou uplift.</p><div className="mt-2 flex flex-wrap gap-2">{detailState.data.reason_codes.map((code) => <span key={code} className="rounded bg-slate-100 px-2 py-1 text-xs">{signalLabel(code)}</span>)}</div></section><section className="rounded-lg bg-slate-50 p-3 font-mono text-[10px] text-slate-600">Modelo {detailState.data.model_version_id}<br />Scored at {new Date(detailState.data.scored_at).toISOString()}<br />Materialized at {new Date(detailState.data.materialized_at).toISOString()}<br />Batch {detailState.data.provenance.opportunityBatchId}</section><p className="text-xs text-slate-500">{economicDisclosure(detailState.data.expected_revenue)}</p></div>}</LiveDataBoundary></aside></div>}
  </div>;
}
