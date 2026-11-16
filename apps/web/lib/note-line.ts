// Turkish lower case, with the dotless ı read as i: "Invoice" and "invoice", "IĞDIR" and "ığdır" match. One character in, one out.
// Text as people type it when they search: no capitals, no accents, one "i" for Turkish İ, I, ı and i.
export const fold = (v: string) => v.replace(/[İIı]/g, 'i').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// The note line a card shows: around the search match when the note matched, else its first line.
export function noteLine(notes: string, q: string) {
  const at = q.trim() ? fold(notes).indexOf(fold(q.trim())) : -1;
  const start = at < 0 ? 0 : Math.max(notes.lastIndexOf('\n', at) + 1, at - 20); // the match's line, cut to ~20 chars before it
  const line = notes.slice(start).split('\n').find((l) => l.trim()) ?? '';
  return start && notes[start - 1] !== '\n' ? `…${line}` : line;
}
