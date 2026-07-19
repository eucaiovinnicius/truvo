'use client';

import React, { useMemo, useState } from 'react';
import {
  Layers,
  Wallet,
  TrendingUp,
  Target,
  ArrowUpRight,
  ArrowDownRight,
  Image as ImageIcon,
  Film,
  Images,
  Filter,
  CalendarDays,
  Sparkles,
  Info,
  ArrowRight,
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';

// ---- Domínio ----
type Platform = 'Meta' | 'Google' | 'TikTok';
type CreativeType = 'image' | 'video' | 'carousel';
type Verdict = 'superestimado' | 'alinhado' | 'subestimado';

interface Creative {
  id: string;
  code: string;
  name: string;
  campaign: string;
  type: CreativeType;
  platform: Platform;
  spend: number;
  roasReported: number;
  roasReal: number;
  thumb: string; // classes de gradiente do placeholder
}

// ---- Config visual ----
const VERDICT_META: Record<Verdict, { label: string; badge: string; barReal: string }> = {
  superestimado: { label: 'Superestimado', badge: 'bg-rose-100 text-rose-800', barReal: 'bg-rose-400' },
  alinhado: { label: 'Alinhado', badge: 'bg-emerald-100 text-emerald-800', barReal: 'bg-emerald-500' },
  subestimado: { label: 'Subestimado', badge: 'bg-teal-100 text-teal-800', barReal: 'bg-teal-500' },
};

const PLATFORM_DOT: Record<Platform, string> = {
  Meta: 'bg-blue-500',
  Google: 'bg-amber-500',
  TikTok: 'bg-fuchsia-500',
};

const TYPE_LABEL: Record<CreativeType, string> = {
  image: 'Imagem',
  video: 'Vídeo',
  carousel: 'Carrossel',
};

function verdictOf(reported: number, real: number): Verdict {
  if (reported <= 0) return 'alinhado';
  const diff = ((real - reported) / reported) * 100;
  if (diff <= -6) return 'superestimado';
  if (diff >= 6) return 'subestimado';
  return 'alinhado';
}

function TypeIcon({ type, className }: { type: CreativeType; className?: string }): React.ReactElement {
  if (type === 'video') return <Film className={className} />;
  if (type === 'carousel') return <Images className={className} />;
  return <ImageIcon className={className} />;
}

// ---- Formatação pt-BR ----
const fmtBRL = (n: number): string =>
  n.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

const fmtRoas = (n: number): string => `${n.toFixed(2)}x`;

// ---- Mock realista (pt-BR) ----
const CREATIVES: Creative[] = [
  {
    id: 'cr-01',
    code: 'MET-01',
    name: 'Vídeo UGC Depoimento Cliente',
    campaign: '[FB-CONV] Conversão · Coleção de Inverno',
    type: 'video',
    platform: 'Meta',
    spend: 12400,
    roasReported: 4.2,
    roasReal: 2.85,
    thumb: 'from-teal-400 to-emerald-500',
  },
  {
    id: 'cr-02',
    code: 'MET-02',
    name: 'Carrossel Dinâmico de Produtos',
    campaign: '[FB-LOOK] Prospecting · Lookalike 1%',
    type: 'carousel',
    platform: 'Meta',
    spend: 8900,
    roasReported: 3.1,
    roasReal: 3.05,
    thumb: 'from-sky-400 to-indigo-500',
  },
  {
    id: 'cr-03',
    code: 'MET-03',
    name: 'Cupom Exclusivo: QUERO10',
    campaign: '[FB-RETRG] Remarketing · Checkout 14d',
    type: 'image',
    platform: 'Meta',
    spend: 5600,
    roasReported: 6.8,
    roasReal: 8.4,
    thumb: 'from-amber-400 to-orange-500',
  },
  {
    id: 'cr-04',
    code: 'MET-04',
    name: 'Unboxing de Inverno',
    campaign: '[FB-CONV] Conversão · Coleção de Inverno',
    type: 'video',
    platform: 'Meta',
    spend: 9600,
    roasReported: 5.4,
    roasReal: 3.1,
    thumb: 'from-rose-400 to-pink-500',
  },
  {
    id: 'cr-05',
    code: 'GGL-01',
    name: 'Shopping · Tênis Runner Pro',
    campaign: '[GS-SHOP] Shopping · Categoria Calçados',
    type: 'image',
    platform: 'Google',
    spend: 15200,
    roasReported: 3.9,
    roasReal: 3.72,
    thumb: 'from-violet-400 to-purple-500',
  },
  {
    id: 'cr-06',
    code: 'GGL-02',
    name: 'YouTube Bumper Institucional',
    campaign: '[GS-VID] Awareness · Alcance de Marca',
    type: 'video',
    platform: 'Google',
    spend: 4300,
    roasReported: 2.1,
    roasReal: 1.35,
    thumb: 'from-red-400 to-rose-500',
  },
  {
    id: 'cr-07',
    code: 'GGL-03',
    name: 'Search · Palavras de Marca',
    campaign: '[GS-BRAND] Institucional · Marca Exata',
    type: 'image',
    platform: 'Google',
    spend: 6200,
    roasReported: 9.2,
    roasReal: 9.05,
    thumb: 'from-emerald-400 to-teal-500',
  },
  {
    id: 'cr-08',
    code: 'TTK-01',
    name: 'Trend Dança · Unboxing',
    campaign: '[TT-PROSP] Spark Ads · Prospecting',
    type: 'video',
    platform: 'TikTok',
    spend: 7100,
    roasReported: 2.9,
    roasReal: 1.75,
    thumb: 'from-fuchsia-400 to-pink-500',
  },
  {
    id: 'cr-09',
    code: 'TTK-02',
    name: 'React Criador · Antes e Depois',
    campaign: '[TT-TREND] Trend Viral Challenge',
    type: 'video',
    platform: 'TikTok',
    spend: 3800,
    roasReported: 1.8,
    roasReal: 2.6,
    thumb: 'from-cyan-400 to-sky-500',
  },
  {
    id: 'cr-10',
    code: 'TTK-03',
    name: 'Carrossel Catálogo Verão',
    campaign: '[TT-INT] Interesses · Compras Online',
    type: 'carousel',
    platform: 'TikTok',
    spend: 2400,
    roasReported: 2.4,
    roasReal: 3.3,
    thumb: 'from-lime-400 to-emerald-500',
  },
];

const PLATFORM_FILTERS: Array<'Todas' | Platform> = ['Todas', 'Meta', 'Google', 'TikTok'];
const PERIODS = ['7 dias', '30 dias', '90 dias'] as const;
type Period = (typeof PERIODS)[number];

export default function CreativesView(): React.ReactElement {
  const [platform, setPlatform] = useState<'Todas' | Platform>('Todas');
  const [period, setPeriod] = useState<Period>('30 dias');

  const filtered = useMemo<Creative[]>(
    () => (platform === 'Todas' ? CREATIVES : CREATIVES.filter((c) => c.platform === platform)),
    [platform],
  );

  // ---- KPIs agregados (reativos ao filtro) ----
  const kpis = useMemo(() => {
    const totalSpend = filtered.reduce((acc, c) => acc + c.spend, 0);
    const wReported = filtered.reduce((acc, c) => acc + c.spend * c.roasReported, 0);
    const wReal = filtered.reduce((acc, c) => acc + c.spend * c.roasReal, 0);
    const roasReported = totalSpend > 0 ? wReported / totalSpend : 0;
    const roasReal = totalSpend > 0 ? wReal / totalSpend : 0;
    const gapPct = roasReported > 0 ? ((roasReal - roasReported) / roasReported) * 100 : 0;
    return {
      count: filtered.length,
      totalSpend,
      roasReported,
      roasReal,
      gapPct,
    };
  }, [filtered]);

  const maxRoas = useMemo(
    () => Math.max(...filtered.flatMap((c) => [c.roasReported, c.roasReal]), 1),
    [filtered],
  );

  // ---- Dados do gráfico: top 6 por investimento ----
  const chartData = useMemo(
    () =>
      [...filtered]
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 6)
        .map((c) => ({ code: c.code, Reportado: c.roasReported, Real: c.roasReal })),
    [filtered],
  );

  const overreported = filtered.filter((c) => verdictOf(c.roasReported, c.roasReal) === 'superestimado').length;

  return (
    <div id="creatives-view-container" className="space-y-6">
      {/* Header + Toolbar */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-teal-600 text-[10px] font-mono font-bold uppercase tracking-wider">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Creative Analytics · Reportado vs Real</span>
          </div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight mt-1">Desempenho de Criativos</h2>
          <p className="text-xs text-slate-500 mt-1">
            Compare o ROAS que a plataforma reporta com o ROAS real medido pelo Truvo AI Graph e descubra onde o
            investimento está inflado.
          </p>
        </div>

        {/* Filtros */}
        <div className="flex flex-wrap items-center gap-3 self-start lg:self-auto">
          <div className="flex items-center gap-1.5 bg-white p-1.5 rounded-xl border border-slate-100 shadow-xs">
            <Filter className="w-3.5 h-3.5 text-slate-400 ml-1.5 shrink-0" />
            {PLATFORM_FILTERS.map((p) => (
              <button
                key={p}
                onClick={() => setPlatform(p)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                  platform === p
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 bg-white p-1.5 rounded-xl border border-slate-100 shadow-xs">
            <CalendarDays className="w-3.5 h-3.5 text-slate-400 ml-1.5 shrink-0" />
            {PERIODS.map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-bold font-mono transition-all cursor-pointer ${
                  period === p
                    ? 'bg-teal-600 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        {/* Criativos ativos */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">Criativos Ativos</span>
            <span className="w-8 h-8 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-500">
              <Layers className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-3">
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono">{kpis.count}</h3>
            <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1 font-mono">
              <Info className="w-3.5 h-3.5 shrink-0" />
              {overreported} com ROAS superestimado
            </p>
          </div>
        </div>

        {/* Investimento */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">Investimento</span>
            <span className="w-8 h-8 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-500">
              <Wallet className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-3">
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono">{fmtBRL(kpis.totalSpend)}</h3>
            <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1 font-mono">
              <Info className="w-3.5 h-3.5 shrink-0" />
              Mídia paga no período · {period}
            </p>
          </div>
        </div>

        {/* ROAS Reportado */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">ROAS Reportado</span>
            <span className="w-8 h-8 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-400">
              <TrendingUp className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-3">
            <h3 className="text-2xl font-bold text-slate-500 tracking-tight font-mono">{fmtRoas(kpis.roasReported)}</h3>
            <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1 font-mono">
              <Info className="w-3.5 h-3.5 shrink-0" />
              Números das plataformas
            </p>
          </div>
        </div>

        {/* ROAS Real */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs flex flex-col justify-between ring-1 ring-teal-100">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-teal-700 font-mono uppercase tracking-wider">ROAS Real</span>
            <span
              className={`flex items-center gap-0.5 text-[10px] font-bold px-2 py-0.5 rounded-full ${
                kpis.gapPct >= 0 ? 'text-emerald-600 bg-emerald-50' : 'text-rose-600 bg-rose-50'
              }`}
            >
              {kpis.gapPct >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
              {Math.abs(kpis.gapPct).toFixed(1)}%
            </span>
          </div>
          <div className="mt-3">
            <h3 className="text-2xl font-bold text-teal-700 tracking-tight font-mono">{fmtRoas(kpis.roasReal)}</h3>
            <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1 font-mono">
              <Target className="w-3.5 h-3.5 shrink-0" />
              Medido pelo Truvo AI Graph
            </p>
          </div>
        </div>
      </div>

      {/* Gráfico comparativo — top criativos */}
      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">
              Reportado × Real · Top Criativos
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              ROAS por criativo, ordenado por investimento ({filtered.length} criativos · {period})
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono">
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 bg-slate-300 rounded-xs" />
              <span className="text-slate-600 font-medium">Reportado</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 bg-teal-500 rounded-xs" />
              <span className="text-slate-600 font-medium">Real</span>
            </div>
          </div>
        </div>

        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 10, right: 0, left: -20, bottom: 0 }} barGap={4}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis
                dataKey="code"
                stroke="#94a3b8"
                fontSize={10}
                fontFamily="JetBrains Mono"
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="#94a3b8"
                fontSize={10}
                fontFamily="JetBrains Mono"
                tickLine={false}
                axisLine={false}
                tickFormatter={(val: number) => `${val}x`}
              />
              <Tooltip
                cursor={{ fill: '#f8fafc' }}
                formatter={(val) => [`${Number(val).toFixed(2)}x`, '']}
                contentStyle={{
                  backgroundColor: '#ffffff',
                  border: '1px solid #e2e8f0',
                  borderRadius: '12px',
                  fontFamily: 'Inter',
                  fontSize: '11px',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
                }}
              />
              <Bar dataKey="Reportado" fill="#cbd5e1" radius={[6, 6, 0, 0]} barSize={18} />
              <Bar dataKey="Real" fill="#14b8a6" radius={[6, 6, 0, 0]} barSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Tabela grid de criativos */}
      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">Auditoria de Criativos</h3>
            <p className="text-xs text-slate-500 mt-1">
              Veredito por criativo com base no gap entre ROAS reportado e ROAS real
            </p>
          </div>
          <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400 uppercase">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-rose-400" /> Superestimado
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-emerald-500" /> Alinhado
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-teal-500" /> Subestimado
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[880px]">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                <th className="py-3 font-semibold">Criativo / Ad</th>
                <th className="py-3 font-semibold">Plataforma</th>
                <th className="py-3 font-semibold text-right">Investimento</th>
                <th className="py-3 font-semibold text-right">ROAS Reportado</th>
                <th className="py-3 font-semibold text-right">ROAS Real</th>
                <th className="py-3 font-semibold text-center">Gap Reportado × Real</th>
                <th className="py-3 font-semibold text-right">Veredito</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filtered.map((c) => {
                const verdict = verdictOf(c.roasReported, c.roasReal);
                const vMeta = VERDICT_META[verdict];
                const diffPct = c.roasReported > 0 ? ((c.roasReal - c.roasReported) / c.roasReported) * 100 : 0;
                const positive = diffPct >= 0;

                return (
                  <tr key={c.id} className="hover:bg-slate-50/50 transition-colors text-xs text-slate-700">
                    {/* Criativo */}
                    <td className="py-3.5">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-11 h-11 rounded-lg bg-linear-to-br ${c.thumb} flex items-center justify-center text-white shrink-0 shadow-sm relative`}
                        >
                          <TypeIcon type={c.type} className="w-5 h-5" />
                          <span className="absolute -bottom-1 -right-1 bg-white rounded-md px-1 py-0.2 border border-slate-100 text-[7px] font-mono font-bold text-slate-500 uppercase">
                            {c.code}
                          </span>
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-slate-900 truncate max-w-[220px]">{c.name}</span>
                            <span className="px-1.5 py-0.2 bg-slate-50 border border-slate-100 text-slate-500 text-[9px] font-mono rounded-sm uppercase shrink-0">
                              {TYPE_LABEL[c.type]}
                            </span>
                          </div>
                          <span className="text-[10px] text-slate-400 block mt-0.5 truncate max-w-[240px] font-mono">
                            {c.campaign}
                          </span>
                        </div>
                      </div>
                    </td>

                    {/* Plataforma */}
                    <td className="py-3.5">
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-slate-100 text-slate-700">
                        <span className={`w-1.5 h-1.5 rounded-full ${PLATFORM_DOT[c.platform]}`} />
                        {c.platform}
                      </span>
                    </td>

                    {/* Investimento */}
                    <td className="py-3.5 text-right font-semibold text-slate-900 font-mono">{fmtBRL(c.spend)}</td>

                    {/* ROAS Reportado */}
                    <td className="py-3.5 text-right font-mono font-semibold text-slate-500">{fmtRoas(c.roasReported)}</td>

                    {/* ROAS Real */}
                    <td
                      className={`py-3.5 text-right font-mono font-bold ${
                        positive ? 'text-teal-700' : 'text-rose-600'
                      }`}
                    >
                      {fmtRoas(c.roasReal)}
                    </td>

                    {/* Gap dual-bar */}
                    <td className="py-3.5">
                      <div className="w-32 mx-auto space-y-1">
                        <div className="flex items-center gap-1.5">
                          <span className="w-7 text-[8px] font-mono text-slate-400 uppercase shrink-0">Rep</span>
                          <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-slate-300 rounded-full"
                              style={{ width: `${(c.roasReported / maxRoas) * 100}%` }}
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="w-7 text-[8px] font-mono text-slate-400 uppercase shrink-0">Real</span>
                          <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${vMeta.barReal}`}
                              style={{ width: `${(c.roasReal / maxRoas) * 100}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Veredito */}
                    <td className="py-3.5">
                      <div className="flex flex-col items-end gap-1">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase ${vMeta.badge}`}
                        >
                          {vMeta.label}
                        </span>
                        <span
                          className={`flex items-center gap-0.5 text-[10px] font-mono font-bold ${
                            positive ? 'text-emerald-600' : 'text-rose-500'
                          }`}
                        >
                          {positive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                          {positive ? '+' : '−'}
                          {Math.abs(diffPct).toFixed(0)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-xs text-slate-400 font-mono">
                    Nenhum criativo encontrado para o filtro selecionado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Rodapé insight */}
        <div className="mt-4 pt-4 border-t border-slate-50 flex items-center gap-2 text-[11px] text-slate-500">
          <ArrowRight className="w-3.5 h-3.5 text-teal-500 shrink-0" />
          <span>
            <b className="text-slate-700">{overreported} criativos</b> mostram ROAS reportado acima do real — realoque
            verba dos superestimados para os <b className="text-teal-700">subestimados</b> e ganhe eficiência sem subir o
            investimento.
          </span>
        </div>
      </div>
    </div>
  );
}
