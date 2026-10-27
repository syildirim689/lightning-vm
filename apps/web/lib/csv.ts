// A CSV the browser saves: UTF-8 with BOM (Excel), quoted cells, formula-looking values defused.
export function downloadCsv(name: string, head: string[], rows: unknown[][]) {
  const cell = (v: unknown) => { const x = String(v ?? ''); return `"${(/^[=+\-@]/.test(x) ? `'${x}` : x).replace(/"/g, '""')}"`; };
  const url = URL.createObjectURL(new Blob(['\ufeff' + [head.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${name}-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
