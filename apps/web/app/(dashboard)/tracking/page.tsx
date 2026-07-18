'use client';

import { useMemo, useState } from 'react';
import {
  Page,
  Section,
  Toolbar,
  Card,
  StatRow,
  StatTile,
  DataTable,
  Badge,
  Button,
  Input,
  Select,
  AsyncBoundary,
  type Column,
  type BadgeVariant,
} from '@/components/ui';
import { useApi } from '@/lib/use-api';

/**
 * /tracking — modules/tracking + modules/events.
 * (1) snippet do pixel, (2) tracking links (GET /v1/tracking/links),
 * (3) debug view dos últimos eventos (GET /v1/events/recent).
 */

// ─────────────────────────── tipos (best-effort do DTO/service) ───────────────────────────

/** GET /v1/tracking/links → TrackingLinkView[] */
type TrackingLink = {
  id: string;
  code: string;
  destination_url: string;
  label: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  click_count: number;
  active: boolean;
  short_path: string;
  created_at: string;
  updated_at: string;
};

/** GET /v1/events/recent → { events: EventRow[] } (debug view, últimos 50) */
type EventRow = {
  event_id: string;
  event_name: string;
  source: string | null;
  timestamp: string | null;
  received_at: string | null;
  utm_source: string | null;
  utm_campaign: string | null;
  ip_country: string | null;
  ip_city: string | null;
  device_type: string | null;
  value: number | null;
  currency: string | null;
  is_bot: number | boolean | null;
};

// ─────────────────────────── helpers ───────────────────────────

