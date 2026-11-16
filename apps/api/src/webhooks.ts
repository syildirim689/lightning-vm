// Webhooks: every notification a person receives (notify.ts) is also POSTed to their webhooks that subscribe to it,
// as JSON signed with the webhook's secret (Stripe-style: "t=<unix>,v1=<hex HMAC-SHA256 of `${t}.${body}`>").
// Deliveries are queued and retried with backoff; many consecutive failures switch the webhook off and tell its owner.
import { Queue, Worker } from 'bullmq';
import { createHmac, randomUUID } from 'node:crypto';
import { guardedRequest } from './chat-apps';
import { pool, redis } from './db';
import { logEvent } from './log';
import { decryptSecret } from './secrets';

const queue = new Queue('webhooks', { connection: redis });
const attempts = 8;
export const offAfterFailures = 20;

export function sign(secret: string, body: string, at = Math.floor(Date.now() / 1000)) {
  return `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`;
}

// Called by the notification worker for the people an event reached.
export async function queueWebhooks(event: string, userIds: string[], data: Record<string, string>) {
  if (!userIds.length) return;
  const { rows } = await pool.query("SELECT id FROM webhooks WHERE user_id = ANY($1::uuid[]) AND active AND ($2 = ANY(events) OR '*' = ANY(events))", [userIds, event]);
  for (const w of rows) {
    const id = randomUUID();
    await pool.query("INSERT INTO webhook_deliveries (id, webhook_id, event, status) VALUES ($1, $2, $3, 'pending')", [id, w.id, event]);
    await queue.add('deliver', { deliveryId: id, webhookId: w.id, payload: { id, event, createdAt: new Date().toISOString(), data } },
      { jobId: id, attempts, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: true, removeOnFail: 100 }).catch(() => logEvent('error', 'webhook_enqueue_failed', { event }));
    // The newest 100 deliveries per webhook are kept for its page.
    await pool.query(`DELETE FROM webhook_deliveries WHERE webhook_id = $1 AND id NOT IN (SELECT id FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 100)`, [w.id]);
  }
}

// One POST; the answer is judged by its status (2xx is success). Redirects are not followed.
export async function post(url: string, secret: string, payload: { id: string; event: string }) {
  const body = JSON.stringify(payload);
  const started = Date.now();
  try {
    // Checked and connected in one step, to the address that was checked (chat-apps.ts).
    const r = await guardedRequest(url, { timeoutMs: 10_000, body, headers: { 'content-type': 'application/json', 'user-agent': 'LightningVM-Webhook/1', 'x-lightning-event': payload.event,
      'x-lightning-delivery': payload.id, 'x-lightning-signature': sign(secret, body) } });
    return { ok: r.status >= 200 && r.status < 300, code: r.status, error: r.status >= 200 && r.status < 300 ? null : `HTTP ${r.status}`, ms: Date.now() - started };
  } catch (e) {
    const name = (e as Error).name;
    return { ok: false, code: null, error: name === 'NotPublic' ? 'WEBHOOK_URL_NOT_PUBLIC' : name === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE', ms: name === 'NotPublic' ? 0 : Date.now() - started };
  }
}

export function startWebhookWorker() {
  const connection = redis.duplicate({ maxRetriesPerRequest: null });
  const worker = new Worker('webhooks', async (job) => {
    const { deliveryId, webhookId, payload } = job.data as { deliveryId: string; webhookId: string; payload: { id: string; event: string } };
    const { rows: [w] } = await pool.query('SELECT * FROM webhooks WHERE id = $1 AND active', [webhookId]);
    if (!w) return;
    const r = await post(w.url, decryptSecret(w.secret_enc, `webhook:${w.id}`), payload);
    const last = r.ok || job.attemptsMade + 1 >= attempts;
    await pool.query('UPDATE webhook_deliveries SET status = $2, attempts = attempts + 1, response_code = $3, error = $4, duration_ms = $5, updated_at = now() WHERE id = $1',
      [deliveryId, r.ok ? 'succeeded' : last ? 'failed' : 'pending', r.code, r.error, r.ms]);
    if (r.ok) { await pool.query('UPDATE webhooks SET failures = 0 WHERE id = $1 AND failures > 0', [w.id]); return; }
    if (!last) throw new Error(r.error ?? 'failed'); // BullMQ retries with backoff
    const { rows: [n] } = await pool.query('UPDATE webhooks SET failures = failures + 1, active = failures + 1 < $2 WHERE id = $1 RETURNING failures, active', [w.id, offAfterFailures]);
    if (n && !n.active) {
      const { notify } = await import('./notify');
      await notify('account.webhook_disabled', [w.user_id], { url: w.url, failures: String(n.failures) });
    }
  }, { connection, concurrency: 4 });
  worker.on('error', () => logEvent('error', 'webhook_queue_error'));
  worker.on('closed', () => connection.disconnect());
  return worker;
}
