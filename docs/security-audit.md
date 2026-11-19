# Security audit (November 2026)

A summary for operators and contributors of the two rounds of the security audit and of what was changed because of
them. Round one ran on commit `641aa4d`, round two on commit `d9f90d3` (the code with round one's fixes). What round
two left open was worked through afterwards by source review; that is described in
[Follow-up after round two](#follow-up-after-round-two-2026-11-18) and is **not** a third audit round. The units
round one had closed without a finding were read again on 2026-11-19
([Re-review](#re-review-of-the-units-round-one-closed-without-a-finding-2026-11-19)); that is not an audit round
either. What an
operator has to do after upgrading is in [upgrade-notes.md](upgrade-notes.md) (Turkish); how to report a
vulnerability is in [SECURITY.md](../SECURITY.md).

> [!IMPORTANT]
> This was an automated, AI-driven review started by the maintainer, not an audit by an independent third party, and
> both rounds were **partial passes**. It lowers the number of known weaknesses; it does not show that there are
> none. Read [Limits](#limits) before relying on it.

## Summary of both rounds

| | Round one (`641aa4d`) | Round two (`d9f90d3`) |
|---|---|---|
| Scope | The whole repository | The areas round one left unreviewed, and a re-check of every round-one fix |
| Confirmed findings | 22: 1 high, 10 medium, 11 low | 26: 10 medium, 15 low, 1 informational |
| Leads that need an operator's decision or check | 4 | 3 |
| Candidates without an independent verdict | 10 | 4 |
| Rejected after verification | not counted | 1 |
| Fixed | all 22 | all 26 |

Together: 48 confirmed findings (1 high, 20 medium, 26 low, 1 informational), all fixed. No finding of round two is
rated high.

## Scope and method

The method was the same in both rounds: source review plus bounded checks. The project's own code was run only
inside a sandbox without network access, with dummy data (for some checks with a throw-away PostgreSQL and Redis).
Nothing was sent to a deployed panel, a hypervisor, a payment provider or any other live system. One hunting wave
ran per round, followed by one verifier per group of candidates. A finding is listed as confirmed only when a second,
fresh reviewer confirmed it, by reproducing it in the sandbox or by re-deriving it from the source and the first
reviewer's recorded run.

- **Round one** had the whole repository at commit `641aa4d` in scope: API, worker, web UI, console gateway,
  adapters, installer.
- **Round two** ran on commit `d9f90d3` and was scoped to two things: the review units round one had deferred
  (including the maintenance-request channel), and a re-check, on the changed source, of every unit in which round
  one had found something. The units round one covered without a finding were not looked at again.

## What held

No way was found in round one for one customer to read or change another customer's servers, invoices, tickets or
networks through the customer routes: every customer route binds the ids it is given to the caller, staff routes are
denied unless a permission is declared, adapters check the pinned TLS certificate before they send credentials, and
shell and PowerShell parameters are quoted or passed as data. The weaknesses of round one cluster in four places:
one payment gateway (Param), money logic around resize and externally billed servers, state that survived a change
of owner, and sign-in routes of the authentication library that the panel exposed without its own rules.

Round two qualifies that statement in two ways. First, it found paths that cross between two customers, each with a
precondition the customer cannot simply choose: around the hand-over of a server (a request of the previous owner in
flight at that moment, a cancellation booked before it), and on Proxmox VE after a VM number was reused, which only
someone with access to the cluster or the panel host can bring about. They are in the table below and are fixed.
Second, the areas reviewed for the first time gave the weightier results: state that crosses a change of owner or of
role, reused Proxmox VM numbers, a reset token readable in request logs, an unlimited SMS test, and a restore that
replays old orders.

## Round one: confirmed findings

22 findings: 1 high, 10 medium, 11 low. All were fixed in the release that followed round one.

| Severity | Weakness | Fix |
|---|---|---|
| High | **Param return accepted as proof of payment.** The browser's return from Param was enough to mark an invoice paid; it was not backed by a merchant secret or by asking Param. | A return never settles a payment: it stays pending as "awaiting confirmation" and staff mark the invoice paid after checking the Param panel. |
| Medium | **Directory accounts could sign in without the directory.** Sign-in routes other than the password form (phone number, SMS code, e-mail code) gave a session to an account the directory no longer accepted. | The rule is enforced where sessions are created: a directory account gets a session only when the directory accepted that sign-in, a single sign-on account only from its provider's callback. Unused sign-in routes answer 404. |
| Medium | **Unbounded sign-in identifier stored.** An anonymous sign-in attempt could store a very large "e-mail" value in the audit log and in a rate-limit key. | Identifiers longer than 254 characters are refused, audit details are length-capped, and `/api/auth/*` bodies are limited to 64 KB. |
| Medium | **Param ignored the currency.** A non-TRY invoice or top-up paid through Param was collected as the same number in lira. | Param is offered and accepted for TRY only; anything else answers `PAYMENT_METHOD_UNAVAILABLE`. |
| Medium | **Upgrade after the renewal invoice was under-billed.** A resize made after the next period's invoice was issued left that period invoiced at the old, lower price. | An unpaid renewal invoice for a period that has not begun is re-priced to the server's current price; an increase during an unpaid period that has begun is charged pro rata. |
| Medium | **Role mapping let settings staff create an administrator.** Staff who could only manage settings could map a directory or single sign-on group (or the default role) to the administrator role. | Saving directory or single sign-on settings needs permissions covering every mapped role; only administrators can map to `admin` (`FORBIDDEN_TARGET`). |
| Medium | **Billing-system order bound to an unproven account.** An order from WHMCS or WISECP was attached to any existing panel account with the buyer's e-mail, including one somebody else had created. | An existing account was used only when its address was proven and it was not a reseller's or another system's (tightened again in round two); otherwise the route answers `CUSTOMER_NEEDS_REVIEW` for staff to resolve. Reseller-created customers start unverified. |
| Medium | **Externally billed servers could be upgraded for free.** The owner of a server billed by WHMCS or WISECP could resize it or add disks in the panel and neither system charged for it. | Owners cannot resize, add disks to or copy such servers in the panel (`EXTERNALLY_BILLED`); staff and the integration can. |
| Medium | **Concurrent resize kept the old price.** Two resize requests at once could leave the larger size queued while the price went back to the old one. | The price is written only by the request whose operation was accepted, and only while the row is the one it priced from; a refused request changes nothing. |
| Medium | **A transferred server kept the previous owner's credentials.** Stored SSH keys and root password stayed on the server and a default reinstall by the new owner applied them again. | A transfer or staff move clears stored keys, root password, tags, notes, schedules and update tracking and closes the previous owner's consoles; a reinstall without keys generates a new root password. |
| Medium | **Copy order not re-bound to its source.** A copy whose build waited for payment was made from a hypervisor id noted at order time, which could by then belong to another customer's server. | The order stores the source server; the worker re-checks owner and state at build time (`CLONE_SOURCE_GONE`), and a server with a copy on order cannot be transferred, deleted or reinstalled (`CLONE_PENDING`). |
| Low | **Directory password guesses skipped throttling.** Guesses against directory accounts reached the directory before the captcha and the per-e-mail limit. | The directory is asked last, after the address rule, the captcha and the per-e-mail limit. |
| Low | **ID-token sign-in skipped the single sign-on step.** Posting a provider ID token signed in without the role mapping and audit of the redirect flow. | Posting a provider ID token to sign in or link is refused. |
| Low | **Sandbox payments could settle after the sandbox was switched off.** | Switching the sandbox off fails all pending sandbox payments (`TEST_MODE_OFF`) and the test-card route refuses while it is off; switching a provider to live fails its pending test-mode payments. |
| Low | **Removing a failed disk at the same moment credited its price twice.** | The credit is tied to the removal itself; a second removal answers 404. |
| Low | **Update-reporter token survived a transfer.** The previous owner's token could still report update status for the server. | Update tracking is removed on transfer or staff move; the new owner enables it again and gets a new token. |
| Low | **Large JSON bodies parsed before authentication.** Any route parsed bodies of up to 8 MB. | JSON bodies are limited to 256 KB (64 KB on `/api/auth/*`), with larger limits only on the upload routes behind a session; Caddy caps `/api/*` at 10 MB. |
| Low | **Customer ticket list showed the assigned staff member's e-mail.** | The field is no longer in the customer's list. |
| Low | **`GET /vdcs` listed other customers' personal images** (name and metadata, not content). | The list is filtered by owner. |
| Low | **Backup integrity check did not depend on the backup key.** A checksum file anybody with write access to the backup storage could recompute was the only check before a restore. | Backups carry an HMAC made with the backup key over the file and its name (`.hmac`); restore refuses without a matching one (`E_RESTORE_SIGNATURE`) and takes older, unsigned backups only with `--allow-unsigned`. |
| Low | **Anonymous console-gateway requests wrote one audit event each.** | At most five `console.denied` / `terminal.denied` events per minute for unknown tickets, with a count of the suppressed ones. |
| Low | **Open redirect after sign-in.** A crafted `next` path could normalise to another site. | The value that is returned is validated, not the raw input; such paths are refused. |

### Round one: leads that depend on the deployment

Four leads could not be settled in the sandbox because they depend on a fact outside the repository. They were not
confirmed as vulnerabilities; three were hardened anyway, one was removed by construction.

| Lead | What was changed | What an operator should check |
|---|---|---|
| Password-reset and sign-in links took their host name from the request (reachable from outside only in behind-proxy mode). | Hardened: links in mail use the panel's configured address and redirect targets must be panel paths. Round two closed the remaining case, an installation with no configured address (below). | That the panel's address is the one customers use, and that a reset mail carries it. |
| In behind-proxy mode a client on a private address could influence the client address the API used. | Hardened: Caddy sends the API one client address, the one it worked out itself. | Reload or restart the proxy after upgrading (Caddy 2.7 or newer). If another proxy sits directly in front of the API instead of Caddy, make it send a single address and list only that proxy in `TRUSTED_PROXIES`. In behind-proxy mode, keep `TRUSTED_PROXY_CIDRS` to your outer proxy only. |
| Cancelling a resize or disk-add after its hypervisor task was issued might keep the change while the price was rolled back. | Made safe by construction: a cancel no longer interrupts a hypervisor task in progress, and customers can cancel only operations not yet picked up. Round two found and fixed the same outcome on the deadline path (below). | Nothing. It was not observed against a real hypervisor. |
| The Grafana administrator password and the repository token (`get.sh --token`) were passed on command lines, readable by other local accounts. | Fixed: neither is passed as an argument by the scripts; `get.sh` takes `--token-file` or `GIT_TOKEN` in the environment. | Use the documented form ([updates.md](updates.md)); `--token` still works and is still visible in the process list. Avoid unprivileged shell accounts on the panel host. |

### Round one: candidates without an independent verdict

Ten candidates were raised by the hunting wave but never received a second reviewer's verdict: the verifier agents
assigned to them were stopped by the model's safeguards. They are **not confirmed findings**. Nine were changed
after round one; the tenth was confirmed and fixed in round two.

| Candidate | Changed |
|---|---|
| Staff acting as a user could leave a lasting way in on that account (a passkey or a linked sign-in). | Yes: while acting as a user, staff cannot add passkeys, linked accounts, webhooks, push or chat connections, or change password, phone or two-factor (`NOT_WHILE_IMPERSONATING`). |
| A sign-in link by e-mail gave a full session to accounts with two-factor. | Yes: accounts with two-factor cannot use sign-in links. |
| Passkey sign-ins left no audit record and no sign-in notice. | Yes: passkey sign-in, add and remove are in the audit log and notices are sent. |
| Password reset by phone code was exposed although the panel never sends that code. | Yes: the route is removed (404). |
| Phone-number sign-in routes skipped the panel's sign-in rules. | Yes: the routes are removed (404); an SMS code only verifies the signed-in person's number. |
| The browser push endpoint was not checked against internal addresses. | Yes: a subscription needs a public HTTPS endpoint (checked again at every send), at most 20 per user. Round two found a way around the check and closed it (below). |
| Stored integration secrets followed a changed host when the secret field was left empty. | Yes: changing the SMTP host, port or security, the custom SMS URL host, the rDNS API URL, the LDAP URL or the OIDC issuer requires re-entering the secret. Round two found the same in three more integrations and fixed them (below). |
| The custom SMS and rDNS tests showed staff the remote server's response. | Yes: settings tests no longer show the remote server's text (SMTP, custom SMS, rDNS, LDAP, single sign-on). |
| A Web Push subscription stayed bound to the account after sign-out. | Yes: signing out or a session ending turns browser notifications off on that browser; subscriptions are removed when staff end a user's sessions or the password is reset. Round two extended this to every way sessions are ended for someone (below). |
| Ticket replies are not rate-limited, so one customer can cause many staff notifications. | Yes, in round two: it was confirmed there (low) and fixed with limits per ticket and per customer. |

## Round two: re-check of the round-one fixes

Of the 22 fixes made after round one:

- **17 were re-checked on real PostgreSQL and hold.**
- **4 could not be re-checked.** They are the fixes to directory (LDAP) and single sign-on sign-in. The reviewer
  assigned to them was stopped by the model's safeguards. These fixes are covered by the project's own integration
  tests (`apps/api/test/integration/security-auth.test.mjs`), but they did not get the second, independent look the
  others got.
- **The re-check found five places where a fix was incomplete or left an adjacent gap.** All five are now fixed and
  are listed as findings in the table below:
  1. renewal pricing: the invoice kept the old price while it was in dispute, and on the last day of a period;
  2. the Param return: it no longer paid anything, but could still close a payment that awaited confirmation;
  3. body size: three attachment routes still read a large body before the caller was known;
  4. stored secrets: three integrations (payment gateway, e-invoice, ISO storage) still sent a stored secret to a
     changed address;
  5. the billing-integration account match: "proven address" was not enough to treat an existing account as the
     buyer's.

## Round two: confirmed findings

26 findings: 10 medium, 15 low, 1 informational. All are fixed in this release.

| Severity | Weakness | Fix in this release |
|---|---|---|
| Medium | **A demoted or banned staff member kept acting as the customer they were impersonating.** An impersonation session started earlier went on working after the staff account lost its rights, and could be kept alive past its one hour. | An impersonation session ends when the staff member who started it is demoted, banned, removed or has their sessions ended, and one hour after it started, whatever the browser sends. |
| Medium | **A renewal invoice stayed payable at the earlier, lower price after the server was enlarged**, while it was in dispute and on the last day of the period. | The invoice follows the server's price also while in dispute, and it is priced again at the moment it is paid. Staff "mark paid" answers `INVOICE_AMOUNT_CHANGED` once when the amount moved. |
| Medium | **An account somebody else registered for the buyer's address still received the billing-system order once it was marked proven**, and the registrant kept a way in. | The integration matches only accounts it created itself. Any other account answers `CUSTOMER_NEEDS_REVIEW` until staff hand it over with the claim route, which removes everything its earlier holder could still use. |
| Medium | **The notification test sent an unlimited number of SMS at the operator's cost.** | Test sends are limited: 6 an hour per account, and 6 an hour per phone number for SMS. |
| Medium | **A password-reset token was written to the API request log**, which staff holding `system.update` could read on the system page. | The API, the proxy and the log collector no longer write tokens that travel in URLs; the service logs on the system page are for administrators only and are masked as well. |
| Medium | **Requests of the previous owner that overlapped the hand-over were applied to the new owner's server.** | Every write is bound to the owner the request was authorised for; a request of the previous owner that overlaps a hand-over waits for it and then answers 404 without changing anything. |
| Medium | **Payment gateway, e-invoice integrator and ISO storage used a stored secret with a new address** when staff changed only the address and left the secret field empty. | Changing the address requires typing the stored secrets again, in saving and in testing. |
| Medium | **A cancellation the previous owner had booked on the subscription deleted the server after it was handed to another customer.** | A hand-over clears a booked cancellation, the auto-renew choice and a pending removal mark. |
| Medium | **The Proxmox clone accepted any VM number as the template**, so an image whose template had been removed built new servers from the VM that inherited the number. | An order from an image clones only from a template; a copy of a server names the source it expects, and the adapter refuses anything else. |
| Medium | **On Proxmox a server row that kept a VM number its VM no longer had acted on whichever VM now held that number**, including another customer's. | Every request about a server names the VM it expects; the Proxmox adapter refuses when the VM at that number carries another name (`VM_MISMATCH`), and reconciliation writes back the number of the VM it finds by name. |
| Low | **Verification SMS to any typed number were limited per client address only.** | Phone codes are limited to 5 a day per account and per number, two-factor codes to 8 an hour per account. |
| Low | **The 254-character bound on sign-in identifiers was skipped for non-text values**, which still became large rate-limit keys. | A sign-in identifier must be text; anything else is refused before a key is made. |
| Low | **Param: the unsigned return could still close a payment that awaited staff confirmation as declined, and set the note staff confirm from.** | Once a payment is under review, later returns are ignored, "declined" included. The staff note is composed by the panel and starts with the payment's own id and the instruction. |
| Low | **An increase on a subscription with a 3, 6 or 12 month period was charged as one month's difference** spread over the whole period. | The increase is charged for all remaining months of the period. |
| Low | **Where sales go through WHMCS or WISECP with the panel's billing off, customers could order unbilled servers in the panel**, and the role could not switch that off without stopping the integration. | Customers the integration created cannot order in the panel while the panel's billing is off (`EXTERNALLY_BILLED`); the integration's own orders no longer depend on the customer's role or quota. |
| Low | **On the three attachment routes an anonymous caller still made the API read and parse a 9 MB body** before the session was checked. | A large body is read on those routes only from a caller that presents a session or an API token; anyone else is refused before the body is read. |
| Low | **Browser push endpoint: the host that was checked was not always the host the request went to**, and an address written as a number was not checked at connection time. | A push endpoint must be on a DNS host name, and the connection itself refuses private addresses. |
| Low | **A staff retry of a failed resize overwrote the server's current price with the old operation's**, dropping what was added since. | The retry writes the price only while the server is as the operation left it; otherwise it answers `SERVER_CHANGED`. |
| Low | **Custom SMS provider test: the caller's own success pattern was matched against the answer of any address**, so the verdict revealed that answer bit by bit. | Only administrators can test an unsaved custom SMS provider; other staff test the saved one. |
| Low | **A ticket's assignee kept receiving staff notifications with the customer's address after losing the support role.** | An assignee must hold `support.manage`; tickets are unassigned when the holder loses `support.view` or is banned, and staff notices go only to accounts that still hold the permission. |
| Low | **Ticket replies had no limit per customer or per ticket**; each one notified every support staff member. | Customer replies and ratings are limited to 10 per ticket and 30 per customer in 10 minutes; staff are told about the first rating only, and bursts on one ticket are folded together. |
| Low | **A console or host-terminal ticket issued before a revocation still opened a session after it.** | The gateway refuses a ticket issued before a revocation of its user, session or server (`CONSOLE_REVOKED` / `TERMINAL_REVOKED`). |
| Low | **After restoring an older backup the panel acted again on orders, operations and deletion schedules that were open in that backup**, and could destroy a server paid for and built since. No attacker is needed for this. | After a restore the panel is on hold: no operations, schedules, deletions or billing until an administrator has reviewed the state and released it. |
| Low | **Restore checked the backup's signature on one read of the file and decrypted a second read**, so a party able to write the backup location during the restore could swap in an older genuine archive. | Restore copies the archive once into a folder only root can open and checks, decrypts and unpacks that copy. |
| Low | **An operation deadline that passed while its hypervisor task was running undid the price, invoice and tracking row although the change still landed.** | A task that is running is waited for (up to `TASK_OUTCOME_HOURS`, default 6, past the deadline); when its result cannot be learned the operation ends as `OUTCOME_UNKNOWN` and nothing is undone. |
| Informational | **The password step of a two-factor account was recorded and announced as a completed sign-in.** | A sign-in is recorded once a session exists; the password step is recorded as `auth.password_step`. |

### Round two: leads that need an operator's decision or check

Three leads were kept without a severity: each depends on a fact the sandbox could not show, or on a product
decision. They are not confirmed vulnerabilities. All three were changed.

| Lead | What was changed | What an operator should do |
|---|---|---|
| Mailed reset and sign-in links still followed the request's host name on an installation with no configured panel address (typically behind another proxy). | The address is now a setting (`PANEL_PUBLIC_URL`); `install.sh behind-proxy` requires `--public-url`. With no address known, no link mail is sent to a request that arrived under a public host name. The documented outer-proxy block now forwards `X-Forwarded-Host`. | Existing behind-proxy installs: run `install.sh behind-proxy --public-url https://…` once ([domain-https.md](domain-https.md)). |
| A restore brings back ended sessions, deleted API tokens, lifted bans, removed roles and old passwords. | Restore now ends every session and says what else is back as it was at backup time. API tokens, bans, role and password changes are not reverted automatically: that is what a full restore means. | After a restore, apply again the token deletions, bans and role or password changes made since the backup, then release the hold ([operations.md](operations.md)). |
| Push subscriptions stayed on the account when single sessions, all other sessions or all sessions were ended. | Push subscriptions are dropped whenever sessions are ended for someone. Not observed with a real browser and push service. | Nothing. |

### Round two: candidates without an independent verdict

Four candidates never received a second reviewer's verdict: the verifier assigned to them was stopped by the model's
safeguards. They are **not confirmed findings**.

| Candidate | Changed in this release |
|---|---|
| Staff acting as a customer could set the billing e-mail address, which would keep receiving the customer's invoices. | Yes: the billing e-mail cannot be changed while acting as a customer. |
| `settings.manage` controlled the channels that carry every account's reset links and sign-in codes, administrators included. | Yes: only administrators can save mail or SMS settings, enable link or code sign-in, lower the two-factor requirement or weaken the captcha. |
| An account a reseller opened for an unproven address stays reseller-managed after the real person takes it over, without notice or a way out. | **Not in that release.** Changed in the follow-up of 2026-11-18 (below): the customer is told once, sees who manages the account and can leave. |
| Removing or deactivating a reseller separates who pays for the customers' servers from who controls them. | **Not in that release.** Changed in the follow-up of 2026-11-18 (below) for removal and for a customer leaving; a reseller that is only switched off keeps being billed, and staff are told how many subscriptions that is. |

One further candidate was **rejected** after verification (that staff events stay readable after a demotion).

### The maintenance-request channel

The channel between the API and `install.sh run-requests`, through which the panel changes its own host (updates,
domain and certificate, host and operating system settings, the terminal switch), could not be reviewed in round
one. **It was reviewed in round two: no finding.** The review left notes on validation that was looser than it had
to be, and these were tightened: a request file or certificate that is a link is removed and never read; the request
is moved out of the API's reach before one value is read from it; time-server and name-server lists are validated by
the same strict rule on both sides; a custom certificate must be readable, inside its validity dates and match its
key; `--trusted-cidr` is validated; values written to `.env` are escaped; and patterns no longer depend on the
host's locale.

### A functional defect found on the way

Notification e-mails were not being sent at all on Node 22: a date-format option error made every notification mail
fail (sign-in notices, "password changed" and "two-factor changed" among them). Mails for password reset, sign-in
links and codes were not affected. This is fixed; it was not a security finding, but it hid security notices.

## Follow-up after round two (2026-11-18)

Round two ended with a list of things it had not reviewed and two candidates it had left unchanged. They were worked
through afterwards, by the maintainer with the same AI tooling.

> [!IMPORTANT]
> **This follow-up was a source review with tests, not an audit round.** There was no hunting wave and no second,
> fresh reviewer per item, and nothing was reproduced by an independent verifier in the audit sandbox. What is listed
> below are therefore **not independently validated findings**: they are gaps that reading the source showed, and the
> changes made for them. They carry no severity and are not counted in the 48 confirmed findings above.

How the changes were checked: by unit tests, which pass (API 157, worker 50, web 117, counted as `test(` at the start
of a line in the test files), and by integration tests written for them against PostgreSQL and Redis
(`security-leftovers.test.mjs`, `saved-views.test.mjs` and additions to `security-auth.test.mjs` and
`security-billing.test.mjs`: 19 tests). The full integration suite was run on 2026-11-18 at commit `eaa0a4e` on a
Linux host with Docker: 196 tests, 192 passed, 4 skipped (they need PowerDNS, an ISO storage or the console
gateway), none failed; the 19 are in that count and passed. The end-to-end suite (Playwright) ran at the same commit
on the demo deployment with a fresh database and the VMware simulator: 31 of 31 passed, the new steps among them
(saved views against the account's copy; a payment held for review, made with the sandbox card and closed by staff).
It has no step for the reseller card, leaving a reseller, staff releasing a customer, or the removal of browser
content when the account changes, and nothing was looked at in a browser by hand.

### The directory and single sign-on re-check

Round one made four fixes to directory (LDAP) and single sign-on sign-in; round two could not re-check them. Read
again on the current source:

| Round-one fix | Result of the re-read | What was changed |
|---|---|---|
| Posting a provider ID token to sign in or link is refused. | **Holds.** | Nothing. |
| A directory account gets a session only when the directory accepted that sign-in. | **Incomplete.** A session, once made, was extended for as long as it was used, so an account closed in the directory (or at the provider) kept its panel session indefinitely. | A session of a directory or single sign-on account ends `SESSION_TTL_HOURS` after sign-in, used or not. The session a two-factor change swaps in keeps the age of the one it replaces. |
| The directory is asked last, after the captcha and the per-e-mail limit. | **Incomplete.** The per-e-mail limit counts what was typed, while a directory matches many spellings of one mailbox, each with a limit of its own; and the settings test let staff try a person's directory password without counting. | An address that has no account is put to the directory only in its one plain spelling. The settings test, when it is given a password, counts against the same per-address limit as a sign-in. |
| Saving directory or single sign-on settings needs permissions covering every mapped role. | **Incomplete.** Whoever names the server also decides who the accounts already behind it are, and those sign in with the roles and overrides they hold in the panel; and a deleted role stayed in the mappings, so a role created later under the same key was handed out by the old mapping. | Saving needs permissions covering every account that signs in through that source as well (`FORBIDDEN_TARGET`, `ACCOUNTS_NOT_COVERED`). Deleting a role removes it from both mappings. |

**Left open then:** personal API tokens of a directory or single sign-on account are not sessions and kept working
after the account was closed in the directory, until staff banned or disabled the account in the panel or deleted the
tokens (changed on 2026-11-19, [below](#re-review-of-the-units-round-one-closed-without-a-finding-2026-11-19)). Of
the three units round two deferred here, the staff routes for roles, users, access overrides and impersonation were
looked at only where a deleted role meets the mappings; they have had no re-check of their own.

### The six areas proposed after the round-two wave

| Area | What was changed | Left as is |
|---|---|---|
| 1. An account registered for an address the registrant does not control | The first password reset through a mailed link now counts as the first proof, like the first sign-in by link or code. The proof also removes saved SSH keys, saved cards (automatic renewal needs a card again), the billing e-mail and phone, a pending second step, trusted browsers and the earlier holder's open server offers. Servers, images, balance and tickets stay and are written down for staff (audit event, and a staff note when there are servers, images or balance entries). Accepting a transferred server needs a proven address (`ADDRESS_NOT_PROVEN`). The setup administrator and accounts staff create are proven from the start; accounts a reseller opens are not. | What stays on the account (servers and what is inside them) may have been set up by the earlier holder; the panel notes it for staff and changes nothing in the guests. Migration `085` marks the existing accounts staff had vouched for as proven (any role other than `user`, or created under Admin → Users according to the audit log). Other accounts made before this change (self-registered, opened by a reseller) keep the mark they have, so their first password reset by mail removes the above once. |
| 2. Payments held for review (iyzico, PayTR, Craftgate, Stripe; Param's unconfirmed returns) | Staff "mark paid" closes the invoice's held payments in the same transaction, so a provider's later "paid" settles nothing a second time. A new staff action (`close-review`) ends a held payment without settling anything. The automatic charge skips an invoice that has a held payment. PayTR: the amount check uses the total the signature covers. The sandbox has a test card that yields a held payment (`4000 0000 0000 4954`, `FRAUD_REVIEW`; in sandbox mode only). | Reminders, past-due and suspension still ran while a payment was held, and a customer could still start a second payment for the same invoice. Both changed on 2026-11-19 (below). |
| 3. Notification test and delivery to customer-supplied endpoints | Creating and testing a messaging connection has a budget per account (20 an hour); the notification test has a budget per messaging destination across accounts (6 an hour). For connectors whose address the user names freely (Mattermost, Rocket.Chat, Matrix, ntfy, Gotify, plain webhook) a failed send answers with a code only, never the remote text or the connection error. | The push and e-mail legs were read and not changed: a push endpoint belongs to one account at a time and mail goes to the account's own address, so the per-account limit covers them. Ordinary notification delivery (not the test) has no budget of its own. |
| 4. Data kept in the browser at session end | Every key the panel writes is listed as content or preference, and a unit test fails for an unlisted one. Content (drafts, recent items, the order being composed, table state, the staff digest mark) is removed on sign-out, on any other end of the session, when another account opens the panel in the same browser, and at both ends of "sign in as"; notifications on screen are closed. Saved views moved from the browser to the account (`/saved-views`); copies an earlier version left are uploaded once by their owner and removed, or removed at the next session end. | Removal needs the panel to open again in that browser or the session to end there; a browser that is closed and never returns keeps what it had. Not observed in a real browser. |
| 5. The shared operations queue | One account can have only `OPERATIONS_PER_OWNER` operations under way at once (default: half of `OPERATIONS_CONCURRENCY`; 0 switches it off); further ones go back to the queue with a delay. Operations started by staff, the billing run and the billing integration are never held. A reseller's operations for its customers count against the reseller. | The operation deadline kept running while an operation waited for its share (changed on 2026-11-19, below). Accounts acting together each have a share of their own. |
| 6. The installer's maintenance lock and host snapshots | Snapshot files for the panel are created privately under an unpredictable name and renamed into place; the lock file is its maker's alone, is checked before use and removed with the job; root takes over a maintenance directory that is not its own (`W_MAINT_DIR`) and refuses one that is a link; a request log is created anew and closed to others. | Exercised with dummy files under `dash` and `bash` only, not on an installation with the systemd timer and the panel agent. |

### The two reseller candidates

- **A customer of a reseller did not know and could not leave.** The customer now sees who manages the account
  (account page, `managedBy` in `GET /reseller/summary`), is notified once the first time they use the panel
  (`account.reseller`), finds what the reseller did to their servers in their own activity list, and can leave
  (`POST /reseller/leave`). Staff can take one customer out of a reseller's hands: the user summary dialog lists
  the reseller's customers (`GET /admin/resellers/:id`) with a release action for each.
- **Who pays and who controls came apart.** When a customer stops being a reseller's (the reseller is removed, staff
  take the customer out, the customer leaves), the running subscriptions move to the customer, the reseller's
  untouched renewal invoices for those servers are cancelled and the customer is invoiced from the first unpaid
  period. Other open invoices stay with the reseller. Prices were not changed then; since 2026-11-19 the reseller's
  discount comes off where the list price is certain (below).
- **Gaps that remain:** of a reseller's actions only operations on servers, orders and the creation of the account
  appeared in the customer's activity (widened on 2026-11-19, below); an order the reseller places at the very moment the customer leaves can end up
  outside the release; a reseller that is only switched off keeps paying for servers it can no longer act on (staff
  are shown how many).

Details for operators are in [upgrade-notes.md](upgrade-notes.md), [auth.md](auth.md), [payments.md](payments.md),
[billing.md](billing.md), [operations.md](operations.md) and [notifications.md](notifications.md) (Turkish).

## Re-review of the units round one closed without a finding (2026-11-19)

Round one closed 65 of its review units without a finding. Round two re-checked only the units in which round one
had found something, and the follow-up of 2026-11-18 did not touch the 65 either. On 2026-11-19 they were taken up
again on the current source, that is, the code after both rounds' fixes and the follow-up.

> [!IMPORTANT]
> **One reviewer, source reading only.** There was no hunting wave and no second reviewer, and nothing was
> reproduced independently, in the audit sandbox or anywhere else. What is listed below are **not independently
> validated findings**; they carry no severity and are not counted in the 48 confirmed findings. The changes made
> for them were reviewed by nobody but their author's tooling.

| Of the 65 units | Count | Read again |
|---|---|---|
| Unchanged since round one | 10 | No: the source is the one round one read. |
| Changed trivially since round one | 18 | No. |
| Changed materially since round one | 37 | Yes; 9 of them only in part. |

### What the re-read found, and what was changed

| What reading the source showed | What was changed |
|---|---|
| **A customer could write entries into another account's activity.** The customer's subscription route (`PUT /billing/subscriptions/:id`) and its staff twin stored the request body as audit metadata, and a `forOwner` field in audit metadata puts the event into that account's own activity list. | Both routes record only the fields they validated. The two fields that place an event in another account's activity (`forOwner`, `actingAs`) are no longer taken from any caller's metadata: the audit function drops them and sets them itself. Events of the two routes are shown only to their actor, so entries written before the change do not appear in anybody else's list. |
| **A server billing had already marked for deletion could get a fresh subscription when its owner left a reseller.** The release cleared billing's removal mark on all of the customer's servers, including ones whose subscription had already ended or been cancelled; the next billing run then adopted them. | The mark is cleared only for the servers whose subscription moved to the customer. |
| **API tokens of directory and single sign-on accounts kept working after the account was closed at its source** (left open by the follow-up of 2026-11-18). | A token of such an account is accepted only while the account was confirmed by its source within `DIRECTORY_TOKEN_DAYS` (default 30, 0 off); otherwise `401 TOKEN_ACCOUNT_UNCONFIRMED`. A sign-in the directory or provider accepts confirms it (`users.source_confirmed_at`, migration `086`; accounts that existed at the upgrade count as confirmed then). With LDAP and a working service account, the directory is asked when a token is used, at most once an hour per account: found renews the confirmation, a clean "not found" takes it away at once (audit event `auth.directory_user_missing`), an error changes nothing. Single sign-on accounts have the age limit alone. Both token lists mark such a token "asleep". |
| **A customer could send billing staff any number of "payment under review" notifications.** Each payment that comes under review notifies everyone with `billing.manage` once, and a customer could start payment after payment for the same invoice. | While a payment for an invoice is under review, a second payment by the customer is refused on every method (`409 PAYMENT_IN_REVIEW`: balance, saved card, card), for the review window (billing setting `reviewHoldDays`, 0 to 90, default 7, counted from when the review began). An account can start 20 card payments an hour (`429`). |

### Changed in the same round

These come from the "left as is" lists of the follow-up of 2026-11-18, not from the re-read.

- **A payment under review holds its invoice.** For the same review window the invoice is not suspended, deleted or
  expired and nobody is reminded to pay it; the overdue notice is sent once and says the payment is being checked.
  After the window, with the review still open, the invoice is collected again and can be paid again, so a review
  nobody decides shelters an unpaid server for that long and no longer, and never locks a customer out. `0` turns
  the hold and the refusal of a second payment off together. The hourly power-off for a negative balance is not
  covered.
- **The wait for an account's share no longer counts against an operation's deadline** (`operations.held_since`,
  migration `087`), for at most `OPERATIONS_HELD_HOURS` (default 6; 0 is the earlier behaviour). An operation held
  longer than that is let through and ends as `TIMEOUT`.
- **What a reseller does on a customer's server besides operations** (console, schedules, labels, disks, images,
  rename, lock) is in the customer's activity, with the reseller's name or brand.
- **Leaving a reseller ends the reseller's discount** from the next invoice, but only where the list price is
  certain: today's catalog price less the reseller's current discount must give the server's price to the cent. The
  other servers keep their price and are listed for staff (`pricesKept` in the answer and in the
  `reseller.customer_released` audit event). The customer sees the new monthly amounts before confirming and in the
  notice.
- **Staff acting as a customer can no longer leave a reseller or accept a transferred server**
  (`403 NOT_WHILE_IMPERSONATING`).

### Not read again line by line

- the changes of the two fix rounds inside `billing.ts`;
- `better-auth.ts`, `support.ts`, `notify.ts` and `chat-apps.ts`;
- the backup, update, domain, host and uninstall paths of `install.sh`;
- the adapters other than Proxmox;
- the clearing of browser storage and the saved-views component in the web UI.

### How it was checked

By unit tests, which pass at commit `ea0d19e` (API 162, worker 54, web 128), and by integration tests against
PostgreSQL and Redis written for this round (`security-leftovers-2.test.mjs`, 8 tests). The full integration suite was run
on 2026-11-19 at that commit on a Linux host with Docker: 204 tests, 200 passed, 4 skipped (they need PowerDNS, an
ISO storage or the console gateway), none failed. The end-to-end suite (Playwright) ran at the same commit against
its own throwaway Compose stack with a fresh database and the VMware simulator, never against a panel with real
data: 33 of 33 passed, in about 14 minutes. It now has steps for what the follow-up of 2026-11-18 listed as missing (the reseller card,
leaving, staff releasing a customer, browser content when the account changes) and for a held invoice refusing a
second payment in the page and at the API. In three of its new steps the state is injected into the page because
that stack cannot produce it from a browser: the restore hold (the release itself goes to the real route), the
billing and retry answers of the next step after a failed operation (the support answer comes from a real
failure), and the count on the Abuse menu entry (the Servers count is real). The "asleep" mark in the token lists,
the amounts shown before leaving a reseller and the staff notice about kept prices have no end-to-end step. Nothing
was used in a browser by hand; of the 187 screenshots the suite takes, 115 were looked at by eye on 2026-11-19 and
72 were not.

**The directory lookup on token use has no test of its own and was not tried against a real LDAP server.** The unit
test covers the age rule, and the integration test sets the confirmation date in the database directly, with no
directory configured; what happens when the directory answers "found", "not found" or with an error was read in the
source only. The queue test runs the worker's statements on the test database, not a worker under load. The
reviewer's notes with the detail of each item are kept outside the repository.

## Not reviewed

- **The directory (LDAP) and single sign-on re-check was never done by an independent reviewer.** Three units of
  round two were deferred when their reviewer was stopped: LDAP sign-in with user search, group-to-role mapping and
  auto-create; OIDC and social sign-in with callbacks and role mapping from claims; and the staff routes for roles,
  users, access overrides and impersonation. The follow-up above re-read round one's four fixes there on the source
  and finished three of them; that is a source review by the same tooling that wrote the fixes, not the second,
  independent look the other fixes got. The staff routes were not re-checked beyond the one place named above.
- **Six areas the coverage critic proposed after the round-two wave** were never assigned to the audit workflow:
  the unproven-address account, payments held for review, notification test and delivery, browser data at session
  end, the shared operations queue, and the installer's lock and snapshot files. All six were worked through in the
  follow-up above, again by source review with tests and without independent verification. What was deliberately
  left as it is in each is in the table's last column.
- **The 65 review units round one closed without a finding never went through an audit round again.** Round two
  re-checked only the units in which round one had found something. The re-review of 2026-11-19 above took the 65 up
  with one reviewer reading source: 10 unchanged and 18 trivially changed units were not read again, 37 were, 9 of
  them only in part, and the places listed there under "Not read again line by line" were left out. Nothing in it
  was verified independently.
- **The areas round one left unreviewed** (its deferred units and the thirteen areas its coverage critic proposed)
  were the starting point of round two's scope, and most of the findings above come from them. Round two deferred
  nine units in turn (the three directory and single sign-on units and the six areas above), so no claim of complete
  coverage is made for any area.
- **The changes of the follow-up and of the re-review were not themselves reviewed** by anyone but their author's
  tooling.

## Limits

- **Partial passes.** One hunting wave per round. In round one 16 of 116 planned review units were deferred; in
  round two 9 of 122 were deferred and 65 were out of scope because round one had covered them. Neither round's
  final coverage check ran clean. There is no claim of complete coverage.
- **Not independent.** The review and the fixes were both produced with AI tooling under the maintainer's direction.
  No external party has audited the project.
- **How the fixes were verified.** By unit tests and by integration tests against real PostgreSQL and Redis
  (`apps/api/test/integration/security-*.test.mjs` and additions to the existing suites). The fixes of round two
  were not themselves reviewed by a further audit round.
- **The follow-up is not a round.** It was a source review with tests by the same tooling, without a hunting wave,
  independent verifiers or sandbox reproduction. Its items are not validated findings.
- **The re-review of 2026-11-19 is not a round either.** One reviewer read source; nothing was reproduced
  independently. Its items are not validated findings.
- **Not tried on real systems.** Nothing was verified against real hypervisors. The Proxmox findings and their fixes
  were observed against a stand-in for the Proxmox API, not a real cluster; that Proxmox hands a freed VM number to
  the next VM is its documented behaviour, not something observed here. The Param changes were not verified against
  a real Param merchant account. Caddy and Nginx could not run in the audit sandbox, so the proxy behaviour (one
  client address upstream, the host name passed on) was not observed there. The follow-up's directory changes were
  not tried against a real directory server or identity provider, its payment changes not against a real provider
  account, and its queue change not under load on a real hypervisor. Nothing of the re-review of 2026-11-19 was
  tried on a real hypervisor, a real Proxmox cluster, a real Param account or a real directory server.
- **Installer paths exercised with dummy files only.** Restore, the maintenance requests and the certificate checks
  were run against dummy archives, request files and certificates; a full restore with Docker Compose and
  `pg_restore` on an installation was not run in the audit. The follow-up's lock and snapshot-file handling was
  exercised with dummy files under `dash` and `bash` only.
- **Sandbox observations only.** Findings were reproduced with dummy data; several end states (a guest login, a
  hypervisor copy, the worker carrying out a queued deletion, a browser receiving a push message) were reasoned from
  source rather than exercised.
- The deployed demo server and operators' own infrastructure (outer proxies, backup storage, hypervisors) were outside
  this audit.
