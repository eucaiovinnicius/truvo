---
name: truvo-install
description: Instala o rastreamento do Truvo (analytics/atribuição) num site, blog, app web, SPA ou dashboard — pixel, eventos personalizados, conversões/receita, identificação de usuário, consentimento (LGPD/GDPR) e ingestão server-side. Use quando o usuário disser "instalar truvo", "adicionar rastreamento/analytics/pixel", "trackear eventos", "medir conversões", "integrar truvo", ou pedir para instrumentar um app com o Truvo.
---

# Instalar o Truvo

O Truvo é um analytics/atribuição server-side-friendly. O rastreamento tem duas vias:
**(A) pixel no navegador** (`window.truvo`) e **(B) ingestão server-side** (`POST /v1/events`). Use A para front, B para backend/webhooks/mobile.

## 0. Colete 2 parâmetros (pergunte se faltarem)
- **HOST** — domínio da API Truvo, ex.: `https://api.suatruvo.com`. O pixel fica em `HOST/pixel.js`.
- **API_KEY** — começa com `tvo_live_`. Gerada em *Tracking → API Keys* no app Truvo (aparece uma vez). A key do pixel é pública (como a de GA); a de server-side também identifica o workspace — não precisa ficar secreta no client, mas mantenha fora do repo se for server.

Se o usuário não tiver, **peça os dois** antes de editar arquivos. Não invente valores.

## 1. Instale o pixel (front)
Detecte o framework e insira UMA vez, em todas as páginas, antes do `</head>` (ou no layout raiz):

- **HTML puro / blog / WordPress / landing:**
  ```html
  <script async src="https://HOST/pixel.js" data-truvo-key="API_KEY"></script>
  ```
- **Next.js (App Router)** — `app/layout.tsx`, dentro de `<body>`:
  ```tsx
  import Script from 'next/script';
  <Script src="https://HOST/pixel.js" data-truvo-key="API_KEY" strategy="afterInteractive" />
  ```
- **Next.js (Pages)** — `pages/_document.tsx` no `<Head>`, ou `_app.tsx` com `next/script`.
- **React/Vite (SPA)** — adicione a tag `<script async src=...>` no `index.html` (`<head>`). O pixel já cobre troca de rota (patcha history API).
- **Vue/Angular/outras SPAs** — mesma tag no `index.html`. Não reinstale por rota.

Prefira `HOST` = origem de onde o `pixel.js` é servido (o pixel deriva o host do `src`). Se servir o pixel de outro domínio, adicione `data-truvo-host="https://HOST"`.

Se o app chama `truvo.track` ANTES do pixel carregar, instale o **loader com fila** (senão pule):
```html
<script>
!function(w,d){w.truvo=w.truvo||{q:[]};['track','identify','page','consent','reset']
 .forEach(function(m){w.truvo[m]=w.truvo[m]||function(){w.truvo.q.push([m,[].slice.call(arguments)])}});
 var s=d.createElement('script');s.async=1;s.src='https://HOST/pixel.js';
 s.setAttribute('data-truvo-key','API_KEY');d.head.appendChild(s);}(window,document);
</script>
```

Ao instalar, o Truvo já rastreia sozinho: `session_start`, `page_view` (inclui SPA), `button_click` (elementos com `data-track`), `form_submit`, `scroll_depth`, além de UTMs e click ids (`fbclid/gclid/ttclid`).

## 2. Eventos personalizados
```js
truvo.track('nome_do_evento', { chave: 'valor', qualquer: 123 });
```
Em TS/React use `window.truvo?.track(...)` (o objeto pode não existir em SSR). Cliques sem código: `data-track="rotulo"` no elemento.

## 3. Conversões / receita (obrigatório para ROAS/LTV/atribuição)
```js
truvo.track('purchase', { order_id: 'ORD-123', value: 349.90, currency: 'BRL' });
```
Eventos de receita: `purchase`, `checkout_completed`, `subscription_started`. Sempre inclua `order_id` (dedup), `value`, `currency`. Funil: `add_to_cart`, `checkout_started`, `lead`, `refund`.

## 4. Identificação (login/cadastro)
```js
truvo.identify('user_ID_INTERNO', { email: 'a@b.com', name: 'Ana', phone: '+55...' });
```
`user_id` obrigatório; traits opcionais. O pixel **hasheia email/telefone (SHA-256)** no cliente e só envia com consentimento — **nunca** envie PII em claro você mesmo. Logout: `truvo.reset()`.

## 5. Consentimento (LGPD/GDPR)
Sem consentimento o pixel é cookieless (eventos anônimos, sem cookie/PII). Ligue no aceite do banner:
```js
truvo.consent(true);  // ou false
```
Se o app tem cookie banner, chame `truvo.consent(escolha)` no callback dele.

## 6. Server-side (backend/webhook/mobile) — quando NÃO há navegador
```
POST https://HOST/v1/events        (um)      header: X-Api-Key: API_KEY
POST https://HOST/v1/events/batch  (lote[])  header: X-Api-Key: API_KEY
```
Corpo (um evento): `{ "event_name","source","user_id"|"anonymous_id","order_id"?,"properties":{...},"context":{...} }`.
- `workspace_id` vem da API key (NÃO no corpo). `event_id`/`timestamp` gerados se ausentes (envie `event_id` p/ idempotência).
- `source`: use `webhook` p/ pagamento, `api` p/ backend, `gateway` p/ gateway. Fonte mais confiável vence no dedup de `order_id`.

## 7. Verifique (sempre feche com isto)
1. Rode/abra o app, navegue, dispare uma conversão de teste.
2. Confirme no app Truvo (Explorer/Dashboard, modo live) que `page_view` + o evento chegaram; ou cheque `POST /v1/events` → 2xx no Network do navegador.
3. Se 401/403: API key errada ou sem membership. Se CORS: libere o domínio do site em `CORS_ORIGINS` da API. Se nada chega no client: ad-blocker — caia para server-side (§6).

## Contrato da API do pixel (`window.truvo`)
`track(name, props?)` · `identify(userId, traits?)` · `page(props?)` · `consent(bool)` · `reset()` · `getAnonymousId()` · `getSessionId()`.

## Regras (não viole)
- Uma única instalação do pixel por app (não duplique a tag).
- Nunca coloque PII em claro em `track`/propriedades; use `identify` (que hasheia) ou envie `email_hash`/`phone_hash` você mesmo no server-side.
- Não invente HOST/API_KEY — peça ao usuário.
- Para conversões, `value` deve ser número e `currency` ISO-4217 (ex.: `BRL`, `USD`).
