# API

Everything the panel does goes through its HTTP API under `https://<panel>/api`. Scripts use a personal API token.

## The full reference

The panel builds its reference from the running code: **API reference** (`/api-docs`, also linked from
Settings → API and Account → API) lists every route with its method, path, the permission it needs, path, query
and body fields, an example body, example code (cURL, JavaScript, Python), what it returns and its own error codes,
in Turkish and English. It can be searched, filtered to the routes the reader may use, and downloaded as a PDF.

- `GET /docs/reference`: the same as JSON (any session or token).
- `GET /docs/openapi.json?lang=tr|en&mine=1`: an OpenAPI 3.1 document for client generators (Postman, Insomnia,
  openapi-generator). Internal routes (setup wizard, provider callbacks, health) are left out.
- How it stays right: `apps/api/src/api-reference.ts` reads the routes, guards and `@Can` permissions from the
  controllers; `apps/api/src/api-docs/*.ts` hold the words. `test/api-reference.test.mjs` fails when a route has no
  entry, an entry has no route, a text is missing in one language or a path parameter is not described.

## Running a request from the reference

Every route of the reference has a **Run this request** part ("Try it"). It sends that route to the panel you are
looking at, from your browser, with the session you are signed in with.

- **What is sent is on the page first.** The request is built from the documented route and what you typed (path
  values, the documented query fields, a JSON body) and shown as it will go: method, address, headers, body. The
  session cookie is the browser's own; the page never reads or shows it.
- **A change waits for a confirmation.** A `GET` is sent with one press. Anything else (`POST`, `PUT`, `PATCH`,
  `DELETE`) opens a dialog that repeats the request and is sent only from there. These are real requests on live
  data; there is no dry run.
- **It is not a way around anything.** The API sees an ordinary request of your session: the route's permission, the
  CSRF rule, two-factor and the audit log apply as for the same action in the panel. Routes your account may not
  call are not offered. The request goes only to this panel's own API: a path value is one encoded segment of the
  documented route (`../../x` stays `..%2F..%2Fx`), and no other address can be typed.
- **Rate limit.** Requests sent from here carry `X-Lightning-Try: 1` and are counted per person and minute against
  the limit of Settings → API (the one for tokens, default 600), with the same `X-RateLimit-*` headers and the same
  `429`. One request is sent per press; nothing repeats by itself.
- **Secrets.** Routes that hand out or change secrets (creating an API token, webhook secrets, the console: the
  ones the reference marks "panel only") are not offered here; they stay on their own screens. In an answer, text
  under a name that says secret (password, secret, token, key, cookie, credentials...) and text shaped like one
  (an API token, a signing secret, a private key) is replaced before it is shown, and the page says how many values
  it hid. A JSON answer that is cut off or does not parse is not shown at all. Nothing typed or answered is stored
  in the browser or written to its console.
- **Limits of the page.** At most 200 kB of an answer is read and 30 seconds waited; files (PDF, archives) are
  named by their type, not shown. Internal routes (setup wizard, sign-in flows, provider callbacks) are not offered.

Code: `apps/web/lib/api-reference.ts` (`buildRequest`, `maskSecrets`, `shownBody`; unit tests beside it),
`apps/web/app/(panel)/api-docs/try-request.tsx`, the count in `apps/api/src/auth.ts`; API tests in
`apps/api/test/integration/api-try.test.mjs`.

## Settings → API (administrators)

- **Who may create tokens:** everyone, staff only or nobody (the same switch Security used to hold).
- **Token life:** the longest life in days (0: none; above 0, no token without expiry), and an expiry required for staff.
- **Rate limit:** requests per token and minute (600 by default, 0: none). Every token answer carries
  `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; over the limit, `429 RATE_LIMITED` with `Retry-After`.
- **Allowed addresses:** CIDR blocks every token must come from (`403 TOKEN_ADDRESS_NOT_ALLOWED` otherwise).
- **Request log:** method, route pattern, path, status, duration, address and token of every request made with a
  token, kept 1–365 days (14 by default). Bodies are never stored. The tab shows the last 24 hours, the most called
  routes, errors and 429s.
- **All tokens:** every account's tokens with owner, access, last use and 24-hour counts; revoke one (audited). A
  token of a directory or single sign-on account that is not accepted right now is marked "asleep" (below).
- **Tokens of directory (LDAP) and single sign-on accounts** are accepted only while the account was confirmed by
  its source within `DIRECTORY_TOKEN_DAYS` (`.env`; default 30, 0 switches the rule off): by a sign-in the directory
  or the provider accepted or, for LDAP with a working service account, by the directory still listing the account
  when the token is used (asked at most once an hour per account). Otherwise the request gets
  `401 TOKEN_ACCOUNT_UNCONFIRMED`; the token is not removed and works again after the person signs in. In
  `GET /account/api-tokens` each token has `asleep` (the refusal's code, or null), and `confirmation` says for such
  an account when it was last confirmed and until when its tokens work. Details: [auth.md](auth.md) (Turkish).

## Tokens

Create one in **Account → API**. Choose read-only (GET only) or full access, and an expiry. Send it as a header:

```
Authorization: Bearer lvm_…
```

- A token acts as its owner, with the owner's permissions and their role's address rules (`allowedIps`).
- A token cannot create or remove tokens, manage webhooks, open a console, or use better-auth's `/auth/*` routes (signing in, two-factor, impersonation).
- Requests with a token need no CSRF header. They must not carry a panel cookie.
- Only a SHA-256 of the token is stored. The panel records its last use (time and address) and tells the owner by notification when a token is created.
- A token can be **narrowed** when it is made: to some of its owner's permissions (`permissions: [...]`; if the
  owner later loses one, the token loses it too) and to some addresses (`allowedIps: [...]`, IP or CIDR).
- **Settings → API** decides who may create tokens and the rules above.

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
| `POST /servers` | `type` (`package` or `custom`), `poolId`, `packageId` or `vcpu`/`memoryMb`/`diskGb`, `imageId`, `name`, `sshKeyIds[]`, optional `firewallIds[]`, `rootPassword`, `extraIpv4`, `applicationId`, `projectId`, `coupon` | Order a server |
| `POST /servers/:id/actions` | `action`: `power_on`, `shutdown`, `power_off` or `reset` | Power |
| `POST /servers/:id/resize/quote` | same shape fields as an order | New price and what is due now |
| `POST /servers/:id/resize` | same | Change the size. The disk only grows; an increase is invoiced for the rest of the period |
| `POST /servers/:id/reinstall` | `imageId`, `confirm` (the server's name), optional `sshKeyIds[]`, `rootPassword` | Fresh install; the disk is erased |
| `GET/POST /servers/:id/snapshots`, `POST …/:snap/revert`, `DELETE …/:snap` | `name`, `description` | Snapshots |
| `DELETE /servers/:id` | `confirm` (the server's name) | Delete |
| `GET /servers/:id/metrics` | | CPU, memory, network and disk for the last hour |
| `GET /operations/active` | | Running operations |
| `POST /servers/:id/transfer` | `email`, optional `note` | Offer the server to another account (open for 7 days) |
| `GET /transfers`, `POST /transfers/:id/accept`, `…/decline`, `…/cancel` | | Offers received and made; answer or withdraw one |

The catalog is at `GET /catalog`; `POST /catalog/quote` prices an order (with `coupon`, it answers the discounted first price or why the code does not apply). Firewalls are under `/firewalls`, SSH keys under `/ssh-keys`, saved console commands under `/console-snippets` (GET, POST, PUT /:id, DELETE /:id; at most 50 per person), and invoices under `/billing/…`.

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
