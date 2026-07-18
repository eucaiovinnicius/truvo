/**
 * Truvo Pixel JS (PRD §7 Módulo 3).
 * Bundle alvo < 5kb (min + gzip). Sem dependências.
 *
 * API pública (window.truvo):
 *   truvo.track(event_name, properties?)
 *   truvo.identify(user_id, { email, name, phone })
 *   truvo.page(properties?)
 *   truvo.consent(granted)          // consent manager (regra 13)
 *   truvo.reset()
 *
 * Privacidade:
 *   - anonymous_id → cookie first-party SameSite=Lax, 1 ano.
 *   - session_id   → sessionStorage, expira 30min de inatividade.
 *   - click_id (do redirect) + fbclid/gclid/ttclid → cookie first-party.
 *   - UTMs → sessionStorage.
 *   - SEM consentimento: nenhum cookie é setado e nenhuma PII é enviada (regra 13).
 *     Nesse modo "cookieless" o pixel ainda envia eventos anônimos (id efêmero em memória).
 */

type Json = Record<string, unknown>;

interface IdentifyTraits {
  email?: string;
  name?: string;
  phone?: string;
  [k: string]: unknown;
}

interface TruvoApi {
  track(name: string, properties?: Json): void;
  identify(userId: string, traits?: IdentifyTraits): void;
  page(properties?: Json): void;
  consent(granted: boolean): void;
  reset(): void;
  getAnonymousId(): string;
  getSessionId(): string;
  q?: Array<[keyof TruvoApi, unknown[]]>;
}

