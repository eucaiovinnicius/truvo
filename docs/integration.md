# Integrar o Truvo — site, blog, dashboard e eventos personalizados

Guia de instalação do rastreamento do Truvo. Do "copia e cola" de 1 minuto até eventos de conversão, identificação de usuário, consentimento (LGPD/GDPR) e ingestão server-side.

- **`SEU_HOST`** = o domínio da sua API Truvo (ex.: `https://api.suatruvo.com`). O pixel é servido em `SEU_HOST/pixel.js`.
- **`tvo_live_SUA_CHAVE`** = sua API key. Gere em **Tracking → API Keys** no app (o segredo aparece **uma vez**).

---

## 1. Instalação rápida (site / blog / landing page)

Cole antes do `</head>` de todas as páginas:

```html
<script async src="https://SEU_HOST/pixel.js" data-truvo-key="tvo_live_SUA_CHAVE"></script>
```

Pronto. Isso já rastreia **automaticamente**, sem mais código:

| Evento automático | Quando dispara |
|---|---|
| `session_start` | primeira visita de uma sessão (expira em 30min de inatividade) |
| `page_view` | cada página (e cada troca de rota em SPA) |
| `button_click` | clique em qualquer elemento com `data-track` |
| `form_submit` | envio de formulário (sem capturar valores de campos) |
| `scroll_depth` | 25 / 50 / 75 / 100% da página |

E captura sozinho: `anonymous_id` (cookie 1º-party), `session_id`, UTMs (`utm_source/medium/campaign/content/term`) e click ids de anúncio (`fbclid/gclid/ttclid`) + `truvo_click_id`.

> **Snippet assíncrono (recomendado)** — se você quer chamar `truvo.track(...)` antes do pixel carregar, use o loader com fila:
> ```html
> <script>
> !function(w,d){w.truvo=w.truvo||{q:[]};
>  ['track','identify','page','consent','reset'].forEach(function(m){
>    w.truvo[m]=w.truvo[m]||function(){w.truvo.q.push([m,[].slice.call(arguments)])};});
>  var s=d.createElement('script');s.async=1;s.src='https://SEU_HOST/pixel.js';
>  s.setAttribute('data-truvo-key','tvo_live_SUA_CHAVE');d.head.appendChild(s);}(window,document);
> </script>
> ```

---

## 2. Eventos personalizados

Chame `truvo.track(nome, propriedades)` de qualquer lugar do seu JS:

```js
truvo.track('video_assistido', { titulo: 'Onboarding', segundos: 42 });
truvo.track('plano_selecionado', { plano: 'growth', ciclo: 'anual' });
```

**Cliques sem código** — marque o elemento com `data-track`:

```html
<button data-track="cta_hero">Começar agora</button>
```

---

## 3. Conversões e receita

Para o Truvo calcular ROAS/LTV/atribuição, envie eventos de receita com `value`, `currency` e `order_id`:

```js
truvo.track('purchase', {
  order_id: 'ORD-10432',   // dedup: o mesmo pedido nunca conta 2x
  value: 349.90,
  currency: 'BRL',
});
```

Eventos de receita reconhecidos: `purchase`, `checkout_completed`, `subscription_started`. Outros úteis do funil: `add_to_cart`, `checkout_started`, `lead`, `refund` (abate receita).

---

## 4. Identificar o usuário (login / cadastro)

Quando o visitante se identifica, ligue o anônimo à pessoa:

```js
truvo.identify('user_123', { email: 'ana@loja.com', name: 'Ana', phone: '+5511999998888' });
```

- `user_id` é **obrigatório**; os traits são opcionais.
- **E-mail e telefone nunca saem em claro** — o pixel envia **SHA-256** deles (regras de privacidade), e só com consentimento.
- Depois do `identify`, o Truvo funde a jornada anônima com a identificada (Customer 360, funis, atribuição).

Ao deslogar: `truvo.reset();`

---

## 5. Consentimento (LGPD / GDPR)

Sem consentimento, o pixel roda em modo **cookieless**: envia eventos anônimos (id efêmero em memória), **não seta cookies e não envia PII**. Ligue quando o usuário aceitar:

```js
truvo.consent(true);   // usuário aceitou → passa a persistir cookies + enviar hashes de PII
truvo.consent(false);  // recusou
```

Integre com seu banner de cookies chamando `truvo.consent(...)` na escolha do usuário.

---

## 6. Guias por plataforma

**WordPress / blog** — cole o snippet do §1 em *Aparência → Editor de tema → header.php* (antes de `</head>`), ou use um plugin de "insert headers and footers". Para eventos de compra (WooCommerce), dispare `truvo.track('purchase', {...})` na página de obrigado.

