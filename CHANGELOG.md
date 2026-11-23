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

Everyday helpers from a usability review of the customer, reseller and admin sides ([docs/ux-review.md](docs/ux-review.md):
34 findings, 5 high, 17 medium, 12 low; 22 fixed, 1 in part, 11 left with the reason). Everything is computed inside
the panel from its own data; nothing acts without a click ([docs/smart-features.md](docs/smart-features.md#günlük-işi-kolaylaştıranlar)).

### Upgrading

No migration and no new `.env` variable. New routes: `GET /api/operations/estimates` and `POST /api/auth/stay`;
`GET /api/auth/me` gains `session` (when the browser session ends and whether it can be extended),
`GET /api/operations/active` gains `diskGb`, and `GET /api/admin/onboarding` gains health steps with `group` and
`detail`. The API keeps the outcome of the last mail it sent (no address, no subject) in Redis for 30 days. A new audit
event, `session.extended`, and a new error code, `SESSION_FIXED`.

### Added

- Running operations say how long such operations usually take on this installation ("Usually about 2 minutes"), from
  the median of earlier ones of the same kind and disk size, and "Taking longer than usual" past the slow ones; with
  fewer than five earlier ones nothing is said. The server page shows the time so far and what the figure is based on,
  and a long operation that just finished says how long it took.
- Removing an SSH key, a project, a power schedule, a server from a firewall or a canned reply asks nothing: the item
  leaves the list with "Undo" for a few seconds, and the request is sent only when the message goes (or the tab is
  closed). An undone removal never reaches the API, so the audit log records only what happened.
- Five minutes before the browser session ends a bar says when and why. "Stay signed in" renews it, only on the click;
  a fixed end ("sign in as", a directory or single sign-on account, a role's session length) is explained instead.
- When the panel's server stops answering, every list stops polling and one small request retries after 2, 4, 8, 16 and
  then every 30 seconds, or at once with "Try now"; the first answer resumes the page without a reload.
- The admin dashboard's setup list also checks what keeps an installation healthy: the last mail went out, backups are
  scheduled, monitoring is on, updates (automatic, or the newest version running), a payment method (when billing is
  on) and staff accounts without two-factor. Each step says what it is based on and links to where it is fixed; "Hide
  until something changes" puts the list away until a step opens that was fine.
- The order form starts from the person's newest server (location, image, package or size, project, as far as the
  catalog still offers them) and says so, with "Start empty"; the order draft keeps the chosen firewalls.
- A pasted SSH key shows its type, size and comment; a key broken over lines is joined, the SSH2 (RFC 4716) form is
  turned into the OpenSSH line, and a private key, a PuTTY file, a security-key (sk-) or DSA key is named for what it is.
  A list pasted one per line into a one-line field (a firewall's sources) keeps its entries apart.
- Error messages name the cause and the next step where the text had none: a code without a sentence is named, an
  answer without a code (a proxy or gateway page) gives its HTTP status.

### Changed

- Going back to a snapshot asks for the server's name, like a backup restore, and says from when the data is lost.
- The bulk delete confirmation names the grace period's hours; without a grace period the button is not offered (the
  API refused it after the confirmation).
- A change sent while the panel does not answer fails at once and keeps the form, instead of waiting to run later.

### Fixed

- After a confirmation dialog closes, focus is back on the button that opened it (Escape right after cancelling the
  restart in a service's drawer now closes the drawer); dialogs opened from the server list's menu give focus back to
  its "…" button.
- "Order similar" cleared neither an earlier copy draft nor carried the project over.
- The admin server list said "You have no servers yet" when empty; the users list said "No matching users" without a
  filter.
- Small icon buttons (a tag's ×, an attachment's ×, coupon copy, location ping) get a 44 px touch area on touch screens.

## [0.6.0] - 2026-11-23

Fifth public release, still **beta**. Three things are new since 0.5.1: Admin → System lists every published
version, opens each service's detail with its version and log and restarts it through the host agent, and its
charts move; forms propose a name where the panel can work one out, and authenticator apps and passkey managers show
the panel's own name; and Admin → System, Statistics and Energy each open a live wall, a full-screen, real-time 3D
view for a TV or a second screen. The live walls were measured only on a software renderer, not on a real graphics
card or a TV ([docs/validation.md](docs/validation.md)).

### Upgrading from 0.5.1

Update from Admin → System → Updates or with `sudo sh scripts/install.sh update`. There is no migration, no new
`.env` variable and no setting to change. The web image gains one dependency, three.js (0.187.0, MIT), loaded only
on the live walls; the other images are unchanged in that respect. The versions list on Admin → System → Updates is
rewritten at the end of the update, also when it is run from the command line, so it names 0.6.0 as running right
after the update. Restarting a service from the panel goes through the host agent like a backup or an update and
needs `system.update`; postgres and redis are refused. The owner of a passkey can now rename it, and
`GET /api/admin/power` gives each host's newest sample time (`hosts[].lastAt`), an added field.
[docs/upgrade-notes.md](docs/upgrade-notes.md) (Turkish) says what an operator sees.

### Added

- Live walls: full-screen, real-time 3D views of Admin → System (`/wall/system`), Statistics (`/wall/stats`) and
  Energy (`/wall/energy`) for a TV or a second screen, as usable on a laptop and a phone
  ([docs/live-walls.md](docs/live-walls.md)). Each is opened from a labelled button on its page (on System right
  before "All good" / "N warnings"), with the same permission as that page and no public address. System is a rack row
  where every unit is a service of the stack (lights steady, blinking or dim by its state, its activity light
  flickering with the service's own processor use, a faulty unit standing out of the rack with a striped plate and a
  FAULT badge), glass gauges for processor, memory, disk and load and the last ten minutes as ribbons; Statistics is
  the period's measures as rows of towers, one per day; Energy is each host's power flowing to the facility as light,
  faster with more watts, dashed for estimated hosts, with the last 24 hours around the core. Every value comes from
  the page's own API answers, read by one poller per wall at the page's pace (paused in a hidden tab, backing off
  after errors); old data is drawn grey and still and says since when. three.js (0.187.0, MIT) loads only on these
  pages; the quality (high, medium, low) is chosen from the device and adjusted while it runs by a frame-time
  governor, and a designed 2D wall with the same figures replaces 3D where there is no WebGL 2, only a software
  renderer, or under 20 frames a second. Reduced motion keeps the camera still and the lights steady; keys F (full
  screen), Esc (back), ← → (other walls), T (tour), I (details); a night and a day look; optional screen wake lock.
  `GET /api/admin/power` gives each host's newest sample time (`hosts[].lastAt`).
- Forms propose a name where the panel can work one out, instead of an empty field ([docs/proposals.md](docs/proposals.md)
  has the full list and what is deliberately left empty). The proposal is an ordinary, editable value, selected when
  the field is entered so typing replaces it, marked "Proposed by the panel"; it follows what it is made from until the
  person types, is free among the person's own names (" 2", " 3"…), respects each field's length and characters, and is
  in the panel's language. Nothing that exists is ever renamed. A passkey: browser · system · device, read in the
  browser only ("Chrome · Windows · Desktop"), with "Security key" or "Phone" in front once the browser says the
  passkey is on one. An API token: its access and the day. An SSH key: the key's comment, else its type and fingerprint.
  A snapshot: the server and the local date and time ("web-1 2026-11-23 14:05"). Also a webhook (its host), project,
  chat connection, private network, firewall (its template) and firewall rule (the port's service, "HTTPS"), saved
  console command and, for staff, pool, package ("2 vCPU · 4 GB · 40 GB"), image, IP pool, location, ISO source, canned
  reply and hypervisor connection. A ticket's subject is never filled in: the message's first line is offered with one
  click. A field that still holds the proposal does not count as unsaved work.
- Authenticator apps and passkey managers show the installation's own name (Settings → Branding) instead of
  "Lightning VM", and the account by its e-mail address: the TOTP URI's label and `issuer` both, percent-encoded (a
  space is `%20`, not `+`); the WebAuthn `rp.name`, `user.name` and `user.displayName` (better-auth used the passkey's
  own name as the user name). The setup dialog says how the app will list it; the backup codes download as
  `<panel-name>-backup-codes.txt`. The owner of a passkey can rename it (`POST /api/auth/passkey/update-passkey`).

- Admin → System → Server state → Services: a click on a service opens its detail (a drawer, also on a phone):
  state, health check, exit code, started and ended, restarts, image, version, ports, what the state means and what
  to do (Turkish and English), and the last 200 lines of its log, refreshable. Log lines are for administrators only;
  what looks like a secret (Authorization and Cookie headers, Bearer tokens, passwords and keys as `key=value`, the
  password of a connection string, JWTs, private keys) is masked by the API, and the host agent masks more than
  before. The browser drops the lines when the drawer closes.
- A service is restarted from that drawer through the host agent (`POST /admin/maintenance/requests`, action
  `service`, `act` `restart` or `run`; `install.sh service restart|run <name>`): staff with `system.update`, a
  confirmation that says what is interrupted, one maintenance task at a time, audited. The name must be a service of
  the compose file in the agent's last snapshot. postgres and redis are refused (409 `SERVICE_PROTECTED`, with the
  command to run on the server); api, web and proxy are restarted by the agent after the panel has answered; a
  one-shot job is not restarted (`SERVICE_ONE_SHOT`), and migrate can be run again (it applies only what is not yet
  recorded). New `GET /admin/host/services/:name`.
- Every service shows its version: the panel's version and commit for the services built with the panel, the version
  PostgreSQL and Redis report, else the image's version label or its tag.
- The server-state charts animate: drawn in from the left the first time, sliding one step with each new sample,
  value and time on hover. Nothing moves when the browser asks for reduced motion.

### Fixed

- Host names proposed for a copy of a server stay valid for a 63-character original (it used to propose the
  original's own name), and Turkish letters such as "ı" are written plainly instead of becoming a hyphen.
- A one-shot job that ended with exit code 0 (migrate) is shown as "Completed" with when, not as a stopped
  service. Which services are one-shot is read from the compose definition (`restart: "no"`, or another service
  waits for it with `service_completed_successfully`); a non-zero exit, a restart loop and a failing health check
  are faults.
- Admin → System → Updates lists every published version of the channel, newest first (it stopped at the newest
  ten), marks the running one (or the release a build between releases is based on) and shows each version's
  section of CHANGELOG.md. The list is rewritten after every update, also one run from the command line (before,
  only a panel request did that, so the demo's list still described v0.3.0), and once a day by the maintenance
  timer; the page says when the list was written for another version.

## [0.5.1] - 2026-11-22

Fourth public release, still **beta**. Three fixes since 0.5.0 and nothing new: resizes asked for at the same
moment can no longer together exceed a quota, a location's capacity or a reseller's allocation, and
Admin → Statistics fits a phone's width.

### Upgrading from 0.5.0

Update from Admin → System → Updates or with `sudo sh scripts/install.sh update`. There is no migration and no
setting to change. A resize that is accepted and not finished now counts in the quota, in the location's reserved
capacity and in the reseller's usage, so those figures rise when the resize is accepted instead of when it ends;
[docs/upgrade-notes.md](docs/upgrade-notes.md) (Turkish) says what an operator sees.

### Fixed

- **Resizes asked for at the same moment could together exceed a quota.** A resize was measured against the quota
  when it was accepted, without a lock, and the usage rose only when the worker had resized the server: two servers
  of one account (or of one project with a quota of its own) grown at the same moment, or one shortly after the
  other, were each measured against the same free room, and both were accepted. Known since before 0.4.0 and
  written down as open in 0.5.0. A resize is now admitted in one transaction under the owner's lock (the lock an
  order and an extra disk count under), and an accepted resize that has not finished counts with the size it grows
  to, for the next resize, an order, an extra disk, the quote and the quota lists. The request that no longer fits
  gets the quota's own refusal (`409 QUOTA_EXCEEDED`, or `409 PROJECT_QUOTA_EXCEEDED`); a second resize of the same
  server is still `409 OPERATION_IN_PROGRESS`. A failed resize gives its room back, so staff's retry of it
  (`POST /api/admin/operations/:id/retry`) is admitted again like a new resize and can now be refused by the quota.
  The billing integration's change of package stays outside the quota, as before. No database change.
  *Türkçe: aynı anda istenen boyut büyütmeleri birlikte kotayı aşabiliyordu; artık sahibin kilidi altında tek tek
  kabul edilir ve kabul edilmiş, bitmemiş büyütme kullanıma sayılır
  ([docs/validation.md](docs/validation.md#050dan-sonra-yeniden-boyutlandırmada-kota--2026-11-21)).*
- **Resizes asked for at the same moment could together take a location's last capacity or a reseller's last
  allocation.** Both are counted across accounts, and a resize read them without a lock and without counting
  resizes that were accepted and not finished; the owner's lock of the entry above does not keep two accounts
  apart. A resize now takes, in the transaction that accepts it, the location's lock (the one an order counts
  capacity under) and then the reseller's, and an accepted resize counts with the size it grows to in the
  location's reserved capacity and in the reseller's usage (the locations list, the capacity metrics, the reseller's
  summary and the resellers list show the same figures admission uses). The request that no longer fits gets
  `409 CAPACITY_EXHAUSTED` or `409 RESELLER_ALLOCATION_EXCEEDED`. Staff's retry of a failed resize is admitted the
  same way. Two smaller windows of the same kind are closed with the same locks: orders of two customers of one
  reseller in two locations could together exceed the reseller's allocation, and two extra disks of two accounts
  could together take a location's last storage. Every such transaction locks in one order (owner's account,
  server, location, reseller). No database change.
  *Türkçe: aynı anda istenen boyut büyütmeleri konumun son kapasitesini ya da bayinin son tahsisini birlikte
  alabiliyordu; artık konumun ve bayinin kilidi altında kabul edilir ve bekleyen büyütme ikisinde de sayılır
  ([docs/validation.md](docs/validation.md#050dan-sonra-boyut-büyütmede-konum-kapasitesi-ve-bayi-tahsisi--2026-11-21)).*
- **Admin → Statistics scrolled sideways on a phone.** At 390 px the page was 202 px wider than the screen as soon
  as its numbers had loaded. The last two cards ("Biggest customers" and "When people act") sit in a grid that has
  one column on a narrow screen, and that column was as wide as its widest content: the heatmap, 34rem wide and
  meant to scroll inside its own card, widened the card, its neighbour and the page instead. The column may now be
  narrower than its content (as the two-column layout of wide screens already was), so the heatmap scrolls inside
  its card and the page keeps the width of the screen; the grids of the charts and of the breakdowns got the same
  column. Nothing else on the page changed, and wider screens look as before. The browser test that walks every
  page at 390 px had not seen it: it measured a page as soon as its heading was there, which is before the API has
  answered, so it measured the placeholders; it now waits until the page's API calls have ended. No database
  change.
  *Türkçe: Yönetim → İstatistikler telefonda yana kayıyordu (390 px'te 202 px taşma); ısı haritası artık kendi
  kartının içinde kayar, sayfa ekran genişliğinde kalır
  ([docs/validation.md](docs/validation.md#050dan-sonra-istatistik-sayfasının-telefonda-taşması-ve-iki-kararsız-tarayıcı-testi--2026-11-21)).*

## [0.5.0] - 2026-11-21

Third public release, still **beta**. It gathers what was added to `main` since 0.4.0 (e-mail verification, quotas
per project, the Stripe webhook, running requests from the API reference, the monitoring switch, and seven
rule-based helpers computed inside the panel) and the faults a review of all of it found before it was tagged.
None of the helpers acts on a server, an invoice or a ticket by itself.

### Upgrading from 0.4.0

Update from Admin → System → Updates or with `sudo sh scripts/install.sh update`. Migrations 088 to 091 run by
themselves: three new tables, one new column and an index on the CPU samples; no existing table is rewritten
(with 750 000 CPU samples in place they took one to four seconds on a development machine, see
[docs/validation.md](docs/validation.md)). Two minutes after the update the worker rolls the 14 days of CPU
samples up into hourly rows once. Operators should read
[docs/upgrade-notes.md](docs/upgrade-notes.md) (Turkish) for what changes for existing accounts: the verification
mail for new registrations where mail is on, the figures of the "This month" card for hourly servers, and the new
notifications.

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
- **Quietest hours for maintenance.** From the hourly CPU history the usage watch keeps, the panel works out the two
  hours in which the servers are least busy (busy vCPUs: each server's hourly average times its vCPUs, added up),
  over four weeks, comparing only hours of the week seen in at least three of them. Admin → System → Automatic
  updates shows them for the whole installation in the panel server's own time zone, with the numbers behind them
  and a button that sets the update window to them through the ordinary request (`system.update`, one task at a
  time, audited with `suggested: true`); a connection's Hosts tab shows them for the connection and for every
  host that runs panel servers, to pick the hour before a host is emptied. It only suggests. Under 21 days of
  history, and on platforms without CPU figures, it says "not enough data". New routes:
  `GET /api/admin/maintenance/quiet-hours`, `GET /api/admin/vmware/connections/:id/quiet-hours`.
- **Periodic digest.** One message that says where things stand instead of a notice per event: weekly by default
  (or daily), on the weekday and hour a person chooses in their own time zone. **Off unless turned on.** Staff with
  `dashboard.view` turn their own on in Account → Notifications and get the panel's digest: open findings by
  severity, what opened and closed since the last digest, accounts at payment risk, failed operations and the
  capacity findings, each only where the person may see it elsewhere. Customers can have one about their own
  account (findings on their servers, the month's forecast, the upcoming renewal) only after an administrator turns
  the new `account.digest` notification on in Settings → Notifications (off by default) and the customer turns
  their own on. It is delivered as an ordinary notification (`admin.digest`, `account.digest`; inbox, e-mail,
  messaging apps), so the person's channel choice, the administrator's policy and quiet hours apply. A digest with
  nothing new to say is not sent, and each period is worked out exactly once however many API copies run. "Send me
  a preview now" sends it at once and shows its words. New routes: `GET` and `PUT /api/account/digest`,
  `POST /api/account/digest/preview`. Migration 090 adds one table; nothing for the operator to do. Rules:
  [docs/smart-features.md](docs/smart-features.md#dönemsel-özet).
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

### Fixed

Found by a review of everything added since 0.4.0, before this release was tagged (what was run:
[docs/validation.md](docs/validation.md)):

- **Power schedules could be stopped for everyone by one schedule's time zone.** A schedule could be saved with a
  time zone name the panel's runtime knows and PostgreSQL does not (Java-style short names such as `AET` anywhere;
  renamed zones such as `Asia/Calcutta`, which is what a browser in India reports, on a database without the old
  names). The scheduler reads the clock in the schedule's zone in one statement for all schedules, so that one row
  made the statement fail every minute: no power schedule, automatic snapshot or scheduled backup ran for anyone.
  A zone is now stored under a name the database knows (the renamed one where needed) or refused; the scheduler
  reads the clock only for zones the database knows, renames rows saved earlier and reports one it cannot use
  (`schedule_timezone_unknown`) instead of stopping. Admin → Statistics falls back to UTC for such a zone.
- **Usage watch: an office server was reported "far below usual" every weekend**, and a weekly job "far above
  usual" every week, each with a notice to the owner. A departure must now also hold against the same hours of the
  same weekday one and two weeks earlier. A gap in the measurements (the platform not answering, the worker
  stopped) no longer closes open findings and tells every owner again when the measurements return: a finding that
  cannot be judged is kept for six hours. Around midnight UTC two nights of history passed for the four days the
  rule needs.
- **Schedule suggestion:** working one out held the API's only thread for about a quarter of a second per server
  (a date formatter was built for every row of history), also on the overview page that asks for up to 20 servers.
  "Create these schedules" pressed twice, or in two tabs, could create the pair twice; a server one schedule short
  of its limit got the shutdown without the start. Both schedules are now written together, once.
- **Stripe webhook:** a signed "paid" for a payment the panel had already closed as failed (a charge whose answer
  never came back, a payment page finished late) was acknowledged and dropped: the invoice stayed unpaid and the
  next billing run charged the card again. It is now recorded like any other payment (on the invoice, or as balance
  when the invoice was paid meanwhile).
- **Month forecast and budget:** the periodic budget check looked at the same first 500 accounts with a budget at
  every run; with more than that, the rest were never checked. In the last three hours of a month (UTC) the forecast
  of an account with hourly servers showed next month's usage beside this month's remaining hours.
- **Payment risk:** the card warning judged "some saved card lasts", but renewals are charged to the default card
  only: an account whose default card ends before the renewal was not warned when it had a spare. A payment page
  the customer left or let expire counted as a "failed charge" in the staff list.
- **Quotas:** two extra disks asked for at the same moment on two servers of one account (or project) were both
  checked against the same free room and could together pass the quota; the check and the write are now one step
  under the owner's lock, as for an order. `PUT /api/admin/quotas/...` without a body answered 500; it is a 400.
- **Load on a small host:** the overview's insights are asked for every minute by every open page, and each call
  read a week of CPU samples for each of the account's servers (the staff list: for every running server, 400 000
  rows with 200 servers). The week's figures are now kept for ten minutes per server. The hourly usage watch
  searched all rows of a batch again for every server; it sorts them once. The index the hourly roll-up finds new
  samples with now summarizes its ranges as they fill (migration 091, a setting on the index) instead of at the
  next vacuum.
- **Version name after a release:** a panel running a commit that was tagged afterwards went on showing the
  name it was installed under (`v0.4.0-27-gabc1234`). The next update check now takes the tag's name and starts
  the services that show it again; nothing is built or migrated.
- **E-mail verification:** a wrong or late confirmation could delete a code that another request had just mailed
  to the same account. **Support suggestions:** the per-person counter could be left without its expiry and then
  silence the suggestions for good. **Insights:** hiding a finding accepts only keys the panel could have made (one
  with a NUL character answered 500) and keeps at most 500 per person. **API reference:** a secret inside a longer
  value of a JSON answer ("Bearer lvm_...") is hidden like one that stands alone.

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

[Unreleased]: https://github.com/syildirim689/lightning-vm/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/syildirim689/lightning-vm/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/syildirim689/lightning-vm/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/syildirim689/lightning-vm/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/syildirim689/lightning-vm/compare/v0.1.0...v0.4.0
[0.1.0]: https://github.com/syildirim689/lightning-vm/releases/tag/v0.1.0
