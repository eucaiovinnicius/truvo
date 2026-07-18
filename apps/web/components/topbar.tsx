export function Topbar({ title }: { title: string }) {
  return (
    <header className="flex h-14 items-center justify-between border-b border-slate-800 bg-slate-950/80 px-6 backdrop-blur">
      <h1 className="text-sm font-semibold text-slate-100">{title}</h1>
      <div className="text-xs text-slate-500">Últimos 7 dias</div>
    </header>
  );
}