function fmtDateTime(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function isBot(v: EventRow['is_bot']): boolean {
  return v === true || Number(v) === 1;
}

/** Cor de série reservada por origem — sempre acompanhada do label (dataviz: nunca cor só). */
function sourceVariant(source: string | null): BadgeVariant {
  switch ((source ?? '').toLowerCase()) {
    case 'web':
    case 'pixel':
      return 'info';
    case 'shopify':
    case 'stripe':
    case 'hotmart':
    case 'kiwify':
      return 'good';
    case 'server':
    case 'api':
      return 'neutral';
    default:
      return 'neutral';
  }
}

const PIXEL_SNIPPET = `<!-- Truvo Pixel -->
<script>
  (function (w, d, s, u, o) {
    w.TruvoObject = o;
    w[o] = w[o] || function () { (w[o].q = w[o].q || []).push(arguments); };
    var e = d.createElement(s); e.async = 1; e.src = u;
    var f = d.getElementsByTagName(s)[0]; f.parentNode.insertBefore(e, f);
  })(window, document, 'script', 'https://cdn.truvo.io/px.js', 'truvo');

  truvo('init', 'pk_live_XXXXXXXXXXXXXXXXXXXX'); // sua API key (Configurações › API Keys)
  truvo('track', 'page_view');
</script>`;

// ─────────────────────────── página ───────────────────────────

export default function TrackingPage() {
  const linksState = useApi<TrackingLink[]>('/v1/tracking/links');
  const eventsState = useApi<{ events: EventRow[] }>('/v1/events/recent');

  const links = linksState.data ?? [];
  const events = eventsState.data?.events ?? [];

  const [linkQuery, setLinkQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [copied, setCopied] = useState(false);

  const totalClicks = links.reduce((sum, l) => sum + (l.click_count ?? 0), 0);
  const botCount = events.filter((e) => isBot(e.is_bot)).length;

  const filteredLinks = useMemo(() => {
    const q = linkQuery.trim().toLowerCase();
    if (!q) return links;
    return links.filter((l) =>
      [l.code, l.label, l.destination_url, l.utm_campaign]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [links, linkQuery]);

  const sources = useMemo(
    () => Array.from(new Set(events.map((e) => e.source).filter((s): s is string => !!s))).sort(),
    [events],
  );

  const filteredEvents = useMemo(
    () => (sourceFilter ? events.filter((e) => e.source === sourceFilter) : events),
    [events, sourceFilter],
  );

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(PIXEL_SNIPPET);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard indisponível — silencioso */
    }
  };

  const linkColumns: Column<TrackingLink>[] = [
    {
      key: 'code',
      header: 'Código',
      render: (r) => (
        <div>
          <div className="font-mono text-slate-200">{r.code}</div>
          <div className="font-mono text-xs text-slate-600">{r.short_path}</div>
        </div>
      ),
    },
    {
      key: 'destination_url',
      header: 'Destino',
      render: (r) => (
        <div className="max-w-[320px] truncate text-slate-400" title={r.destination_url}>
          {r.destination_url}
        </div>
      ),
    },
    { key: 'utm_campaign', header: 'Campanha', render: (r) => r.utm_campaign ?? '—' },
    {
      key: 'click_count',
      header: 'Cliques',
      align: 'right',
      render: (r) => <span className="tabular-nums text-slate-200">{r.click_count ?? 0}</span>,
    },
    {
      key: 'active',
      header: 'Status',
      render: (r) =>
        r.active ? <Badge variant="good">Ativo</Badge> : <Badge variant="neutral">Inativo</Badge>,
    },
  ];

  const eventColumns: Column<EventRow>[] = [
    {
      key: 'event_name',
      header: 'Evento',
      render: (r) => (
        <span className="flex items-center gap-2">
          <span className="font-mono text-slate-200">{r.event_name}</span>
          {isBot(r.is_bot) ? <Badge variant="critical">bot</Badge> : null}
        </span>
      ),
    },
    {
      key: 'source',
      header: 'Origem',
      render: (r) => <Badge variant={sourceVariant(r.source)}>{r.source ?? 'desconhecida'}</Badge>,
    },
    {
      key: 'utm',
      header: 'UTM',
      render: (r) =>
        r.utm_source || r.utm_campaign ? (
          <span className="text-slate-400">
            {r.utm_source ?? '—'}
            {r.utm_campaign ? ` · ${r.utm_campaign}` : ''}
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'geo',
      header: 'Local',
      render: (r) =>
        r.ip_city || r.ip_country ? (
          <span className="text-slate-400">
            {[r.ip_city, r.ip_country].filter(Boolean).join(', ')}
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'value',
      header: 'Valor',
      align: 'right',
      render: (r) =>
        r.value != null && r.value > 0 ? (
          <span className="tabular-nums text-slate-200">
            {r.value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            <span className="ml-1 text-xs text-slate-500">{r.currency ?? ''}</span>
          </span>
        ) : (
          '—'
        ),
    },
    { key: 'received_at', header: 'Recebido', align: 'right', render: (r) => (
      <span className="whitespace-nowrap text-slate-400">{fmtDateTime(r.received_at)}</span>
    ) },
  ];

  return (
    <Page title="Tracking">
      <StatRow>
        <StatTile label="Links ativos" value={linksState.data ? links.length : '—'} />
        <StatTile
          label="Cliques totais"
          value={linksState.data ? totalClicks.toLocaleString('pt-BR') : '—'}
          hint="soma dos links ativos"
        />
        <StatTile
          label="Eventos (amostra)"
          value={eventsState.data ? events.length : '—'}
          hint="últimos 50 recebidos"
        />
        <StatTile
          label="Bots na amostra"
          value={eventsState.data ? botCount : '—'}
          hint="filtrados das métricas"
        />
      </StatRow>

      <div className="mt-8">
        {/* (1) Snippet do pixel */}
        <Section
          title="Snippet do pixel"
          description="Cole antes de </head> em todas as páginas. Substitua pela API key do workspace."
        >
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
              <span className="font-mono text-xs text-slate-500">index.html</span>
              <Button variant="ghost" onClick={copySnippet}>
                {copied ? '✓ Copiado' : 'Copiar'}
              </Button>
            </div>
            <pre className="overflow-x-auto p-4 text-xs leading-relaxed text-slate-300">
              <code>{PIXEL_SNIPPET}</code>
            </pre>
          </Card>
        </Section>

        {/* (2) Tracking links */}
        <Section
          title="Tracking links"
          description="Links curtos /c/:code com atribuição de cliques e UTMs."
        >
          <Toolbar>
            <Input
              placeholder="Buscar por código, campanha ou destino…"
              value={linkQuery}
              onChange={(e) => setLinkQuery(e.target.value)}
              className="w-72"
            />
            <div className="ml-auto">
              <Button variant="primary">+ Novo link</Button>
            </div>
          </Toolbar>
          <AsyncBoundary state={linksState} emptyHint="Crie o primeiro link curto para rastrear cliques.">
            {() => (
              <DataTable
                columns={linkColumns}
                rows={filteredLinks}
                empty={linkQuery ? 'Nenhum link corresponde à busca.' : 'Nenhum link ainda.'}
              />
            )}
          </AsyncBoundary>
        </Section>

        {/* (3) Debug view */}
        <Section
          title="Debug view"
          description="Fluxo de eventos em tempo (quase) real — para conferir a instrumentação."
        >
          <Toolbar>
            <Select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
              <option value="">Todas as origens</option>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Toolbar>
          <AsyncBoundary state={eventsState} emptyHint="Assim que o pixel disparar, os eventos aparecem aqui.">
            {() => (
              <DataTable
                columns={eventColumns}
                rows={filteredEvents}
                empty="Nenhum evento recebido ainda."
              />
            )}
          </AsyncBoundary>
        </Section>
      </div>
    </Page>
  );
}
