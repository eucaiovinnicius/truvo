import type { ReactNode } from 'react';

export interface Column<Row> {
  key: string;
  header: string;
  align?: 'left' | 'right' | 'center';
  render?: (row: Row) => ReactNode;
}

export function DataTable<Row extends Record<string, unknown>>({
  columns,
  rows,
  empty = 'Nenhum registro.',
}: {
  columns: Column<Row>[];
  rows: Row[];
  empty?: string;
}) {
  const alignClass = (a?: 'left' | 'right' | 'center') =>
    a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left';

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-800 bg-slate-900/50 text-xs uppercase tracking-wide text-slate-500">
            {columns.map((c) => (
              <th key={c.key} className={`px-4 py-2.5 font-medium ${alignClass(c.align)}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-8 text-center text-sm text-slate-600">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr key={i} className="border-b border-slate-800/60 last:border-0 hover:bg-slate-900/40">
                {columns.map((c) => (
                  <td key={c.key} className={`px-4 py-2.5 text-slate-300 ${alignClass(c.align)}`}>
                    {c.render ? c.render(row) : String(row[c.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
