# API

Everything the panel does goes through its HTTP API under `https://<panel>/api`. Scripts use a personal API token.

## Tokens

Create one in **Account → API**. Choose read-only (GET only) or full access, and an expiry. Send it as a header:

```
Authorization: Bearer lvm_…
```

- A token acts as its owner, with the owner's permissions and their role's address rules (`allowedIps`).
- A token cannot create or remove tokens, manage webhooks, open a console, or use better-auth's `/auth/*` routes (signing in, two-factor, impersonation).
- Requests with a token need no CSRF header. They must not carry a panel cookie.
- Only a SHA-256 of the token is stored. The panel records its last use (time and address) and tells the owner by notification when a token is created.
- **Settings → Security → API tokens** decides who may create tokens: everyone, staff only, or nobody.

Errors are JSON: `{ "code": "…", "message": "…", "fields"?: { "<field>": "<CODE>" } }`.

| Status | Code | Meaning |
|---|---|---|
| 401 | `UNAUTHENTICATED` | No session, or the token is unknown, expired or removed |
| 403 | `TOKEN_READ_ONLY` | A read-only token tried to change something |
| 403 | `TOKEN_NOT_ALLOWED` | Only the panel can do this |
| 409 | `OPERATION_IN_PROGRESS` | Another operation is running on the server |

## Servers

Requests that start an operation need an `Idempotency-Key` header (8–100 characters). Repeating the request with the same key returns the first result instead of running again.

| Method and path | Body | |
|---|---|---|
| `GET /servers` | | Your servers |
| `GET /servers/:id` | | One server, its operations, and what you may do on it |
| `POST /servers` | `type` (`package` or `custom`), `poolId`, `packageId` or `vcpu`/`memoryMb`/`diskGb`, `imageId`, `name`, `sshKeyIds[]`, optional `firewallIds[]`, `rootPassword`, `extraIpv4`, `applicationId`, `projectId` | Order a server |
| `POST /servers/:id/actions` | `action`: `power_on`, `shutdown`, `power_off` or `reset` | Power |
| `POST /servers/:id/resize/quote` | same shape fields as an order | New price and what is due now |
| `POST /servers/:id/resize` | same | Change the size. The disk only grows; an increase is invoiced for the rest of the period |
| `POST /servers/:id/reinstall` | `imageId`, `confirm` (the server's name), optional `sshKeyIds[]`, `rootPassword` | Fresh install; the disk is erased |
| `GET/POST /servers/:id/snapshots`, `POST …/:snap/revert`, `DELETE …/:snap` | `name`, `description` | Snapshots |
| `DELETE /servers/:id` | `confirm` (the server's name) | Delete |
| `GET /servers/:id/metrics` | | CPU, memory, network and disk for the last hour |
| `GET /operations/active` | | Running operations |

The catalog is at `GET /catalog`; `POST /catalog/quote` prices an order. Firewalls are under `/firewalls`, SSH keys under `/ssh-keys`, and invoices under `/billing/…`.

## Webhooks

In **Account → API → Webhooks**, add an HTTPS address and pick the events. Private, loopback and link-local addresses are refused. Every event you are notified about can also go to your webhook: the same keys as in **Account → Notifications**, or `*` for all.

Each delivery is a `POST` with this JSON body:

```json
{ "id": "<delivery uuid>", "event": "server.ready", "createdAt": "2026-10-27T10:00:00.000Z", "data": { "serverId": "…", "name": "web-1", "address": "203.0.113.10" } }
```

The headers are `X-Lightning-Event`, `X-Lightning-Delivery` and `X-Lightning-Signature: t=<unix seconds>,v1=<hex>`. The `v1` value is the HMAC-SHA256 of `<t>.<raw body>` with the webhook's secret (`whsec_…`), which is shown when the webhook is created or its secret is rotated. To check a delivery:

- compute the HMAC over the body exactly as received;
- compare it in constant time;
- refuse timestamps older than a few minutes;
- skip delivery ids you have already handled.

Any 2xx answer counts as delivered. Other answers, timeouts (10 s) and network errors are retried 8 times with exponential backoff starting at 30 seconds, about two hours in all. Redirects are not followed. After 20 deliveries in a row fail, the webhook is switched off and its owner is notified. Saving the webhook again switches it back on. The newest 100 deliveries per webhook are kept and shown in the panel.