(function () {
  const w = window as unknown as Record<string, any>;
  const d = document;
  const nav = navigator;

  // ── nomes de storage ──
  const CK_ANON = '_tvo_anon';
  const CK_CLICK = '_tvo_click';
  const CK_UID = '_tvo_uid';
  const CK_CONSENT = '_tvo_consent';
  const SS_SID = '_tvo_sid';
  const SS_SID_TS = '_tvo_sid_ts';
  const SS_UTM = '_tvo_utm';

  const SESSION_TTL = 30 * 60 * 1000; // 30min
  const YEAR_DAYS = 365;
  const CLICK_DAYS = 90;
  const AD_CLICK_IDS = ['fbclid', 'gclid', 'ttclid'];

  // ── config (data-* no <script> ou window.truvoConfig) ──
  const script =
    (d.currentScript as HTMLScriptElement | null) ||
    (d.querySelector('script[data-truvo-key]') as HTMLScriptElement | null);
  const wc = (w.truvoConfig || {}) as { key?: string; host?: string; auto?: boolean };

  const apiKey = script?.getAttribute('data-truvo-key') || wc.key || '';
  let host = (script?.getAttribute('data-truvo-host') || wc.host || '').replace(/\/+$/, '');
  if (!host && script?.src) {
    try {
      host = new URL(script.src).origin;
    } catch {
      /* noop */
    }
  }
  if (!host) host = location.origin;
  const autoPageView = script?.getAttribute('data-truvo-auto') !== 'false' && wc.auto !== false;

  // ── consentimento ──
  let consent: boolean | null = readConsent();
  function readConsent(): boolean | null {
    const raw = rawCookie(CK_CONSENT);
    if (raw === '1') return true;
    if (raw === '0') return false;
    if (typeof w.truvoConsent === 'boolean') return w.truvoConsent;
    return null; // desconhecido → tratado como negado p/ cookies/PII (regra 13)
  }
  const granted = () => consent === true;

  // ── cookies ──
  function rawCookie(name: string): string | null {
    const m = d.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1] ?? '') : null;
  }
  // writeCookie: escrita crua (cookie funcional/necessário, ex.: registro de consentimento).
  // setCookie: escrita com gate de consentimento (regra 13).
  function writeCookie(name: string, value: string, days: number): void {
    const exp = new Date(Date.now() + days * 864e5).toUTCString();
    d.cookie =
      name + '=' + encodeURIComponent(value) + '; expires=' + exp + '; path=/; SameSite=Lax';
  }
  function setCookie(name: string, value: string, days: number): void {
    if (!granted()) return; // regra 13: sem consentimento não seta cookie
    writeCookie(name, value, days);
  }

  // ── sessionStorage (tolerante a bloqueio) ──
  function ssGet(k: string): string | null {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  }
  function ssSet(k: string, v: string): void {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      /* noop */
    }
  }

  // ── ids ──
  function rand(len: number): string {
    const A = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const pick = (n: number): string => A.charAt(n % 36);
    let out = '';
    const c = w.crypto;
    if (c && c.getRandomValues) {
      const buf = new Uint8Array(len);
      c.getRandomValues(buf);
      buf.forEach((n) => {
        out += pick(n);
      });
    } else {
      for (let i = 0; i < len; i++) out += pick(Math.floor(Math.random() * 36));
    }
    return out;
  }

  let memAnon = '';
  function anonymousId(): string {
    let a = rawCookie(CK_ANON) || memAnon;
    if (!a) {
      a = 'anon_' + rand(21);
      memAnon = a; // sempre guarda em memória (fallback cookieless)
      setCookie(CK_ANON, a, YEAR_DAYS); // no-op sem consentimento
    }
    return a;
  }

  function sessionId(): { id: string; isNew: boolean } {
    const now = Date.now();
    let id = ssGet(SS_SID);
    const last = Number(ssGet(SS_SID_TS) || 0);
    let isNew = false;
    if (!id || (last && now - last > SESSION_TTL)) {
      id = 'sess_' + rand(21);
      isNew = true;
    }
    ssSet(SS_SID, id);
    ssSet(SS_SID_TS, String(now));
    return { id, isNew };
  }

  let memUid = rawCookie(CK_UID) || '';
  function userId(): string | undefined {
    return memUid || rawCookie(CK_UID) || undefined;
  }

  // ── captura de URL ──
  function captureClickIds(): void {
    const p = new URLSearchParams(location.search);
    const tv = p.get('truvo_click_id') || p.get('tvclid');
    if (tv) setCookie(CK_CLICK, tv, CLICK_DAYS);
    for (const k of AD_CLICK_IDS) {
      const v = p.get(k);
      if (v) setCookie('_tvo_' + k, v, CLICK_DAYS);
    }
  }
  function clickId(): string | undefined {
    return rawCookie(CK_CLICK) || undefined;
  }
  function captureUtms(): Json {
    const p = new URLSearchParams(location.search);
    const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    const found: Json = {};
    for (const k of keys) {
      const v = p.get(k);
      if (v) found[k] = v;
    }
    if (Object.keys(found).length) ssSet(SS_UTM, JSON.stringify(found)); // UTM não é PII
    return storedUtms();
  }
  function storedUtms(): Json {
    try {
      return JSON.parse(ssGet(SS_UTM) || '{}');
    } catch {
      return {};
    }
  }

  // ── SHA-256 (hash de email/telefone no cliente — regras 4/7) ──
  async function sha256(input: string): Promise<string | null> {
    try {
      const bytes = new TextEncoder().encode(input.trim().toLowerCase());
      const digest = await w.crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      return null;
    }
  }

  // ── contexto + envio ──
  function context(): Json {
    const ctx: Json = {
      page_url: location.href,
      user_agent: nav.userAgent,
    };
    if (d.referrer) ctx.referrer = d.referrer;
    Object.assign(ctx, storedUtms());
    return ctx;
  }

  function send(evt: Json): void {
    if (!apiKey) return; // sem API key não há para onde enviar
    try {
      fetch(host + '/v1/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify(evt),
        keepalive: true, // sobrevive ao unload da página
        credentials: 'omit',
        mode: 'cors',
      }).catch(() => {
        /* best-effort */
      });
    } catch {
      /* noop */
    }
  }

  function build(name: string, properties?: Json): Json {
    const sess = sessionId();
    const evt: Json = {
      event_id: 'evt_' + rand(24),
      event_name: name,
      source: 'pixel',
      timestamp: new Date().toISOString(),
      anonymous_id: anonymousId(),
      session_id: sess.id,
      properties: properties || {},
      context: context(),
    };
    const uid = userId();
    if (uid) evt.user_id = uid;
    const cid = clickId();
    if (cid) evt.click_id = cid;
    return evt;
  }

  // ── API pública ──
  function track(name: string, properties?: Json): void {
    send(build(name, properties));
  }

  function page(properties?: Json): void {
    track('page_view', properties);
  }

  async function identify(uid: string, traits?: IdentifyTraits): Promise<void> {
    memUid = uid;
    setCookie(CK_UID, uid, YEAR_DAYS); // no-op sem consentimento
    const t: Json = {};
    if (granted() && traits) {
      // PII só com consentimento; email/telefone viajam como hash SHA-256.
      if (traits.name) t.name = traits.name;
      if (traits.email) {
        const h = await sha256(traits.email);
        if (h) t.email_hash = h;
      }
      if (traits.phone) {
        const h = await sha256(String(traits.phone).replace(/[^0-9]/g, ''));
        if (h) t.phone_hash = h;
      }
    }
    track('identify', t);
  }

  function setConsent(value: boolean): void {
    consent = value;
    writeCookie(CK_CONSENT, value ? '1' : '0', YEAR_DAYS); // cookie necessário (registro)
    if (value) anonymousId(); // agora pode persistir o id efêmero
  }

  function reset(): void {
    memUid = '';
    memAnon = '';
    writeCookie(CK_UID, '', -1);
    writeCookie(CK_ANON, '', -1);
    writeCookie(CK_CLICK, '', -1);
  }

  // ── eventos automáticos ──
  let scrollHits: Record<number, boolean> = {};
  const bindAuto = () => {
    // button_click — apenas elementos com [data-track]
    d.addEventListener(
      'click',
      (e) => {
        const el = (e.target as Element | null)?.closest?.('[data-track]') as HTMLElement | null;
        if (!el) return;
        track('button_click', {
          label: el.getAttribute('data-track') || undefined,
          text: (el.textContent || '').trim().slice(0, 120) || undefined,
          element_id: el.id || undefined,
        });
      },
      true,
    );

    // form_submit — sem valores de campos (evita PII)
    d.addEventListener(
      'submit',
      (e) => {
        const f = e.target as HTMLFormElement | null;
        if (!f || f.tagName !== 'FORM') return;
        track('form_submit', {
          form_id: f.id || undefined,
          form_name: f.getAttribute('name') || undefined,
          form_action: f.getAttribute('action') || undefined,
        });
      },
      true,
    );

    // scroll_depth — 25/50/75/100% (cada limiar uma vez por página)
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const doc = d.documentElement;
        const scrollable = doc.scrollHeight - doc.clientHeight;
        if (scrollable <= 0) return;
        const pct = Math.min(100, Math.round((doc.scrollTop / scrollable) * 100));
        for (const th of [25, 50, 75, 100]) {
          if (pct >= th && !scrollHits[th]) {
            scrollHits[th] = true;
            track('scroll_depth', { percent: th });
          }
        }
      });
    };
    addEventListener('scroll', onScroll, { passive: true });
  };

  // ── suporte a SPA (page_view em mudança de rota) ──
  const hookHistory = () => {
    const fire = () => {
      scrollHits = {};
      captureClickIds();
      captureUtms();
      if (autoPageView) page();
    };
    const patch = (name: 'pushState' | 'replaceState') => {
      const orig = history[name];
      history[name] = function (this: History, ...args: unknown[]) {
        const r = (orig as any).apply(this, args);
        fire();
        return r;
      } as History[typeof name];
    };
    patch('pushState');
    patch('replaceState');
    addEventListener('popstate', fire);
  };

  // ── init ──
  const api: TruvoApi = {
    track,
    identify: (uid, traits) => {
      void identify(uid, traits);
    },
    page,
    consent: setConsent,
    reset,
    getAnonymousId: anonymousId,
    getSessionId: () => sessionId().id,
  };

  function init(): void {
    captureClickIds();
    captureUtms();
    const sess = sessionId();
    if (sess.isNew) track('session_start', {});
    if (autoPageView) page();
    bindAuto();
    hookHistory();
  }

  // Replay da fila do snippet assíncrono (window.truvo.q), depois publica a API real.
  const existing = w.truvo as TruvoApi | undefined;
  if (existing && Array.isArray(existing.q)) {
    for (const [method, args] of existing.q) {
      try {
        (api as any)[method]?.apply(null, args);
      } catch {
        /* noop */
      }
    }
  }
  w.truvo = api;

  if (d.readyState === 'loading') {
    d.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

export {};
