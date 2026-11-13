// The day of a moment in the person's own zone, as YYYY-MM-DD (a UTC slice would put late-evening items on the next day).
export const localDay = (at: string | Date) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));

// A CSV the browser saves: UTF-8 with BOM (Excel), quoted cells, formula-looking values defused.
export function downloadCsv(name: string, head: string[], rows: unknown[][]) {
  const cell = (v: unknown) => { const x = String(v ?? ''); return `"${(/^[=+\-@]/.test(x) ? `'${x}` : x).replace(/"/g, '""')}"`; };
  const url = URL.createObjectURL(new Blob(['\ufeff' + [head.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${name}-${localDay(new Date())}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