**React / Next.js (dashboard/app)** — carregue o pixel uma vez no layout raiz:

```tsx
// app/layout.tsx (Next.js App Router)
import Script from 'next/script';

export default function RootLayout({ children }) {
  return (
    <html><body>
      {children}
      <Script src="https://SEU_HOST/pixel.js" data-truvo-key="tvo_live_SUA_CHAVE" strategy="afterInteractive" />
    </body></html>
  );
}
```

Depois, em qualquer componente: `window.truvo?.track('feature_usada', { nome: 'export_csv' });`
O pixel já dispara `page_view` em cada troca de rota (App Router / history API).

**SPA (Vue/Angular/etc.)** — o pixel detecta `pushState`/`replaceState`/`popstate` e dispara `page_view` automático nas rotas. Só instale o snippet uma vez.

---

## 7. Links de campanha (atribuição de cliques)

Use links rastreáveis para atribuir cliques (o Truvo grava o `click_id` num cookie 1º-party ao redirecionar):

```
https://SEU_HOST/c/<codigo-do-link>
```

Crie os links em **Tracking → Links** no app. Combine com UTMs para o breakdown por canal/campanha na Atribuição (M7).

---

## 8. Ingestão server-side (backend, webhooks, mobile)

Para eventos que não passam pelo navegador (webhook de pagamento, backend, app mobile), poste direto na API com a **API key no header** (`X-Api-Key`):

```bash
# Um evento
curl -X POST https://SEU_HOST/v1/events \
  -H "X-Api-Key: tvo_live_SUA_CHAVE" -H "Content-Type: application/json" \
  -d '{"event_name":"purchase","source":"webhook","user_id":"user_123",
       "order_id":"ORD-10432","properties":{"value":349.90,"currency":"BRL"}}'

# Em lote (até ~centenas por chamada; envie em blocos)
curl -X POST https://SEU_HOST/v1/events/batch \
  -H "X-Api-Key: tvo_live_SUA_CHAVE" -H "Content-Type: application/json" \
  -d '[ { "event_name":"lead","source":"api","anonymous_id":"anon_x","properties":{} } ]'
```

- `workspace_id` é resolvido pela API key — **não** vai no corpo.
- `event_id`/`timestamp` são gerados se ausentes; envie `event_id` próprio para idempotência.
- `source` (mais confiável → menos): `webhook` > `api` > `gateway` > `redirect` > `pixel` > `url`. Em conflito de `order_id`, a fonte mais confiável vence (dedup).

---

## 9. Referência do evento

```jsonc
{
  "event_id":     "string",        // opcional (gerado se ausente); use p/ idempotência
  "event_name":   "purchase",      // qualquer string; os padrões do §1/§3 têm semântica
  "source":       "pixel",         // pixel | api | webhook | gateway | redirect | url
  "timestamp":    "ISO-8601",      // opcional
  "anonymous_id": "anon_...",      // pixel preenche sozinho
  "user_id":      "user_123",      // após identify
  "session_id":   "sess_...",
  "order_id":     "ORD-10432",     // conversões (dedup)
  "click_id":     "...",           // do link de campanha / anúncio
  "properties":   { "value": 349.9, "currency": "BRL", "email_hash": "..." },
  "context":      { "utm_source": "...", "page_url": "...", "user_agent": "...", "referrer": "..." }
}
```

---

## 10. Verificar se está funcionando

1. Abra o site, navegue, faça uma compra de teste.
2. No app: **Tracking / Explorer / Dashboard** → confira `page_view`, `session_start`, `purchase` chegando (modo live).
3. Não apareceu? Cheque: (a) a **API key** correta no snippet; (b) `SEU_HOST` acessível e com **CORS** liberado para o domínio do site; (c) o console do navegador por erros de rede em `POST /v1/events`; (d) bloqueadores de anúncio podem barrar o pixel — o server-side (§8) não sofre disso.

---

### Resumo da API do pixel (`window.truvo`)
| Método | Uso |
|---|---|
| `truvo.track(name, props?)` | evento personalizado / conversão |
| `truvo.identify(userId, {email,name,phone}?)` | ligar anônimo → usuário |
| `truvo.page(props?)` | page_view manual (automático por padrão) |
| `truvo.consent(true/false)` | consentimento (LGPD/GDPR) |
| `truvo.reset()` | logout (limpa ids) |
| `truvo.getAnonymousId()` / `getSessionId()` | ler os ids atuais |
