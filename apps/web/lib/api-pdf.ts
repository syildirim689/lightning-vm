"use client";
// The API reference as a PDF, made in the browser (pdfmake, loaded only when asked): a cover, contents with page
// numbers, the guide, the common errors, then every route of the chosen list with its fields, example and code.
import { curl, exampleBody, guide, type Endpoint, type Field, type Lang, type Reference } from './api-reference';

type T = (key: string, values?: Record<string, string | number>) => string;
type Node = Record<string, unknown> | string;

const methodColor: Record<string, string> = { GET: '#0f766e', POST: '#1d4ed8', PUT: '#a16207', PATCH: '#a16207', DELETE: '#b91c1c', ALL: '#475569' };
const code = (text: string): Node => ({ table: { widths: ['*'], body: [[{ text, fontSize: 7.5, preserveLeadingSpaces: true, color: '#111827' }]] },
  layout: { fillColor: () => '#f3f4f6', hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 6, paddingRight: () => 6, paddingTop: () => 5, paddingBottom: () => 5 }, margin: [0, 2, 0, 6] });

function fieldTable(title: string, fields: Field[], lang: Lang, t: T): Node[] {
  if (!fields.length) return [];
  return [{ text: title, style: 'label' }, {
    table: { headerRows: 1, widths: ['auto', 'auto', 'auto', '*'], body: [
      [t('pdf.field'), t('pdf.type'), t('pdf.required'), t('pdf.meaning')].map((x) => ({ text: x, style: 'th' })),
      ...fields.map((f) => [{ text: f.name, style: 'mono' }, { text: f.type, style: 'small' }, { text: f.required ? '✓' : '', style: 'small', alignment: 'center' },
        { text: [f.text[lang], ...(f.values?.length ? [{ text: `  (${f.values.join(', ')})`, color: '#6b7280' }] : [])], style: 'small' }]),
    ] }, layout: 'lightHorizontalLines', margin: [0, 2, 0, 6] }];
}

function endpoint(e: Endpoint, lang: Lang, t: T): Node[] {
  const meta = [
    e.auth === 'public' ? t('pdf.public') : e.permissions.length ? t('pdf.permission', { list: e.permissions.join(' / ') }) : t('pdf.signedIn'),
    e.method !== 'GET' && e.method !== 'HEAD' ? t('pdf.writeToken') : '',
    e.tokens === false ? t('pdf.panelOnly') : '', e.idempotencyKey ? t('pdf.idempotency') : '',
    t('pdf.status', { status: e.status }),
  ].filter(Boolean).join('  ·  ');
  const body = exampleBody(e);
  return [
    { text: [{ text: `${e.method} `, color: methodColor[e.method] ?? '#111827', bold: true }, { text: e.path, bold: true }], style: 'route', id: e.key, tocItem: false },
    { text: e.summary[lang], margin: [0, 1, 0, 2] },
    ...(e.details ? [{ text: e.details[lang], style: 'small', color: '#374151', margin: [0, 0, 0, 2] }] : []),
    { text: meta, style: 'meta' },
    ...fieldTable(t('pdf.params'), e.params ?? [], lang, t),
    ...fieldTable(t('pdf.query'), e.query ?? [], lang, t),
    ...fieldTable(t('pdf.body'), e.body ?? [], lang, t),
    ...(body !== undefined ? [{ text: t('pdf.example'), style: 'label' }, code(JSON.stringify(body, null, 2))] : []),
    { text: 'cURL', style: 'label' }, code(curl(e)),
    ...(e.returns ? [{ text: [{ text: `${t('pdf.returns')}: `, bold: true }, e.returns[lang]], style: 'small', margin: [0, 0, 0, 2] }] : []),
    ...(e.errors?.length ? [{ text: [{ text: `${t('pdf.errors')}: `, bold: true }, { text: e.errors.join(', '), style: 'mono' }], style: 'small' }] : []),
    { canvas: [{ type: 'line', x1: 0, y1: 4, x2: 515, y2: 4, lineWidth: 0.5, lineColor: '#e5e7eb' }], margin: [0, 4, 0, 8] },
  ];
}

