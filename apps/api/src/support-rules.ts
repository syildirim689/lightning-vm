// Support ticket rules without the database: response deadlines (SLA), what a new message does to the status,
// and which attachments are accepted. Unit-tested; support.ts applies them.
export const priorities = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof priorities)[number];
export const statuses = ['open', 'answered', 'customer_reply', 'on_hold', 'closed'] as const;
export type Status = (typeof statuses)[number];

// Hours staff have to answer, by priority.
export const slaHours: Record<Priority, number> = { urgent: 1, high: 4, normal: 12, low: 24 };
export const dueFrom = (from: Date, p: Priority) => new Date(from.getTime() + slaHours[p] * 3_600_000);

// After a message: who it is from decides who waits next. Internal notes change nothing.
export function afterMessage(t: { status: Status; priority: Priority }, by: 'customer' | 'staff', internal: boolean, now = new Date()): { status: Status; dueAt: Date | null } | null {
  if (internal) return null;
  if (by === 'staff') return { status: 'answered', dueAt: null };
  return { status: t.status === 'open' ? 'open' : 'customer_reply', dueAt: dueFrom(now, t.priority) };
}

// A customer may reopen a closed ticket for 30 days by writing to it.
export const reopenable = (closedAt: Date | null, now = new Date()) => !closedAt || now.getTime() - closedAt.getTime() < 30 * 86_400_000;

export const overdue = (dueAt: Date | null, now = new Date()) => !!dueAt && dueAt.getTime() < now.getTime();

// Attachments: a few common types, at most 3 per message and 2 MB each. The type is checked against the file's
// first bytes as well, so a renamed executable is not accepted as an image.
export const maxFiles = 3;
export const maxBytes = 2 * 1024 * 1024;
const signatures: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  // Text: no NUL bytes in the first 4 KB.
  'text/plain': (b) => !b.subarray(0, 4096).includes(0),
};
export const allowedTypes = Object.keys(signatures);

export type Upload = { name: string; type: string; data: Buffer };
export function readAttachments(input: unknown): { files: Upload[]; error: string | null } {
  if (input === undefined || input === null) return { files: [], error: null };
  if (!Array.isArray(input) || input.length > maxFiles) return { files: [], error: 'TOO_MANY_FILES' };
  const files: Upload[] = [];
  for (const f of input as { name?: unknown; type?: unknown; data?: unknown }[]) {
    const name = typeof f?.name === 'string' ? f.name.replace(/[\\/\0]/g, '_').trim().slice(0, 120) : '';
    const type = typeof f?.type === 'string' ? f.type : '';
    if (!name || !signatures[type] || typeof f.data !== 'string') return { files: [], error: 'FILE_TYPE_NOT_ALLOWED' };
    const data = Buffer.from(f.data, 'base64');
    if (!data.length || data.length > maxBytes) return { files: [], error: 'FILE_TOO_LARGE' };
    if (!signatures[type](data)) return { files: [], error: 'FILE_TYPE_NOT_ALLOWED' };
    files.push({ name, type, data });
  }
  return { files, error: null };
}

// What the panel knew about a ticket's server when the ticket was opened: shaped here from one database row (support.ts
// reads it), so staff see the state of that moment and not of the day they answer. Nothing secret is in it: no
// passwords, tokens or the owner's notes. traffic is there only for a server with a monthly allowance.
export type TicketDiagnostics = {
  capturedAt: string;
  server: { id: string; name: string; state: string; power: string; platform: string; location: string; plan: string | null; vcpu: number; memoryMb: number; diskGb: number;
    image: string | null; addresses: string[]; locked: boolean; pendingDeletion: boolean; createdAt: string | null; traffic?: { allowanceGb: number; usedGb: number; throttled: boolean } };
  operations: { kind: string; status: string; errorCode: string | null; createdAt: string | null; finishedAt: string | null }[];
  unpaidInvoices: number;
};
const isoOf = (v: unknown) => {
  const t = v instanceof Date ? v.getTime() : typeof v === 'string' && v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const textOf = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
export function ticketDiagnostics(r: Record<string, unknown>, capturedAt = new Date()): TicketDiagnostics {
  const operations = (Array.isArray(r.operations) ? r.operations as Record<string, unknown>[] : []).slice(0, 5);
  const allowance = Number(r.traffic_gb);
  return {
    capturedAt: capturedAt.toISOString(),
    server: {
      id: textOf(r.id), name: textOf(r.name), state: textOf(r.state), power: textOf(r.power) || 'unknown', platform: textOf(r.platform), location: textOf(r.location),
      plan: typeof r.plan === 'string' && r.plan ? r.plan : null, vcpu: Number(r.vcpu) || 0, memoryMb: Number(r.memory_mb) || 0, diskGb: Number(r.disk_gb) || 0,
      image: typeof r.image === 'string' && r.image ? r.image : null, addresses: (Array.isArray(r.addresses) ? r.addresses : []).filter((a): a is string => typeof a === 'string' && !!a),
      locked: r.locked === true, pendingDeletion: r.pending_deletion === true, createdAt: isoOf(r.created_at),
      ...(r.traffic_gb != null && allowance > 0 && { traffic: { allowanceGb: allowance, usedGb: Math.round(((Number(r.traffic_bytes) || 0) / 1e9) * 10) / 10, throttled: r.traffic_throttled === true } }),
    },
    operations: operations.map((o) => ({ kind: textOf(o.kind), status: textOf(o.status), errorCode: typeof o.error_code === 'string' && o.error_code ? o.error_code : null,
      createdAt: isoOf(o.created_at), finishedAt: isoOf(o.finished_at) })),
    unpaidInvoices: Number(r.unpaid) || 0,
  };
}
