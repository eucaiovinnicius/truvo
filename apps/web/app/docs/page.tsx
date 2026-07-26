import type { Metadata } from 'next';
import Logo from '@/appui/components/Logo';
import { CodeBlock } from './CodeBlock';

export const metadata: Metadata = {
  title: 'Integração — Truvo',
  description:
    'Instale o rastreamento do Truvo em site, blog, dashboard ou app: pixel, eventos personalizados, conversões, identificação de usuário, consentimento (LGPD/GDPR) e ingestão server-side.',
};

const NAV: Array<{ id: string; n: string; label: string; grp?: string }> = [
  { id: 's1', n: '1', label: 'Instalação rápida', grp: 'Começar' },
  { id: 's2', n: '2', label: 'Eventos personalizados' },
  { id: 's3', n: '3', label: 'Conversões e receita' },
  { id: 's4', n: '4', label: 'Identificar usuário' },
  { id: 's5', n: '5', label: 'Consentimento' },
  { id: 's6', n: '6', label: 'Por plataforma', grp: 'Avançado' },
  { id: 's7', n: '7', label: 'Links de campanha' },
  { id: 's8', n: '8', label: 'Server-side' },
  { id: 's9', n: '9', label: 'Referência do evento' },
  { id: 's10', n: '10', label: 'Verificar / suporte' },
];

function H2({ id, n, children }: { id: string; n: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="mt-14 mb-2 scroll-mt-20 text-[22px] font-semibold tracking-tight text-slate-900">
      <span className="mr-3 rounded-md border border-slate-200 px-2 py-0.5 align-middle font-mono text-sm text-indigo-600">
        {n}
      </span>
      {children}
    </h2>
  );
}