export async function downloadReferencePdf(ref: Reference, list: Endpoint[], lang: Lang, t: T, brand: string) {
  const [pm, fonts] = await Promise.all([import('pdfmake/build/pdfmake'), import('pdfmake/build/vfs_fonts')]);
  // Both are CommonJS bundles; depending on the bundler the export sits one "default" deeper.
  const pdfMake = pm.default.default ?? pm.default;
  pdfMake.addVirtualFileSystem(fonts.default.default ?? fonts.default);
  const date = new Intl.DateTimeFormat(lang === 'tr' ? 'tr-TR' : 'en-GB', { dateStyle: 'long', timeStyle: 'short' }).format(new Date());
  const content: Node[] = [
    { text: brand, fontSize: 12, color: '#6b7280', margin: [0, 180, 0, 6] },
    { text: t('pdf.title'), fontSize: 28, bold: true },
    { text: t('pdf.subtitle'), fontSize: 13, color: '#374151', margin: [0, 6, 0, 30] },
    { table: { widths: ['auto', '*'], body: [
      [{ text: t('pdf.baseUrl'), style: 'th' }, { text: ref.baseUrl, style: 'mono' }],
      [{ text: t('pdf.version'), style: 'th' }, ref.version],
      [{ text: t('pdf.date'), style: 'th' }, date],
      [{ text: t('pdf.count'), style: 'th' }, t('pdf.countValue', { n: list.length })],
    ] }, layout: 'noBorders' },
    { text: t('pdf.scope'), style: 'small', color: '#6b7280', margin: [0, 24, 0, 0] },
    { toc: { title: { text: t('pdf.contents'), style: 'h1' }, numberStyle: { fontSize: 9 }, textStyle: { fontSize: 9 } }, pageBreak: 'before' },
    { text: t('guideTitle'), style: 'h1', tocItem: true, pageBreak: 'before' },
  ];
  for (const g of guide) {
    content.push({ text: t(`guide.${g.id}.title`), style: 'h2', tocItem: true, tocMargin: [12, 0, 0, 0] });
    for (let i = 1; i <= g.paras; i++) content.push({ text: t(`guide.${g.id}.p${i}`, { rate: ref.limits.rateLimit, days: ref.limits.maxDays }), margin: [0, 0, 0, 5], lineHeight: 1.2 });
    if (g.code) content.push(code(g.code(ref.baseUrl)));
    if (g.errors) content.push({ table: { headerRows: 1, widths: ['auto', 'auto', '*'], body: [
      [t('pdf.status', { status: '' }).trim(), t('pdf.code'), t('pdf.meaning')].map((x) => ({ text: x, style: 'th' })),
      ...ref.commonErrors.map((x) => [String(x.status), { text: x.code, style: 'mono' }, { text: x.text[lang], style: 'small' }]),
    ] }, layout: 'lightHorizontalLines', margin: [0, 0, 0, 8] });
  }
  for (const tag of ref.tags) {
    const items = list.filter((e) => e.tag === tag.key);
    if (!items.length) continue;
    content.push({ text: tag.name[lang], style: 'h1', tocItem: true, pageBreak: 'before' }, { text: tag.text[lang], color: '#4b5563', margin: [0, 0, 0, 10] });
    for (const e of items) content.push({ stack: endpoint(e, lang, t), unbreakable: (e.body?.length ?? 0) + (e.query?.length ?? 0) < 4 });
  }
  const doc = {
    info: { title: `${brand} — ${t('pdf.title')}`, subject: t('pdf.subtitle'), creator: brand },
    pageSize: 'A4', pageMargins: [40, 50, 40, 50],
    header: (page: number) => page > 1 ? { text: `${brand} · ${t('pdf.title')}`, fontSize: 7.5, color: '#9ca3af', margin: [40, 22, 40, 0] } : '',
    footer: (page: number, pages: number) => page > 1 ? { columns: [{ text: ref.baseUrl, fontSize: 7.5, color: '#9ca3af' },
      { text: `${page} / ${pages}`, alignment: 'right', fontSize: 7.5, color: '#9ca3af' }], margin: [40, 16, 40, 0] } : '',
    content,
    defaultStyle: { font: 'Roboto', fontSize: 9.5, color: '#111827' },
    styles: {
      h1: { fontSize: 17, bold: true, margin: [0, 0, 0, 8] }, h2: { fontSize: 12.5, bold: true, margin: [0, 10, 0, 4] },
      route: { fontSize: 10.5, margin: [0, 2, 0, 0] }, meta: { fontSize: 7.5, color: '#6b7280', margin: [0, 0, 0, 4] },
      label: { fontSize: 8, bold: true, color: '#374151', margin: [0, 3, 0, 1] }, th: { fontSize: 8, bold: true, color: '#374151' },
      small: { fontSize: 8 }, mono: { fontSize: 8, color: '#1f2937' },
    },
  };
  await pdfMake.createPdf(doc).download(`${brand.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-api-${lang}.pdf`);
}
