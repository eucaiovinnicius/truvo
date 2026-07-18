'use client';

import { useState } from 'react';
import {
  AsyncBoundary,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  Section,
  Select,
  StatRow,
  StatTile,
  Page,
  type Column,
} from '@/components/ui';
import { useApi } from '@/lib/use-api';

// ─────────────────────────── tipos (best-effort do controller M15) ───────────────────────────
// GET /v1/profiles/search?q=&type= → { query, results: ProfileCandidate[] }

const SEARCH_TYPES = [
  { value: 'email_hash', label: 'E-mail (hash)' },
  { value: 'phone_hash', label: 'Telefone (hash)' },
  { value: 'user_id', label: 'User ID' },
  { value: 'anonymous_id', label: 'Anonymous ID' },
  { value: 'order_id', label: 'Order ID' },
] as const;

type SearchType = (typeof SEARCH_TYPES)[number]['value'];

type ProfileMetrics = {
  ltv: number;
  orders_count: number;
  aov: number;
  sessions_count: number;
  events_count: number;
  days_since_first_touch: number;
  currency: string;
};

type ProfileCandidate = {
  canonical_id: string;
  status: 'anonymous' | 'identified';
  email_hash: string | null;
  phone_hash: string | null;
  anonymous_ids_count: number;
  metrics: ProfileMetrics | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
};

type SearchResponse = {
  query: { type: string };
  results: ProfileCandidate[];
};

// linha placeholder da timeline (sem dados até a infra subir)
type TimelineRow = {
  timestamp: string;
  event_name: string;
  source: string;
  value: string;
};

export default function ProfilesPage() {
  const [draftQ, setDraftQ] = useState('');
  const [draftType, setDraftType] = useState<SearchType>('user_id');
  // consulta efetivada (dispara o fetch). null = ainda não buscou.
  const [query, setQuery] = useState<{ q: string; type: SearchType } | null>(null);

  const path = query
    ? `/v1/profiles/search?q=${encodeURIComponent(query.q)}&type=${query.type}`
    : null;
  const state = useApi<SearchResponse>(path);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = draftQ.trim();
    if (!q) return;
    setQuery({ q, type: draftType });
  }

  const timelineColumns: Column<TimelineRow>[] = [
    { key: 'timestamp', header: 'Data/hora' },
    { key: 'event_name', header: 'Evento' },
    { key: 'source', header: 'Origem' },
    { key: 'value', header: 'Valor', align: 'right' },
  ];

  return (
    <Page title="Perfis (User 360)">
      <form onSubmit={onSubmit} className="mb-6 flex flex-wrap items-end gap-3">
        <Field label="Identificador">
          <Input
            value={draftQ}
            onChange={(e) => setDraftQ(e.target.value)}
            placeholder="hash, user_id, order_id…"
            className="w-72"
          />
        </Field>
        <Field label="Tipo">
          <Select value={draftType} onChange={(e) => setDraftType(e.target.value as SearchType)}>
            {SEARCH_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="primary">
          Buscar
        </Button>
      </form>

      {query === null ? (
        <EmptyState
          title="Busque um usuário por identificador"
          hint="Informe um dos 5 identificadores (e-mail/telefone já hasheados, user_id, anonymous_id ou order_id) para consolidar o perfil. E-mail e telefone nunca em claro (regra 4)."
        />
      ) : (
        <AsyncBoundary
          state={state}
          empty={(d) => d.results.length === 0}
          emptyHint="Nenhum perfil encontrado para este identificador neste workspace."
        >
          {(d) => {
            const profile = d.results[0];
            if (!profile) {
              return (
                <EmptyState
                  title="Nenhum perfil encontrado"
                  hint="Nenhum perfil encontrado para este identificador neste workspace."
                />
              );
            }
            const m = profile.metrics;
            return (
              <>
                <Section title="Identidade">
                  <Card className="p-5">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="font-mono text-sm text-slate-100">{profile.canonical_id}</span>
                      <Badge variant={profile.status === 'identified' ? 'good' : 'neutral'}>
                        {profile.status === 'identified' ? 'Identificado' : 'Anônimo'}
                      </Badge>
                      {d.results.length > 1 ? (
                        <Badge variant="info">{d.results.length} candidatos</Badge>
                      ) : null}
                    </div>
                    <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-3 md:grid-cols-4">
                      <IdentityField label="E-mail (hash)" value={shortHash(profile.email_hash)} mono />
                      <IdentityField label="Telefone (hash)" value={shortHash(profile.phone_hash)} mono />
                      <IdentityField label="IDs anônimos" value={fmtInt(profile.anonymous_ids_count)} />
                      <IdentityField label="Moeda" value={m?.currency || '—'} />
                      <IdentityField label="Primeiro contato" value={fmtDateTime(profile.first_seen_at)} />
                      <IdentityField label="Última atividade" value={fmtDateTime(profile.last_seen_at)} />
                    </dl>
                  </Card>
                </Section>

                <Section title="Métricas">
                  <StatRow>
                    <StatTile label="LTV" value={fmtMoney(m?.ltv, m?.currency)} />
                    <StatTile label="Pedidos" value={m ? fmtInt(m.orders_count) : '—'} />
                    <StatTile label="Ticket médio" value={fmtMoney(m?.aov, m?.currency)} />
                    <StatTile label="Sessões" value={m ? fmtInt(m.sessions_count) : '—'} />
                    <StatTile label="Eventos" value={m ? fmtInt(m.events_count) : '—'} />
                    <StatTile
                      label="Dias desde 1º toque"
                      value={m ? fmtInt(m.days_since_first_touch) : '—'}
                    />
                  </StatRow>
                </Section>

                <Section
                  title="Timeline"
                  description="Eventos da pessoa (ClickHouse). Disponível quando a infra estiver no ar."
                >
                  <DataTable
                    columns={timelineColumns}
                    rows={[] as TimelineRow[]}
                    empty="Timeline disponível quando a infra (ClickHouse) estiver conectada."
                  />
                </Section>
              </>
            );
          }}
        </AsyncBoundary>
      )}
    </Page>
  );
}

function IdentityField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`mt-0.5 text-sm text-slate-200 ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}

// ─────────────────────────── formatação ───────────────────────────

function fmtInt(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('pt-BR').format(n);
}

function fmtMoney(n: number | null | undefined, currency?: string): string {
  if (n == null) return '—';
  const cur = currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null;
  try {
    return new Intl.NumberFormat(
      'pt-BR',
      cur ? { style: 'currency', currency: cur } : { maximumFractionDigits: 2 },
    ).format(n);
  } catch {
    return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(n);
  }
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function shortHash(s: string | null | undefined): string {
  if (!s) return '—';
  return s.length <= 18 ? s : `${s.slice(0, 8)}…${s.slice(-6)}`;
}
