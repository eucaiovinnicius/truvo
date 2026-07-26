'use client';

import { useState } from 'react';

/**
 * Bloco de código com etiqueta de linguagem + botão "copiar". Client component
 * (usa clipboard/estado) — o resto da página de docs é server-rendered (SEO).
 */
export function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => undefined);
  };

  return (
    <div className="group relative my-4">
      <span className="pointer-events-none absolute right-3 top-2.5 font-mono text-[11px] uppercase tracking-wider text-slate-500">
        {lang}
      </span>
      <button
        type="button"
        onClick={copy}
        className="absolute right-16 top-2 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-[11px] text-slate-300 opacity-0 transition hover:border-indigo-400 hover:text-indigo-300 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 group-hover:opacity-100"
      >
        {copied ? 'copiado ✓' : 'copiar'}
      </button>
      <pre className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900 p-4 font-mono text-[13px] leading-relaxed text-slate-100">
        <code>{code}</code>
      </pre>
    </div>
  );
}
