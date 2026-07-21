'use client';

import React, { useMemo, useState } from 'react';
import {
  Sparkles,
  Target,
  Layers,
  DollarSign,
  CheckCircle,
  AlertCircle,
  TrendingUp,
  TrendingDown,
  Percent,
  Users,
  ArrowRight,
  ChevronDown,
  Loader2,
  Send,
  MessageSquare,
  Info,
  Award,
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { useLive } from '@/lib/live';
import { useSession } from '@/lib/session';
import { api } from '@/lib/api';

// ---- Domínio ----------------------------------------------------------------

type Objective = 'roas' | 'cac' | 'ltv' | 'cvr';
type MetricKey = 'cvr' | 'roas' | 'cac' | 'revenue';

interface Journey {
  path: string[];
  people: number;
  cvr: number;
  roas: number;
  cac: number;
  revenue: number;
}

interface ObjectiveConfig {
  id: Objective;
  label: string;
  short: string;
  metric: MetricKey;
  recon: number;
  journeys: Journey[];
}

interface AiInsight {
  headline: string;
  narrative: string;
  actions: string[];
}

// ---- Formatação pt-BR --------------------------------------------------------

const brl = (n: number): string =>
  n.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

const brl2 = (n: number): string =>
  n.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const num = (n: number): string => n.toLocaleString('pt-BR');

const metricValue = (j: Journey, k: MetricKey): number =>
  k === 'cvr' ? j.cvr : k === 'roas' ? j.roas : k === 'cac' ? j.cac : j.revenue;

const formatMetric = (k: MetricKey, v: number): string =>
  k === 'cvr' ? `${v.toFixed(1)}%` : k === 'roas' ? `${v.toFixed(1)}x` : k === 'cac' ? brl2(v) : brl(v);

const METRIC_LABEL: Record<MetricKey, string> = {
  cvr: 'CVR',
  roas: 'ROAS',
  cac: 'CAC',
  revenue: 'Receita',
};

// ---- Mock: melhores jornadas por objetivo -----------------------------------

const OBJECTIVES: ObjectiveConfig[] = [
  {
    id: 'roas',
    label: 'Maximizar ROAS',
    short: 'ROAS',
    metric: 'roas',
    recon: 94,
    journeys: [
      { path: ['Email/Klaviyo', 'WhatsApp', 'Direto'], people: 3120, cvr: 12.4, roas: 8.7, cac: 14.2, revenue: 214800 },
      { path: ['Google Search', 'Email/Klaviyo', 'Direto'], people: 5240, cvr: 9.1, roas: 6.2, cac: 22.5, revenue: 298400 },
      { path: ['Meta Ads', 'Email/Klaviyo', 'Direto'], people: 8420, cvr: 6.8, roas: 4.9, cac: 29.8, revenue: 341200 },
      { path: ['Google Search', 'Meta Ads', 'WhatsApp'], people: 4610, cvr: 5.4, roas: 4.1, cac: 34.1, revenue: 187500 },
      { path: ['TikTok Ads', 'Google Search', 'Direto'], people: 6730, cvr: 4.2, roas: 3.3, cac: 41.6, revenue: 156900 },
      { path: ['YouTube Ads', 'Meta Ads', 'Email/Klaviyo'], people: 3980, cvr: 3.6, roas: 2.7, cac: 48.9, revenue: 121400 },
    ],
  },
  {
    id: 'cac',
    label: 'Minimizar CAC',
    short: 'CAC',
    metric: 'cac',
    recon: 91,
    journeys: [
      { path: ['Orgânico', 'Google Search', 'Direto'], people: 4870, cvr: 7.9, roas: 5.1, cac: 9.8, revenue: 168300 },
      { path: ['Email/Klaviyo', 'WhatsApp', 'Direto'], people: 3120, cvr: 12.4, roas: 8.7, cac: 14.2, revenue: 214800 },
      { path: ['WhatsApp', 'Direto'], people: 2210, cvr: 15.1, roas: 7.2, cac: 17.4, revenue: 132600 },
      { path: ['Google Search', 'Email/Klaviyo', 'Direto'], people: 5240, cvr: 9.1, roas: 6.2, cac: 22.5, revenue: 298400 },
      { path: ['Meta Ads', 'Email/Klaviyo', 'Direto'], people: 8420, cvr: 6.8, roas: 4.9, cac: 29.8, revenue: 341200 },
      { path: ['TikTok Ads', 'WhatsApp', 'Direto'], people: 3560, cvr: 5.6, roas: 3.8, cac: 33.2, revenue: 128700 },
    ],
  },
  {
    id: 'ltv',
    label: 'Maximizar LTV',
    short: 'LTV',
    metric: 'revenue',
    recon: 78,
    journeys: [
      { path: ['LinkedIn Ads', 'Email/Klaviyo', 'Direto'], people: 2140, cvr: 8.4, roas: 3.6, cac: 88.4, revenue: 412600 },
      { path: ['Meta Ads', 'Email/Klaviyo', 'WhatsApp'], people: 8420, cvr: 6.8, roas: 4.2, cac: 31.2, revenue: 356800 },
      { path: ['Google Search', 'Email/Klaviyo', 'Direto'], people: 5240, cvr: 9.1, roas: 5.4, cac: 24.8, revenue: 312500 },
      { path: ['YouTube Ads', 'Google Search', 'Email/Klaviyo'], people: 4380, cvr: 5.2, roas: 3.1, cac: 46.7, revenue: 224700 },
      { path: ['TikTok Ads', 'Meta Ads', 'WhatsApp'], people: 6730, cvr: 4.6, roas: 2.9, cac: 52.3, revenue: 198400 },
      { path: ['Meta Ads', 'Google Search', 'Direto'], people: 7120, cvr: 4.1, roas: 2.6, cac: 58.9, revenue: 176200 },
    ],
  },
  {
    id: 'cvr',
    label: 'Maximizar CVR',
    short: 'CVR',
    metric: 'cvr',
    recon: 96,
    journeys: [
      { path: ['WhatsApp', 'Direto'], people: 2210, cvr: 15.1, roas: 7.2, cac: 17.4, revenue: 132600 },
      { path: ['Email/Klaviyo', 'WhatsApp', 'Direto'], people: 3120, cvr: 12.4, roas: 8.7, cac: 14.2, revenue: 214800 },
      { path: ['Google Search', 'Email/Klaviyo', 'Direto'], people: 5240, cvr: 9.1, roas: 6.2, cac: 22.5, revenue: 298400 },
      { path: ['Orgânico', 'Google Search', 'Direto'], people: 4870, cvr: 7.9, roas: 5.1, cac: 9.8, revenue: 168300 },
      { path: ['Meta Ads', 'Email/Klaviyo', 'Direto'], people: 8420, cvr: 6.8, roas: 4.9, cac: 29.8, revenue: 341200 },
      { path: ['TikTok Ads', 'Google Search', 'Direto'], people: 6730, cvr: 4.2, roas: 3.3, cac: 41.6, revenue: 156900 },
    ],
  },
];

const AI_INSIGHT: Record<Objective, AiInsight> = {
  roas: {
    headline: 'Jornadas iniciadas por e-mail e nutridas via WhatsApp entregam o maior retorno.',
    narrative:
      'A combinação Email/Klaviyo → WhatsApp → Direto converte a um ROAS de 8,7x — cerca de 3,2x acima da média da conta. O grafo Truvo identifica que o WhatsApp atua como acelerador de decisão nas 48h finais, encurtando o ciclo de compra e reduzindo o custo incremental por conversão.',
    actions: [
      'Realoque 15–20% do orçamento de prospecção fria para fluxos de retenção com gatilho de WhatsApp.',
      'Crie automação de WhatsApp disparada 24h após o opt-in de e-mail para capturar a janela de maior intenção.',
      'Use Google Search como reforço de meio de funil — ele aparece na 2ª melhor jornada, com ROAS de 6,2x.',
    ],
  },
  cac: {
    headline: 'Tráfego orgânico ancorado em busca reduz o custo de aquisição pela metade.',
    narrative:
      'A jornada Orgânico → Google Search → Direto adquire clientes a R$ 9,80 — o menor CAC reconciliado da conta. O modelo mostra que o conteúdo orgânico pré-qualifica a intenção, deixando à mídia paga apenas o papel de fechamento.',
    actions: [
      'Priorize investimento em SEO e conteúdo de fundo de funil para alimentar essa jornada.',
      'Direcione campanhas de Search para termos de marca e alta intenção, evitando concorrência cara de topo.',
      'O fluxo direto de WhatsApp (R$ 17,40) é a alternativa mais barata quando o orgânico satura.',
    ],
  },
  ltv: {
    headline: 'Aquisições B2B via LinkedIn sustentam o maior valor de ciclo de vida.',
    narrative:
      'Apesar do CAC mais alto (R$ 88,40), a jornada LinkedIn Ads → Email/Klaviyo → Direto gera a maior receita reconciliada por coorte, com forte recompra. A reconciliação desta visão está em 78%, então trate os números de LTV como direcionais.',
    actions: [
      'Mantenha investimento em LinkedIn mesmo com CAC elevado — o payback ocorre no 2º ciclo.',
      'Reforce a nutrição por e-mail no pós-conversão para maximizar recompra e expansão.',
      'Conecte os dados de assinatura/faturamento para elevar a confiança da estimativa de LTV.',
    ],
  },
  cvr: {
    headline: 'Contato direto por WhatsApp é a rota de maior taxa de conversão.',
    narrative:
      'A jornada WhatsApp → Direto converte a 15,1% — mais que o dobro da média da conta. O atendimento conversacional remove objeções em tempo real, elevando a CVR sem depender de novos cliques pagos.',
    actions: [
      'Escale o canal de WhatsApp com time/automação para não limitar o volume dessa jornada.',
      'Adicione um passo opcional de WhatsApp no checkout das jornadas pagas para elevar a CVR agregada.',
      'Combine com nutrição por e-mail (jornada #2, 12,4%) para capturar quem não responde de imediato.',
    ],
  },
};

// ---- Q&A mock ---------------------------------------------------------------

interface AiAnswer {
  q: string;
  text: string;
  confident: boolean;
}

function answerFor(raw: string): { text: string; confident: boolean } {
  const q = raw.toLowerCase();
  if (/roas|retorno/.test(q))
    return {
      text: 'As jornadas de maior ROAS terminam em canais próprios: Email/Klaviyo → WhatsApp → Direto rende 8,7x, contra ~3,4x da média da conta. O grafo Truvo credita cerca de 35% desse retorno ao WhatsApp como acelerador de decisão nas 48h finais.',
      confident: true,
    };
  if (/cac|custo|barat/.test(q))
    return {
      text: 'O menor CAC vem de Orgânico → Google Search → Direto: R$ 9,80 por cliente. O conteúdo orgânico pré-qualifica a intenção e deixa à mídia paga só o fechamento. A alternativa mais barata em mídia é o fluxo direto de WhatsApp (R$ 17,40).',
      confident: true,
    };
  if (/whats/.test(q))
    return {
      text: 'O WhatsApp aparece em 4 das 6 melhores jornadas. Como último toque, converte a 15,1% (WhatsApp → Direto). Como toque intermediário, encurta o ciclo e reduz o CAC incremental. Recomendo escalar automação para não limitar o volume.',
      confident: true,
    };
  if (/tiktok/.test(q))
    return {
      text: 'O TikTok raramente é o último clique, então modelos de último toque o subavaliam. No grafo Truvo ele inicia jornadas que fecham via Search e Direto, com ROAS de 3,3x — positivo, mas abaixo dos canais próprios. Mantenha como descoberta, não como fechamento.',
      confident: true,
    };
  if (/email|e-mail|klaviyo/.test(q))
    return {
      text: 'E-mail (Klaviyo) é o motor de retenção das melhores jornadas: presente em 4 das 6 rotas de topo e responsável por elevar o ROAS médio quando combinado com WhatsApp. Melhor uso: nutrição disparada 24h após o opt-in.',
      confident: true,
    };
  if (/meta|facebook|instagram/.test(q))
    return {
      text: 'Meta Ads é forte em volume (8,4 mil pessoas na jornada Meta → Email → Direto, R$ 341 mil), mas seu ROAS isolado (4,9x) fica atrás dos canais próprios. Vale como topo/meio de funil, com o fechamento delegado a e-mail e WhatsApp.',
      confident: true,
    };
  if (/ltv|linkedin|b2b|recompra|assinatura/.test(q))
    return {
      text: 'A maior receita por coorte vem de LinkedIn → Email → Direto, com forte recompra. Atenção: a reconciliação desta visão está em 78%, então trate o LTV como direcional até conectar os dados de assinatura/faturamento.',
      confident: false,
    };
  return {
    text: 'Ainda não tenho sinal reconciliado suficiente para responder isso com precisão. Posso comparar jornadas por ROAS, CAC, CVR ou receita, ou detalhar o papel de um canal (Meta, Google, TikTok, WhatsApp, e-mail). Reformule mencionando um objetivo ou canal.',
    confident: false,
  };
}

const SUGGESTIONS: string[] = [
  'Qual jornada tem o melhor ROAS?',
  'Como reduzir o CAC?',
  'Onde o WhatsApp mais ajuda?',
  'O TikTok vale o investimento?',
];

// ---- API real (M9 · AI Journeys) --------------------------------------------
// Formas do contrato /v1/ai/journeys/best e /v1/ai/ask. Atenção aos nomes:
// `persons` (≠ people) e `attributed_revenue` (≠ revenue).

interface ApiBestChannel {
  rank: number;
  channel: string;
  persons: number;
  converters: number;
  conversions: number;
  cvr: number;
  roas: number;
  cac: number;
  attributed_revenue: number;
  goal_score: number;
}
interface ApiTopJourney {
  path: string[];
  conversions: number;
  revenue: number;
}
interface ApiReconciliation {
  truvo_revenue: number;
  gateway_revenue: number;
  reconciliation_gap: number;
  status: 'reconciled' | 'uncertain' | 'no_ground_truth';
}
interface AiJourneysResponse {
  goal: string;
  window: string;
  reconciliation: ApiReconciliation;
  best_channels: ApiBestChannel[];
  top_journeys: ApiTopJourney[];
  anomalies: unknown[];
}
interface AskResponse {
  answer: string;
  uncertain: boolean;
  status: string;
}

/** Objective (UI) → goal (contrato do endpoint). */
const GOAL_PARAM: Record<Objective, string> = {
  roas: 'maximize_roas',
  cac: 'minimize_cac',
  ltv: 'maximize_ltv',
  cvr: 'maximize_cvr',
};

/** best_channels → Journey[] (cada canal vira uma "rota" de 1 toque na tabela). */
function adaptChannels(data: AiJourneysResponse): Journey[] {
  return (data?.best_channels ?? []).map((c) => ({
    path: [c?.channel ?? '—'],
    people: c?.persons ?? 0,
    cvr: c?.cvr ?? 0,
    roas: c?.roas ?? 0,
    cac: c?.cac ?? 0,
    revenue: c?.attributed_revenue ?? 0,
  }));
}

/**
 * Jornada campeã: caminho real de `top_journeys[0]` (as chips de jornada);
 * persons/cvr/roas/cac vêm do canal #1 como proxy, pois `top_journeys` só
 * traz path/conversions/revenue. // TODO(live)
 */
function adaptTopJourney(data: AiJourneysResponse): Journey | undefined {
  const tj = data?.top_journeys?.[0];
  const top = data?.best_channels?.[0];
  if (!tj && !top) return undefined;
  return {
    path: tj?.path ?? (top?.channel ? [top.channel] : []),
    people: top?.persons ?? tj?.conversions ?? 0,
    cvr: top?.cvr ?? 0,
    roas: top?.roas ?? 0,
    cac: top?.cac ?? 0,
    revenue: tj?.revenue ?? top?.attributed_revenue ?? 0,
  };
}

/** reconciliation → % de match (0–100). Sem gateway ⇒ sem ground truth. */
function reconPct(r?: ApiReconciliation): number {
  const gw = r?.gateway_revenue ?? 0;
  const tv = r?.truvo_revenue ?? 0;
  if (gw > 0) {
    const match = 1 - Math.abs(gw - tv) / gw;
    return Math.max(0, Math.min(100, Math.round(match * 100)));
  }
  return r?.status === 'reconciled' ? 100 : r?.status === 'uncertain' ? 60 : 0;
}

// ---- Componentes auxiliares -------------------------------------------------

function PathChips({ path, dark = false }: { path: string[]; dark?: boolean }): React.ReactElement {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {path.map((c, i) => (
        <React.Fragment key={`${c}-${i}`}>
          {i > 0 && (
            <ArrowRight className={`w-3 h-3 shrink-0 ${dark ? 'text-slate-600' : 'text-slate-300'}`} />
          )}
          <span
            className={`rounded-md font-mono whitespace-nowrap border ${
              dark
                ? `px-2.5 py-1 text-[11px] ${
                    i === 0
                      ? 'bg-teal-500/15 text-teal-300 border-teal-500/30'
                      : 'bg-slate-800/70 text-slate-200 border-slate-700'
                  }`
                : `px-2 py-0.5 text-[10px] ${
                    i === 0
                      ? 'bg-teal-50 text-teal-700 border-teal-100'
                      : 'bg-slate-50 text-slate-600 border-slate-100'
                  }`
            }`}
          >
            {c}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

interface TipProps {
  active?: boolean;
  payload?: Array<{ payload: { name: string; value: number; path: string } }>;
  metric: MetricKey;
}

function ChartTip({ active, payload, metric }: TipProps): React.ReactElement | null {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-xl px-3 py-2 shadow-md">
      <div className="text-[10px] font-mono text-slate-400">{p.name}</div>
      <div className="text-[11px] text-slate-700 font-medium mt-0.5">{p.path}</div>
      <div className="text-xs font-bold text-teal-600 font-mono mt-1">{formatMetric(metric, p.value)}</div>
    </div>
  );
}

// ---- View -------------------------------------------------------------------

export default function AiView(): React.ReactElement {
  const { isLive } = useSession();

  const [selected, setSelected] = useState<Objective>('roas');
  const [active, setActive] = useState<Objective>('roas');
  const [analyzing, setAnalyzing] = useState(false);

  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AiAnswer | null>(null);

  // Live (API real M9): refaz quando o goal muda (clique em Analisar → setActive).
  // Em modo demo useLive retorna null → tudo cai no mock existente (fallback).
  const live = useLive<AiJourneysResponse>(
    `/v1/ai/journeys/best?goal=${GOAL_PARAM[active]}&limit=10`,
    [active],
  );

  const mockCfg = OBJECTIVES.find((o) => o.id === active) ?? OBJECTIVES[0];
  // Real quando 'live'; senão o mock existente. A narrativa (headline/ações do
  // card escuro) fica no mock — o contrato não devolve texto gerado. // TODO(live)
  const cfg: ObjectiveConfig = live.data
    ? {
        id: mockCfg.id,
        label: mockCfg.label,
        short: mockCfg.short,
        metric: mockCfg.metric,
        recon: reconPct(live.data.reconciliation),
        journeys: adaptChannels(live.data),
      }
    : mockCfg;

  const insight = AI_INSIGHT[cfg.id];
  const topJourney = live.data ? adaptTopJourney(live.data) : cfg.journeys[0];
  const confident = cfg.recon >= 90;

  const channelCount = useMemo(() => {
    const set = new Set<string>();
    cfg.journeys.forEach((j) => j.path.forEach((c) => set.add(c)));
    return set.size;
  }, [cfg]);

  const totalRevenue = useMemo(
    () => cfg.journeys.reduce((acc, j) => acc + j.revenue, 0),
    [cfg],
  );

  const chartData = useMemo(
    () =>
      cfg.journeys.slice(0, 5).map((j, i) => ({
        name: `#${i + 1}`,
        value: metricValue(j, cfg.metric),
        path: j.path.join(' → '),
      })),
    [cfg],
  );

  const runAnalysis = (): void => {
    setAnalyzing(true);
    window.setTimeout(() => {
      setActive(selected);
      setAnalyzing(false);
    }, 850);
  };

  const ask = async (q: string): Promise<void> => {
    // Demo (ou sem sessão live) → resposta mock local (fallback).
    if (!isLive) {
      setAnswer({ q, ...answerFor(q) });
      return;
    }
    try {
      const res = await api<AskResponse>('/v1/ai/ask', {
        method: 'POST',
        body: JSON.stringify({ question: q }),
      });
      setAnswer({ q, text: res?.answer ?? '', confident: !(res?.uncertain ?? false) });
    } catch {
      // 503/erro (ex.: sem ANTHROPIC_API_KEY) → aviso gracioso no mesmo card.
      setAnswer({
        q,
        text: 'A análise generativa da Truvo AI está indisponível no momento. Consulte o ranking de canais e o comparativo acima — eles seguem com os dados reconciliados das suas jornadas.',
        confident: false,
      });
    }
  };

  const handleAsk = (e?: React.FormEvent): void => {
    e?.preventDefault();
    const q = question.trim();
    if (!q) return;
    void ask(q);
  };

  const askSuggestion = (q: string): void => {
    setQuestion(q);
    void ask(q);
  };

  const cellCls = (k: MetricKey): string => (cfg.metric === k ? 'text-teal-700 font-bold' : '');
  const headCls = (k: MetricKey): string => (cfg.metric === k ? 'text-teal-600' : '');

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-teal-600 text-[10px] font-mono font-bold uppercase tracking-wider">
            <Sparkles className="w-3.5 h-3.5" />
            <span>AI Journeys</span>
          </div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight mt-1">
            Melhores jornadas de conversão
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            O grafo Truvo AI reconstrói o caminho multi-toque de cada cliente e ranqueia as rotas que mais
            entregam para o seu objetivo.
          </p>
        </div>

        <div className="flex items-center gap-2 self-start md:self-auto">
          <div className="relative">
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value as Objective)}
              className="appearance-none pl-3 pr-9 py-2 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-400 cursor-pointer transition-all"
            >
              {OBJECTIVES.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <ChevronDown className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>

          <button
            onClick={runAnalysis}
            disabled={analyzing}
            className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all disabled:opacity-70 cursor-pointer shadow-xs"
          >
            {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            <span>{analyzing ? 'Analisando…' : 'Analisar'}</span>
          </button>
        </div>
      </div>

      {/* Resultados */}
      <div className={`space-y-6 transition-opacity duration-300 ${analyzing ? 'opacity-50' : 'opacity-100'}`}>
        {/* KPI row */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          {/* Objetivo atual */}
          <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">
                Objetivo atual
              </span>
              <Target className="w-4 h-4 text-teal-500" />
            </div>
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono mt-3">{cfg.short}</h3>
            <p className="text-[10px] text-slate-400 mt-1 font-mono">{cfg.label}</p>
          </div>

          {/* Canais analisados */}
          <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">
                Canais analisados
              </span>
              <Layers className="w-4 h-4 text-slate-400" />
            </div>
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono mt-3">{channelCount}</h3>
            <p className="text-[10px] text-slate-400 mt-1 font-mono">Rastreados no grafo Truvo</p>
          </div>

          {/* Receita reconciliada */}
          <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">
                Receita reconciliada
              </span>
              <DollarSign className="w-4 h-4 text-emerald-500" />
            </div>
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono mt-3">{brl(totalRevenue)}</h3>
            <p className="text-[10px] text-slate-400 mt-1 font-mono">Atribuída às melhores jornadas</p>
          </div>

          {/* Reconciliação */}
          <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">
                Reconciliação
              </span>
              {confident ? (
                <CheckCircle className="w-4 h-4 text-emerald-500" />
              ) : (
                <AlertCircle className="w-4 h-4 text-amber-500" />
              )}
            </div>
            <div className="flex items-center gap-2 mt-3">
              <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono">{cfg.recon}%</h3>
              <span
                className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase ${
                  confident ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                }`}
              >
                {confident ? 'Confiável' : 'Atenção'}
              </span>
            </div>
            <p className="text-[10px] text-slate-400 mt-1 font-mono">Match vs. plataformas de anúncio</p>
          </div>
        </div>

        {/* Card escuro de destaque — Truvo AI */}
        <div className="bg-slate-900 text-slate-100 rounded-2xl p-6 border border-slate-800 shadow-md relative overflow-hidden">
          <div className="absolute -top-8 -right-8 w-48 h-48 bg-teal-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute bottom-0 left-1/3 w-40 h-40 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none" />

          <div className="relative">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 text-teal-400">
                <Sparkles className="w-5 h-5" />
                <span className="text-xs font-bold uppercase tracking-wider font-mono">Truvo AI · Journey Intelligence</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase bg-slate-800 text-slate-300 border border-slate-700">
                  Beta
                </span>
                <span
                  className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase ${
                    confident ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
                  }`}
                >
                  {confident ? 'Alta confiança' : 'Incerto'}
                </span>
              </div>
            </div>

            <h3 className="text-lg font-bold text-white tracking-tight mt-4 max-w-3xl leading-snug">
              {insight.headline}
            </h3>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 mt-5">
              {/* Jornada campeã + narrativa */}
              <div className="lg:col-span-7 space-y-4">
                <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
                  <div className="flex items-center gap-2 text-[9px] font-mono uppercase text-slate-400 mb-2.5">
                    <Award className="w-3.5 h-3.5 text-teal-400" />
                    <span>Jornada campeã · rank #1</span>
                  </div>
                  {topJourney && <PathChips path={topJourney.path} dark />}
                  {topJourney && (
                    <div className="grid grid-cols-3 gap-3 mt-4">
                      <div>
                        <span className="text-[9px] font-mono uppercase text-slate-500 block">Pessoas</span>
                        <span className="text-sm font-bold text-white font-mono">{num(topJourney.people)}</span>
                      </div>
                      <div>
                        <span className="text-[9px] font-mono uppercase text-slate-500 block">{METRIC_LABEL[cfg.metric]}</span>
                        <span className="text-sm font-bold text-teal-300 font-mono">
                          {formatMetric(cfg.metric, metricValue(topJourney, cfg.metric))}
                        </span>
                      </div>
                      <div>
                        <span className="text-[9px] font-mono uppercase text-slate-500 block">Receita</span>
                        <span className="text-sm font-bold text-white font-mono">{brl(topJourney.revenue)}</span>
                      </div>
                    </div>
                  )}
                </div>

                <p className="text-[13px] text-slate-300 leading-relaxed">{insight.narrative}</p>
              </div>

              {/* Ações recomendadas */}
              <div className="lg:col-span-5">
                <div className="flex items-center gap-1.5 text-teal-300 mb-3">
                  <TrendingUp className="w-3.5 h-3.5" />
                  <span className="text-[10px] font-mono font-bold uppercase tracking-wider">Ações recomendadas</span>
                </div>
                <ul className="space-y-2.5">
                  {insight.actions.map((a, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-[12px] text-slate-300 leading-relaxed">
                      <span className="mt-0.5 w-4 h-4 shrink-0 rounded-md bg-teal-500/15 text-teal-300 text-[9px] font-mono font-bold flex items-center justify-center">
                        {i + 1}
                      </span>
                      <span>{a}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="mt-5 pt-4 border-t border-slate-800 text-[10px] text-slate-500 leading-relaxed flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>
                Insights gerados pelo modelo de atribuição Truvo AI Graph com {cfg.recon}% de reconciliação vs.
                plataformas. Recomendações são direcionais — valide antes de realocar orçamento.
              </span>
            </div>
          </div>
        </div>

        {/* Ranking de jornadas */}
        <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-xs">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div>
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">
                Ranking das melhores jornadas
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                Rotas multi-toque ordenadas por desempenho para <b className="text-slate-700">{cfg.label}</b>.
              </p>
            </div>
            <span className="text-[10px] font-mono text-slate-400 bg-slate-50 border border-slate-100 px-2.5 py-1 rounded-lg">
              Ordenado por {METRIC_LABEL[cfg.metric]}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[860px]">
              <thead>
                <tr className="border-b border-slate-100 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                  <th className="py-3 font-semibold">Rank</th>
                  <th className="py-3 font-semibold">Canal</th>
                  <th className="py-3 font-semibold">Jornada</th>
                  <th className="py-3 font-semibold text-right">Pessoas</th>
                  <th className={`py-3 font-semibold text-right ${headCls('cvr')}`}>CVR</th>
                  <th className={`py-3 font-semibold text-right ${headCls('roas')}`}>ROAS</th>
                  <th className={`py-3 font-semibold text-right ${headCls('cac')}`}>CAC</th>
                  <th className={`py-3 font-semibold text-right ${headCls('revenue')}`}>Receita</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {cfg.journeys.map((j, idx) => {
                  const rank = idx + 1;
                  return (
                    <tr
                      key={`${cfg.id}-${idx}`}
                      className={`transition-colors text-xs text-slate-700 ${
                        rank === 1 ? 'bg-teal-50/30' : 'hover:bg-slate-50/50'
                      }`}
                    >
                      <td className="py-3.5">
                        <span
                          className={`inline-flex items-center justify-center w-6 h-6 rounded-lg text-[10px] font-mono font-bold ${
                            rank === 1
                              ? 'bg-teal-600 text-white'
                              : rank <= 3
                                ? 'bg-teal-50 text-teal-700 border border-teal-100'
                                : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          {rank}
                        </span>
                      </td>
                      <td className="py-3.5">
                        <span className="text-xs font-semibold text-slate-800">{j.path[0] ?? '—'}</span>
                      </td>
                      <td className="py-3.5">
                        <PathChips path={j.path} />
                      </td>
                      <td className="py-3.5 text-right font-mono text-slate-600">{num(j.people)}</td>
                      <td className={`py-3.5 text-right font-mono ${cellCls('cvr') || 'text-slate-700'}`}>
                        {j.cvr.toFixed(1)}%
                      </td>
                      <td
                        className={`py-3.5 text-right font-mono ${
                          cfg.metric === 'roas' ? 'text-teal-700 font-bold' : 'text-emerald-600 font-semibold'
                        }`}
                      >
                        {j.roas.toFixed(1)}x
                      </td>
                      <td className={`py-3.5 text-right font-mono ${cellCls('cac') || 'text-slate-700'}`}>
                        {brl2(j.cac)}
                      </td>
                      <td
                        className={`py-3.5 text-right font-mono font-semibold ${
                          cfg.metric === 'revenue' ? 'text-teal-700' : 'text-slate-900'
                        }`}
                      >
                        {brl(j.revenue)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Comparativo + Pergunte à IA */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Chart */}
          <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-xs lg:col-span-7">
            <div className="mb-5">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">
                Comparativo das melhores jornadas
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                Top 5 rotas por {METRIC_LABEL[cfg.metric]}
                {cfg.metric === 'cac' ? ' (quanto menor, melhor)' : ''}.
              </p>
            </div>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 10, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                  <XAxis
                    dataKey="name"
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
                    tickFormatter={(v: number) =>
                      cfg.metric === 'revenue'
                        ? `${Math.round(v / 1000)}k`
                        : cfg.metric === 'roas'
                          ? `${v}x`
                          : cfg.metric === 'cvr'
                            ? `${v}%`
                            : `${v}`
                    }
                  />
                  <Tooltip
                    cursor={{ fill: '#f8fafc' }}
                    content={(props) => <ChartTip {...(props as unknown as TipProps)} metric={cfg.metric} />}
                  />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]} barSize={44}>
                    {chartData.map((_, i) => (
                      <Cell key={i} fill={i === 0 ? '#0f766e' : '#14b8a6'} fillOpacity={i === 0 ? 1 : 0.8} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Pergunte sobre as jornadas */}
          <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-xs lg:col-span-5 flex flex-col">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2 text-slate-800">
                <MessageSquare className="w-4 h-4 text-teal-600" />
                <h3 className="text-xs font-bold uppercase tracking-wider font-mono">Pergunte sobre as jornadas</h3>
              </div>
              <span className="px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase bg-slate-100 text-slate-600">
                Beta
              </span>
            </div>
            <p className="text-xs text-slate-500 mb-4">
              Pergunte em linguagem natural sobre canais, custo e retorno das rotas.
            </p>

            <form onSubmit={handleAsk} className="flex items-center gap-2">
              <input
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ex.: qual canal reduz meu CAC?"
                className="flex-1 min-w-0 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-400 transition-all"
              />
              <button
                type="submit"
                className="px-3 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all shrink-0 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Perguntar</span>
              </button>
            </form>

            <div className="flex flex-wrap gap-1.5 mt-3">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => askSuggestion(s)}
                  className="px-2.5 py-1 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 text-slate-600 rounded-lg text-[10px] font-medium transition-all cursor-pointer"
                >
                  {s}
                </button>
              ))}
            </div>

            {answer ? (
              <div className="mt-4 flex-1 flex flex-col">
                <div className="text-[10px] font-mono text-slate-400 uppercase mb-2">Você perguntou</div>
                <div className="text-xs text-slate-600 bg-slate-50 border border-slate-100 rounded-xl px-3 py-2 mb-3">
                  {answer.q}
                </div>

                <div className="bg-slate-900 text-slate-100 rounded-xl p-4 border border-slate-800 relative overflow-hidden">
                  <div className="absolute -top-6 -right-6 w-24 h-24 bg-teal-500/10 rounded-full blur-2xl pointer-events-none" />
                  <div className="relative">
                    <div className="flex items-center justify-between mb-2.5">
                      <div className="flex items-center gap-1.5 text-teal-400">
                        <Sparkles className="w-3.5 h-3.5" />
                        <span className="text-[10px] font-mono font-bold uppercase tracking-wider">Truvo AI</span>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase ${
                          answer.confident ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
                        }`}
                      >
                        {answer.confident ? 'Alta confiança' : 'Incerto'}
                      </span>
                    </div>
                    <p className="text-[12px] text-slate-300 leading-relaxed">{answer.text}</p>
                    {!answer.confident && (
                      <div className="mt-3 pt-2.5 border-t border-slate-800 text-[10px] text-amber-300/80 flex items-start gap-1.5 leading-relaxed">
                        <AlertCircle className="w-3 h-3 shrink-0 mt-px" />
                        <span>Resposta com baixa reconciliação de dados — valide antes de agir.</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-4 flex-1 flex flex-col items-center justify-center text-center py-6 rounded-xl border border-dashed border-slate-200 bg-slate-50/40">
                <MessageSquare className="w-6 h-6 text-slate-300 mb-2" />
                <p className="text-[11px] text-slate-400 max-w-[220px]">
                  Faça uma pergunta ou escolha uma sugestão para ver a análise da Truvo AI sobre suas jornadas.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
