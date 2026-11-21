# Changelog

All notable changes to Lightning VM are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is below 1.0 the project is in
**beta**: any release may change behaviour, and each one says what an operator has to do.

Operators who upgrade an installed panel should read [docs/upgrade-notes.md](docs/upgrade-notes.md) (Turkish): it
lists every changed behaviour with its effect on existing data. Releases are published at
<https://github.com/syildirim689/lightning-vm/releases>.

*Türkçe: Bu dosya sürümler arasında nelerin değiştiğini özetler. Kurulu bir paneli yükseltmeden önce ayrıntılı ve
Türkçe [docs/upgrade-notes.md](docs/upgrade-notes.md) sayfasını okuyun.*

## [Unreleased]

### Added

- **E-mail address verification for registered accounts.** After registration the panel mails a six-digit code
  (valid for 30 minutes, with a link that opens Account → Profile). The code counts only in a signed-in session of
  that account, so nothing on the account is removed. Account → Profile shows an unverified address with a resend
  button (one mail a minute, five an hour, ten a day per account). Settings → Sign-in security has a new switch,
  **off by default**, that keeps accounts with an unverified address from ordering a server
  (`403 EMAIL_NOT_VERIFIED`); Settings → E-mail has a switch for the verification mail, on by default. Without
  working mail the feature hides itself and the order rule is not applied. Addresses already proven (first sign-in
  by link or code, first password reset by mail, accounts made by staff, a directory, single sign-on or the billing
  integration) stay verified. New routes: `GET /api/account/email-verification`, `POST …/send`, `POST …/confirm`;
  `GET /api/auth/me` now returns `emailVerified`. See [docs/auth.md](docs/auth.md#e-posta-adresi-doğrulama).
- **Usage watch.** Once an hour the worker compares every server's CPU and network use with its own recent history
  (median and median absolute deviation, a minimum of history, separate thresholds to open and to close). The owner
  sees a finding with its numbers on the server's page and in the insights, can hide it, and is told once
  (`server.usage_anomaly`, in-app by default). Staff get an "Unusual use" tab on the abuse page with a note when a
  finding resembles mining or an outbound flood. Platforms without CPU figures say "not enough data". Rules and
  thresholds: [docs/smart-features.md](docs/smart-features.md). Migration 088 adds two tables and one index; nothing
  for the operator to do.
- **Month-end forecast with hourly usage, and the budget against it.** "This month" now counts servers billed by the
  hour with the usage billing recorded so far (also of servers deleted since) plus their rate for the hours left,
  instead of their monthly list price. A budget is also measured against that forecast: the card and an insight say
  when the month is close to it or heading over it, and `billing.budget_forecast` tells the customer once a month.
  `GET /usage/summary` gains `costs[].hourly` and `budget.forecast`, `forecastRatio`, `forecastState`.
- **Power schedule suggestion.** When four weeks of CPU history show hours of the week in which a server is idle
  every week (nights, weekends), its page and an insight suggest the schedule that keeps it off through them, with
  the numbers behind it. One click creates it through the ordinary schedules (same permission, limit and audit
  record); nothing is created otherwise. No saving is promised that the bill does not show: a switched-off server
  is billed the same, so the page says so and gives the energy estimate instead. New routes:
  `GET` and `POST /api/servers/:id/schedule-suggestion`.
- **Payment risk.** Customers (where the panel collects by itself) get an insight when the next renewal, up to 30
  days ahead, will not go through as things stand: every saved card ends before it, or the balance is there but too
  small. Staff with `billing.view` get an "At risk" tab on the billing page and a finding: accounts with overdue
  invoices or at least two failed charges in 30 days, largest amount at risk first
  (`GET /api/admin/billing/risk`). It only lists: nothing is charged, suspended or sent.
- **Support help.** A ticket's page shows staff the closed tickets most like it, each with the answer that closed it
  and the words the two share (`GET /api/admin/support/tickets/:id/similar`). A customer writing a new ticket is
  shown, before sending, what may already answer it, from their own answered tickets and the public status page
  only (`POST /api/support/suggestions`); another customer's ticket is never read for them. Matching is by shared
  words with the search's Turkish-aware folding, inside the panel.

- **Per-project quotas.** Staff with `catalog.manage` give a project a quota of its own in Catalog → Quotas (the
  form finds projects by name or by their owner's e-mail). It replaces the owner's quota for servers ordered into
  that project and counts only that project's servers; orders outside it stay under the account's quota. The quota
  list shows what is used beside every limit; the owner sees a project's quota in Account → Projects, and the order
  summary shows the quota the order counts against as it would stand with the new server. An order, a resize or an
  extra disk over a project's quota is refused with `409 PROJECT_QUOTA_EXCEEDED`. New routes:
  `GET /api/admin/quotas/projects`, `PUT` and `DELETE /api/admin/quotas/projects/:id`; `GET /api/projects`,
  `GET /api/admin/quotas`, `POST /api/catalog/quote` and `GET /api/catalog/availability` carry the new fields.
  No project has a quota until staff give it one, so nothing changes for existing installs.
  See [docs/catalog.md](docs/catalog.md#kotalar-ve-projeler).
- **Stripe webhook.** `POST /api/billing/callback/stripe` records a Stripe payment from Stripe's signed
  notification, so a customer who pays and closes the tab no longer waits for the billing run. The signature is
  verified over the raw body with the endpoint's signing secret (the existing "Webhook signing secret" field of
  the Stripe provider, stored encrypted, one per mode), a signature older than five minutes is refused, and the
  outcome goes through the same code as the browser's return and the billing run, so a payment is recorded once
  whichever arrives first. Settings → Payments → Stripe shows the address to enter at Stripe and the two events to
  send (`payment_intent.succeeded`, `checkout.session.expired`). Tested with events signed here with a test
  secret; **not tried against Stripe itself**. Nothing changes until a signing secret is saved. See
  [docs/payments.md](docs/payments.md#stripe-webhooku).
- **Running a request from the API reference.** Every route on `/api-docs` can be sent from the page with the
  signed-in session: the request is shown before it goes, anything but a `GET` is sent only after a confirmation
  that repeats it, it can only reach this panel's documented routes, and routes that hand out secrets are not
  offered. Answers are shown without values that look like secrets. Such requests carry `X-Lightning-Try: 1` and
  are counted per person and minute against the API rate limit of Settings → API, with the same `X-RateLimit-*`
  headers; permissions, the CSRF rule and the audit log apply as for any request of that session. See
  [docs/api.md](docs/api.md#running-a-request-from-the-reference).
- **Monitoring is switched from the panel after installation.** Admin → System has a Monitoring card: what
  Prometheus, Grafana and Loki answer right now (`GET /api/admin/maintenance/monitoring`) and a switch that asks
  first. It uses the request to the host agent that backups and updates use (`POST /api/admin/maintenance/requests`
  with `action: "monitoring"` and `enabled: true|false`): the same permission (`system.update`), one maintenance
  task at a time, audited. Without the agent the card shows the command instead. The agent side
  (`install.sh monitoring on|off`) is unchanged. See [docs/operations.md](docs/operations.md#i̇zleme).

### Changed

- `GET /usage/summary`: for an account with hourly servers, `accrued` and `forecast` are now the recorded usage
  and its projection (they were the prorated monthly list price). Accounts without hourly servers get the same
  figures as before.
- **For existing installs with e-mail turned on in Settings:** accounts that register from now on receive the
  verification mail, and accounts whose address is not verified see a notice on Account → Profile. Nobody is
  blocked from anything unless the administrator turns the order rule on.

## [0.4.0] - 2026-11-21

Second public release and the first one marked **beta**. It gathers about 430 commits since 0.1.0. The version
numbers 0.1.1 to 0.3.0 were used for internal test builds and were never published, which is why this release is
0.4.0.

### Upgrading from 0.1.0

- Read [docs/upgrade-notes.md](docs/upgrade-notes.md) first. The database migrations run by themselves during
  `install.sh update`; a backup is taken before anything changes and the previous version comes back if the new
  one does not become ready.
- Restart the proxy after the upgrade (`docker compose restart proxy`): its configuration changed.
- `install.sh behind-proxy` now needs `--public-url https://panel.example.com` unless one is already stored.
- Backups are now signed. A backup written by 0.1.0 has only a checksum and is restored only with
  `--allow-unsigned`.
- After a restore everyone is signed out and the panel is **on hold** until an administrator releases it
  (Admin → System).
- Param payments are confirmed by hand; WHMCS / WISECP map only the accounts they opened themselves.
- Directory (LDAP) and SSO users sign in again every `SESSION_TTL_HOURS`; their API tokens stop working when the
  account was not confirmed at its source for `DIRECTORY_TOKEN_DAYS` days (default 30).

### Added

- **Six more platforms, as first releases**, next to VMware: Proxmox VE, XCP-ng / XenServer, oVirt / RHV,
  Microsoft Hyper-V, plain KVM hosts (libvirt over SSH) and Incus / LXD (virtual machines and containers). What
  each one can and cannot do is in the README's platform table.
- **Installer experience.** `scripts/get.sh` and `scripts/install.sh` ask for the language once on a terminal
  (Türkçe / English), print a pre-flight report (operating system, CPU, memory, disk, ports, DNS, Docker, clock,
  what is installed already) and a plan, and run numbered steps with a spinner, elapsed times and a summary at
  the end. Not on a terminal (CI, cloud-init, the panel's agent) the output stays line-oriented and nothing is
  ever asked. What the wrapped commands print goes to a root-only log under `data/logs/`; the end of it is shown
  when a step fails. New options: `--yes`, `--plain`, `--help` (both scripts, both languages).
- **This server from the panel**: live state of the panel host (CPU, memory, load, disks, services, processes,
  logs), operating system updates with automatic security updates and restart, host name, time zone, NTP and
  DNS settings, and an administrators' browser terminal that is off by default.
- **Updates inside customers' servers**: a notifier installed at first boot on new Linux servers; pending
  updates are shown on the server page and to staff.
- **Billing**: payments held for review with filters, reasons and a waiting time; upcoming payments for
  customers; invoices say until when a review blocks paying.
- **Staff tools**: saved views on the long lists (stored in the account), bulk selection, counters in the menu,
  three more insights, the state of a server at the time its support ticket was opened, a user's sign-in details
  with two-factor reset, passkey and linked-account management.
- **Interface**: dialogs behave like windows (move, put aside, snap to halves and quarters, centre, resize,
  keyboard shortcuts and a layout menu); sliders for text size and spacing; a search that understands Turkish
  letters; a command palette with recent items and quick actions.
- **Project**: this changelog, a code of conduct, a support page, issue-template links to Discussions, private
  vulnerability reporting, an English README (`README.en.md`), and a GitHub Release created by the release
  workflow for every `v*` tag.

### Changed

- 49 behaviour changes from an end-to-end review of the API, the worker, the web app, the seven adapters and the
  installer; the most important ones are in billing (subscriptions with automatic renewal off are invoiced,
  unpaid orders and data-centre invoices enter the collection steps).
- Views saved in the browser by an earlier build now live in the account.
- A reseller's customer who leaves the reseller pays list prices from then on.
- Time spent waiting for the account's share of the queue no longer counts against an operation's deadline
  (`OPERATIONS_HELD_HOURS`, default 6).
- The installer checks the host **before** it installs Docker or writes any file, and on a terminal asks before
  it starts (`--yes` skips the question; without a terminal nothing is asked).
- The one-line install command is served from the short address `https://lightningvm.app/install.sh`.

### Fixed

- Notification e-mails are sent again (they were not under Node 22).
- Phone layout: window buttons, the command palette, invoice lines and the selection bar fit the screen; pages
  leave room under the selection bar from 768 px on.
- A key pressed in the frame in which a window loses the focus goes to the window in front.
- On Proxmox the VM number is bound to the server.

### Security

- Two rounds of an AI-driven, partial security review (November 2026): 48 confirmed findings fixed (1 high,
  20 medium, 26 low, 1 informational), followed by a re-read of the units the first round had closed without a
  finding and of what the second round had left open. Not an independent third-party audit; its limits are listed
  in [docs/security-audit.md](docs/security-audit.md).
- Backups are signed with a key derived from `secrets/backup.key`; a restore checks the signature before
  anything is decrypted, works on a root-only copy of the archive, ends every session and puts the panel on hold.
- The maintenance directory and its lock belong to root alone; a panel request is validated again on the host
  before anything runs.
- Sign-in routes the panel does not use are closed; servers managed by WHMCS / WISECP cannot be resized from the
  panel; a first password reset on an account with an unproven address removes its API tokens, SSH keys and
  saved cards.

### Known limits

- Not audited by an independent third party and not recommended for production with real customers and real
  money before you have tried it in your own environment.
- VMware was tested mostly against the govmomi simulator; no payment provider was tried with a real merchant
  account. The full list is in the README ("Bilinen sınırlar" / "Known limits").

## [0.1.0] - 2026-10-24

First tagged version.

### Added

- One-command installation (`scripts/get.sh`, `scripts/install.sh`): Docker, HTTPS, the first administrator,
  backups and the panel agent.
- VMware ESXi / vCenter connections (6.x to 9.x), inventory and a browser console.
- Catalog: locations, packages, custom resources, templates, IP pools and quotas.
- Automatic server setup (cloud-init), power actions, deletion and reconciliation.
- Firewalls (vDS port filter).
- IP management: extra IPv4, IPv6, quarantine and reverse DNS (PowerDNS).
- Users, roles and permissions, two-factor sign-in and phone verification.
- Settings: branding, SMTP, CAPTCHA, SMS providers, payment methods and notification rules.
- Updates and backups from the panel, monitoring and alerts.

[Unreleased]: https://github.com/syildirim689/lightning-vm/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/syildirim689/lightning-vm/compare/v0.1.0...v0.4.0
[0.1.0]: https://github.com/syildirim689/lightning-vm/releases/tag/v0.1.0
