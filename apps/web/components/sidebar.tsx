'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV, NAV_GROUPS } from '@/lib/nav';

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-950 text-slate-300">
      <div className="px-5 py-4 text-xl font-bold tracking-tight text-white">
        Truvo
      </div>
      <nav className="flex-1 space-y-6 overflow-y-auto px-3 pb-6">
        {NAV_GROUPS.map((group) => (
          <div key={group}>
            <div className="mb-1 px-2 text-[10px] uppercase tracking-widest text-slate-500">
              {group}
            </div>
            {NAV.filter((n) => n.group === group).map((item) => {
              const active =
                pathname === item.href || pathname.startsWith(item.href + '/');
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={
                    'block rounded-md px-3 py-1.5 text-sm transition-colors ' +
                    (active
                      ? 'bg-teal-500/15 text-teal-300'
                      : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200')
                  }
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="border-t border-slate-800 px-5 py-3 text-[10px] text-slate-600">
        Dados que você pode confiar.
      </div>
    </aside>
  );
}