const kbd =
  'rounded-md border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-mono text-[0.85em] text-indigo-700';

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-3.5">
          <Logo mark="#4f46e5" word="#0f172a" className="h-7 w-auto" />
          <span className="text-slate-300">/</span>
          <span className="text-sm font-medium text-slate-500">Docs de Integração</span>
          <span className="flex-1" />
          <a
            href="/"
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 transition hover:border-indigo-400 hover:text-indigo-600"
          >
            Abrir app →
          </a>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="sticky top-[57px] hidden h-[calc(100vh-57px)] overflow-y-auto border-r border-slate-200 px-4 py-7 md:block">
          <nav className="space-y-0.5">
            {NAV.map((item) => (
              <div key={item.id}>
                {item.grp && (
                  <div className="mb-1.5 mt-5 pl-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    {item.grp}
                  </div>
                )}
                <a
                  href={`#${item.id}`}
                  className="flex items-center rounded-lg px-2.5 py-1.5 text-sm text-slate-600 transition hover:bg-white hover:text-slate-900"
                >
                  <span className="mr-2.5 font-mono text-xs text-slate-400">{item.n}</span>
                  {item.label}
                </a>
              </div>
            ))}
          </nav>
        </aside>

        <main className="px-6 py-10 md:px-12 md:py-14">
          <h1 className="text-balance text-4xl font-bold leading-tight tracking-tight text-slate-900">
            Integrar o Truvo
          </h1>
          <p className="mt-3 max-w-2xl text-lg text-slate-600">
            Instale o rastreamento em um site, blog, dashboard ou app — do &quot;copia e cola&quot; de 1
            minuto até conversões, identificação de usuário, consentimento (LGPD/GDPR) e ingestão
            server-side.
          </p>

          <div className="mt-6 flex flex-wrap gap-2">
            <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[13px] text-slate-600">
              <b className="font-semibold text-indigo-700">SEU_HOST</b> = domínio da sua API · o pixel
              fica em <code className={kbd}>SEU_HOST/pixel.js</code>
            </span>
            <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[13px] text-slate-600">
              <b className="font-semibold text-indigo-700">tvo_live_…</b> = sua API key (Tracking → API
              Keys; aparece 1×)
            </span>
          </div>

          <div className="prose-truvo mt-2 max-w-2xl text-slate-700 [&_a]:text-indigo-600 [&_p]:my-2.5">
            {/* 1 */}
            <H2 id="s1" n="1">Instalação rápida</H2>
            <p>Cole antes do <code className={kbd}>&lt;/head&gt;</code> de todas as páginas:</p>
            <CodeBlock
              lang="html"
              code={`<script async src="https://SEU_HOST/pixel.js" data-truvo-key="tvo_live_SUA_CHAVE"></script>`}
            />
            <p>Pronto — isso já rastreia <strong className="font-semibold text-slate-900">automaticamente</strong>, sem mais código:</p>
            <Table
              head={['Evento automático', 'Quando dispara']}
              rows={[
                ['session_start', 'primeira visita da sessão (expira em 30 min de inatividade)'],
                ['page_view', 'cada página — e cada troca de rota em SPA'],
                ['button_click', 'clique em elemento com data-track'],
                ['form_submit', 'envio de formulário (sem capturar valores dos campos)'],
                ['scroll_depth', '25 / 50 / 75 / 100% da página'],
              ]}
            />
            <p className="text-slate-500">
              Captura sozinho: <code className={kbd}>anonymous_id</code>, <code className={kbd}>session_id</code>,
              UTMs e click ids de anúncio (<code className={kbd}>fbclid/gclid/ttclid</code>).
            </p>
            <Callout title="Precisa chamar truvo.track antes do pixel carregar?">
              Use o loader com fila — ele enfileira as chamadas e o pixel as reproduz ao inicializar:
              <CodeBlock
                lang="html"
                code={`<script>
!function(w,d){w.truvo=w.truvo||{q:[]};
 ['track','identify','page','consent','reset'].forEach(function(m){
   w.truvo[m]=w.truvo[m]||function(){w.truvo.q.push([m,[].slice.call(arguments)])}});
 var s=d.createElement('script');s.async=1;s.src='https://SEU_HOST/pixel.js';
 s.setAttribute('data-truvo-key','tvo_live_SUA_CHAVE');d.head.appendChild(s);}(window,document);
</script>`}
              />
            </Callout>

            {/* 2 */}
            <H2 id="s2" n="2">Eventos personalizados</H2>
            <p>Chame <code className={kbd}>truvo.track(nome, propriedades)</code> de qualquer lugar do seu JS:</p>
            <CodeBlock
              lang="js"
              code={`truvo.track('video_assistido', { titulo: 'Onboarding', segundos: 42 });
truvo.track('plano_selecionado', { plano: 'growth', ciclo: 'anual' });`}
            />
            <p><strong className="font-semibold text-slate-900">Cliques sem código</strong> — marque o elemento com <code className={kbd}>data-track</code>:</p>
            <CodeBlock lang="html" code={`<button data-track="cta_hero">Começar agora</button>`} />

            {/* 3 */}
            <H2 id="s3" n="3">Conversões e receita</H2>
            <p>
              Para o Truvo calcular <strong className="font-semibold text-slate-900">ROAS, LTV e atribuição</strong>,
              envie eventos de receita com <code className={kbd}>value</code>, <code className={kbd}>currency</code> e{' '}
              <code className={kbd}>order_id</code>:
            </p>
            <CodeBlock
              lang="js"
              code={`truvo.track('purchase', {
  order_id: 'ORD-10432',   // dedup: o mesmo pedido nunca conta 2x
  value: 349.90,
  currency: 'BRL',
});`}
            />
            <p className="text-slate-500">
              Eventos de receita: <code className={kbd}>purchase</code>, <code className={kbd}>checkout_completed</code>,{' '}
              <code className={kbd}>subscription_started</code>. Funil: <code className={kbd}>add_to_cart</code>,{' '}
              <code className={kbd}>checkout_started</code>, <code className={kbd}>lead</code>, <code className={kbd}>refund</code>.
            </p>

            {/* 4 */}
            <H2 id="s4" n="4">Identificar o usuário</H2>
            <p>No login/cadastro, ligue o anônimo à pessoa:</p>
            <CodeBlock
              lang="js"
              code={`truvo.identify('user_123', { email: 'ana@loja.com', name: 'Ana', phone: '+5511999998888' });`}
            />
            <ul className="my-3 list-disc space-y-1 pl-5">
              <li><code className={kbd}>user_id</code> é obrigatório; os traits são opcionais.</li>
              <li><strong className="font-semibold text-slate-900">E-mail e telefone nunca saem em claro</strong> — o pixel envia o <strong className="font-semibold text-slate-900">SHA-256</strong> deles, e só com consentimento.</li>
              <li>Depois do <code className={kbd}>identify</code>, a jornada anônima funde com a identificada (Customer 360, funis, atribuição).</li>
              <li>No logout: <code className={kbd}>truvo.reset()</code>.</li>
            </ul>

            {/* 5 */}
            <H2 id="s5" n="5">Consentimento (LGPD / GDPR)</H2>
            <p>
              Sem consentimento o pixel roda <strong className="font-semibold text-slate-900">cookieless</strong>: envia
              eventos anônimos, <strong className="font-semibold text-slate-900">não seta cookies e não envia PII</strong>.
              Ligue no aceite do banner:
            </p>
            <CodeBlock
              lang="js"
              code={`truvo.consent(true);   // aceitou → persiste cookies + envia hashes de PII
truvo.consent(false);  // recusou`}
            />

            {/* 6 */}
            <H2 id="s6" n="6">Guias por plataforma</H2>
            <h3 className="mb-1 mt-6 font-semibold text-slate-900">WordPress / blog</h3>
            <p className="text-slate-500">
              Cole o snippet do §1 no <code className={kbd}>header.php</code> (antes de <code className={kbd}>&lt;/head&gt;</code>)
              ou via plugin de &quot;insert headers&quot;. WooCommerce: dispare <code className={kbd}>truvo.track(&apos;purchase&apos;, …)</code> na página de obrigado.
            </p>
            <h3 className="mb-1 mt-6 font-semibold text-slate-900">Next.js (App Router)</h3>
            <CodeBlock
              lang="tsx"
              code={`// app/layout.tsx
import Script from 'next/script';

<Script src="https://SEU_HOST/pixel.js" data-truvo-key="tvo_live_SUA_CHAVE"
        strategy="afterInteractive" />`}
            />
            <p className="text-slate-500">
              Em componentes: <code className={kbd}>window.truvo?.track(&apos;feature_usada&apos;, &#123; nome: &apos;export_csv&apos; &#125;)</code>.
              O <code className={kbd}>page_view</code> por rota é automático.
            </p>
            <h3 className="mb-1 mt-6 font-semibold text-slate-900">React / Vue / Angular (SPA &amp; dashboard)</h3>
            <p className="text-slate-500">
              Adicione a tag <code className={kbd}>&lt;script async&gt;</code> uma vez no <code className={kbd}>index.html</code>.
              O pixel detecta <code className={kbd}>pushState/replaceState/popstate</code> e dispara <code className={kbd}>page_view</code>{' '}
              em cada rota. Não reinstale por rota.
            </p>

            {/* 7 */}
            <H2 id="s7" n="7">Links de campanha</H2>
            <p>
              Use links rastreáveis (o Truvo grava o <code className={kbd}>click_id</code> num cookie 1º-party ao
              redirecionar) para atribuir cliques:
            </p>
            <CodeBlock lang="url" code={`https://SEU_HOST/c/<codigo-do-link>`} />
            <p className="text-slate-500">
              Crie os links em Tracking → Links. Combine com UTMs para o breakdown por canal/campanha na Atribuição.
            </p>

            {/* 8 */}
            <H2 id="s8" n="8">Ingestão server-side</H2>
            <p>
              Para eventos que não passam pelo navegador (webhook de pagamento, backend, mobile), poste direto na API
              com a key no header <code className={kbd}>X-Api-Key</code>:
            </p>
            <CodeBlock
              lang="bash"
              code={`# Um evento
curl -X POST https://SEU_HOST/v1/events \\
  -H "X-Api-Key: tvo_live_SUA_CHAVE" -H "Content-Type: application/json" \\
  -d '{"event_name":"purchase","source":"webhook","user_id":"user_123",
       "order_id":"ORD-10432","properties":{"value":349.90,"currency":"BRL"}}'

# Em lote (array) — envie em blocos
curl -X POST https://SEU_HOST/v1/events/batch \\
  -H "X-Api-Key: tvo_live_SUA_CHAVE" -H "Content-Type: application/json" \\
  -d '[ {"event_name":"lead","source":"api","anonymous_id":"anon_x","properties":{}} ]'`}
            />
            <ul className="my-3 list-disc space-y-1 pl-5">
              <li><code className={kbd}>workspace_id</code> é resolvido pela API key — <strong className="font-semibold text-slate-900">não</strong> vai no corpo.</li>
              <li><code className={kbd}>event_id</code>/<code className={kbd}>timestamp</code> são gerados se ausentes; envie <code className={kbd}>event_id</code> próprio para idempotência.</li>
              <li><code className={kbd}>source</code> (mais confiável → menos): <code className={kbd}>webhook</code> &gt; <code className={kbd}>api</code> &gt; <code className={kbd}>gateway</code> &gt; <code className={kbd}>redirect</code> &gt; <code className={kbd}>pixel</code> &gt; <code className={kbd}>url</code>. Em conflito de <code className={kbd}>order_id</code>, a fonte mais confiável vence.</li>
            </ul>

            {/* 9 */}
            <H2 id="s9" n="9">Referência do evento</H2>
            <CodeBlock
              lang="jsonc"
              code={`{
  "event_id":     "string",        // opcional (gerado); use p/ idempotência
  "event_name":   "purchase",      // qualquer string; os padrões têm semântica
  "source":       "pixel",         // pixel|api|webhook|gateway|redirect|url
  "anonymous_id": "anon_...",      // pixel preenche sozinho
  "user_id":      "user_123",      // após identify
  "order_id":     "ORD-10432",     // conversões (dedup)
  "properties":   { "value": 349.9, "currency": "BRL" },
  "context":      { "utm_source": "...", "page_url": "...", "referrer": "..." }
}`}
            />
            <h3 className="mb-1 mt-6 font-semibold text-slate-900">API do pixel (<code className={kbd}>window.truvo</code>)</h3>
            <Table
              head={['Método', 'Uso']}
              rows={[
                ['track(name, props?)', 'evento personalizado / conversão'],
                ['identify(userId, traits?)', 'ligar anônimo → usuário'],
                ['page(props?)', 'page_view manual (automático por padrão)'],
                ['consent(bool)', 'consentimento (LGPD/GDPR)'],
                ['reset()', 'logout (limpa ids)'],
                ['getAnonymousId() / getSessionId()', 'ler os ids atuais'],
              ]}
            />

            {/* 10 */}
            <H2 id="s10" n="10">Verificar &amp; suporte</H2>
            <ul className="my-3 list-disc space-y-1 pl-5">
              <li>Abra o site, navegue, faça uma compra de teste.</li>
              <li>No app: <strong className="font-semibold text-slate-900">Explorer / Dashboard</strong> (modo live) → confira <code className={kbd}>page_view</code>, <code className={kbd}>session_start</code>, <code className={kbd}>purchase</code> chegando.</li>
              <li>Não chegou? Cheque: (1) API key correta; (2) <code className={kbd}>SEU_HOST</code> acessível com <strong className="font-semibold text-slate-900">CORS</strong> liberado p/ o domínio do site; (3) o Network do navegador por erro em <code className={kbd}>POST /v1/events</code>; (4) ad-blockers podem barrar o pixel — o server-side (§8) não sofre disso.</li>
            </ul>

            <div className="mt-14 border-t border-slate-200 pt-6 text-sm text-slate-400">
              Truvo · Docs de Integração — o rastreamento é fail-safe e respeita consentimento (LGPD/GDPR) por padrão.
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="my-4 overflow-x-auto rounded-xl border border-slate-200">
      <table className="w-full text-sm">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} className="border-b border-slate-200 bg-slate-50 px-3.5 py-2.5 text-left text-[12.5px] font-semibold text-slate-500">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className="border-b border-slate-100 px-3.5 py-2.5 align-top text-slate-700 last:border-0">
                  {j === 0 ? <code className="font-mono text-[13px] text-indigo-700">{c}</code> : c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Callout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="my-5 rounded-xl border border-slate-200 border-l-[3px] border-l-indigo-500 bg-white p-4 text-[14.5px] text-slate-600">
      <b className="text-slate-900">{title}</b>
      <div className="mt-1">{children}</div>
    </div>
  );
}
