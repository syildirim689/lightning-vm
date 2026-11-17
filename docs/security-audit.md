# Security audit (November 2026)

A summary for operators and contributors of the security audit run on commit `641aa4d`, and of what this release
changed because of it. What an operator has to do after upgrading is in [upgrade-notes.md](upgrade-notes.md)
(Turkish); how to report a vulnerability is in [SECURITY.md](../SECURITY.md).

> [!IMPORTANT]
> This was an automated, AI-driven review started by the maintainer, not an audit by an independent third party, and
> it was a **partial pass**. It lowers the number of known weaknesses; it does not show that there are none. Read
> [Limits](#limits) before relying on it.

## Scope and method

The whole repository at commit `641aa4d` was in scope: API, worker, web UI, console gateway, adapters, installer.
The method was source review plus bounded checks: the project's own code was run only inside a sandbox without
network access, with dummy data (for some checks with a throw-away PostgreSQL and Redis). Nothing was sent to a
deployed panel, a hypervisor, a payment provider or any other live system.

One hunting wave ran, followed by one verifier per group of candidates. A finding is listed as confirmed only when a
second, fresh reviewer reproduced it in the sandbox.

## What held

No way was found for one customer to read or change another customer's servers, invoices, tickets or networks
through the customer routes: every customer route binds the ids it is given to the caller, staff routes are denied
unless a permission is declared, adapters check the pinned TLS certificate before they send credentials, and shell
and PowerShell parameters are quoted or passed as data. The confirmed weaknesses cluster in four places: one payment
gateway (Param), money logic around resize and externally billed servers, state that survived a change of owner, and
sign-in routes of the authentication library that the panel exposed without its own rules.

## Confirmed findings

22 findings: 1 high, 10 medium, 11 low. All are fixed in this release.

| Severity | Weakness | Fix in this release |
|---|---|---|
| High | **Param return accepted as proof of payment.** The browser's return from Param was enough to mark an invoice paid; it was not backed by a merchant secret or by asking Param. | A return never settles a payment: it stays pending as "awaiting confirmation" and staff mark the invoice paid after checking the Param panel. |
| Medium | **Directory accounts could sign in without the directory.** Sign-in routes other than the password form (phone number, SMS code, e-mail code) gave a session to an account the directory no longer accepted. | The rule is enforced where sessions are created: a directory account gets a session only when the directory accepted that sign-in, a single sign-on account only from its provider's callback. Unused sign-in routes answer 404. |
| Medium | **Unbounded sign-in identifier stored.** An anonymous sign-in attempt could store a very large "e-mail" value in the audit log and in a rate-limit key. | Identifiers longer than 254 characters are refused, audit details are length-capped, and `/api/auth/*` bodies are limited to 64 KB. |
| Medium | **Param ignored the currency.** A non-TRY invoice or top-up paid through Param was collected as the same number in lira. | Param is offered and accepted for TRY only; anything else answers `PAYMENT_METHOD_UNAVAILABLE`. |
| Medium | **Upgrade after the renewal invoice was under-billed.** A resize made after the next period's invoice was issued left that period invoiced at the old, lower price. | An unpaid renewal invoice for a period that has not begun is re-priced to the server's current price; an increase during an unpaid period that has begun is charged pro rata. |
| Medium | **Role mapping let settings staff create an administrator.** Staff who could only manage settings could map a directory or single sign-on group (or the default role) to the administrator role. | Saving directory or single sign-on settings needs permissions covering every mapped role; only administrators can map to `admin` (`FORBIDDEN_TARGET`). |
| Medium | **Billing-system order bound to an unproven account.** An order from WHMCS or WISECP was attached to any existing panel account with the buyer's e-mail, including one somebody else had created. | An existing account is used only when its address was proven and it is not a reseller's or another system's; otherwise the route answers `CUSTOMER_NEEDS_REVIEW` for staff to resolve. Reseller-created customers start unverified. |
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

## Leads that depend on the deployment

Four leads could not be settled in the sandbox because they depend on a fact outside the repository. They were not
confirmed as vulnerabilities; three were hardened anyway, one was removed by construction.

| Lead | What was changed | What an operator should check |
|---|---|---|
| Password-reset and sign-in links took their host name from the request (reachable from outside only in behind-proxy mode). | Hardened: links in mail use the panel's configured address and redirect targets must be panel paths. | That the panel's address (Settings → Domain and SSL) is the one customers use, and that a reset mail carries it. |
| In behind-proxy mode a client on a private address could influence the client address the API used. | Hardened: Caddy sends the API one client address, the one it worked out itself. | Reload or restart the proxy after upgrading (Caddy 2.7 or newer). If another proxy sits directly in front of the API instead of Caddy, make it send a single address and list only that proxy in `TRUSTED_PROXIES`. In behind-proxy mode, keep `TRUSTED_PROXY_CIDRS` to your outer proxy only. |
| Cancelling a resize or disk-add after its hypervisor task was issued might keep the change while the price was rolled back. | Made safe by construction: a cancel no longer interrupts a hypervisor task in progress, and customers can cancel only operations not yet picked up. | Nothing. It was not observed against a real hypervisor. |
| The Grafana administrator password and the repository token (`get.sh --token`) were passed on command lines, readable by other local accounts. | Fixed: neither is passed as an argument by the scripts; `get.sh` takes `--token-file` or `GIT_TOKEN` in the environment. | Use the documented form ([updates.md](updates.md)); `--token` still works and is still visible in the process list. Avoid unprivileged shell accounts on the panel host. |

## Candidates without an independent verdict

Ten candidates were raised by the hunting wave but never received a second reviewer's verdict: the verifier agents
assigned to them were stopped by the model's safeguards. They are **not confirmed findings**. Nine were changed
anyway; one was not.

| Candidate | Changed in this release |
|---|---|
| Staff acting as a user could leave a lasting way in on that account (a passkey or a linked sign-in). | Yes: while acting as a user, staff cannot add passkeys, linked accounts, webhooks, push or chat connections, or change password, phone or two-factor (`NOT_WHILE_IMPERSONATING`). |
| A sign-in link by e-mail gave a full session to accounts with two-factor. | Yes: accounts with two-factor cannot use sign-in links. |
| Passkey sign-ins left no audit record and no sign-in notice. | Yes: passkey sign-in, add and remove are in the audit log and notices are sent. |
| Password reset by phone code was exposed although the panel never sends that code. | Yes: the route is removed (404). |
| Phone-number sign-in routes skipped the panel's sign-in rules. | Yes: the routes are removed (404); an SMS code only verifies the signed-in person's number. |
| The browser push endpoint was not checked against internal addresses. | Yes: a subscription needs a public HTTPS endpoint (checked again at every send), at most 20 per user. |
| Stored integration secrets followed a changed host when the secret field was left empty. | Yes: changing the SMTP host, port or security, the custom SMS URL host, the rDNS API URL, the LDAP URL or the OIDC issuer requires re-entering the secret. |
| The custom SMS and rDNS tests showed staff the remote server's response. | Yes: settings tests no longer show the remote server's text (SMTP, custom SMS, rDNS, LDAP, single sign-on). |
| A Web Push subscription stayed bound to the account after sign-out. | Yes: signing out or a session ending turns browser notifications off on that browser; subscriptions are removed when staff end a user's sessions or the password is reset. |
| Ticket replies are not rate-limited, so one customer can cause many staff notifications. | **No.** Ticket-reply notification fan-out has no rate limit yet. |

## Not reviewed

- **The maintenance-request channel** between the API and `install.sh run-requests` (updates, domain and
  certificate, host and operating system settings, the terminal switch): access control, injection and host
  capability exposure. Its reviewer was stopped twice by the model's safeguards. This is the path through which the
  panel changes its own host ([updates.md](updates.md)), so it deserves a human review.
- **Thirteen areas the coverage critic proposed after the wave**, none of which was assigned:
  1. Phone-number code and sign-in routes reachable without a session, as a quota question (the routes were removed
     in this release).
  2. Request and service logs as a second reader of secrets (tokens in URLs, access logs shipped to Loki / Grafana,
     host journal and Compose logs copied for the panel).
  3. Per-user copies that outlive authorisation: inbox and export contents, push subscriptions, chat connections and
     webhooks after demotion, ban, disable or sign-out.
  4. Live console, host terminal and event streams across role or permission changes, two-factor disable and the
     end of impersonation.
  5. Accounts created on behalf of an e-mail address by a reseller or the billing-system route and marked verified
     without proof.
  6. Reseller lifecycle (deactivate, remove, detach a customer) and priced self-service actions on externally billed
     servers.
  7. The binding of a copy order to its source across delete, reinstall, transfer and payment.
  8. `settings.manage` as a path to an administrator account through mail, sign-in method, social provider, security
     and captcha settings.
  9. Everything keyed to a server or its former owner that a transfer leaves in place.
  10. Addresses and state reported by the guest agent and consumed by the worker and API.
  11. Worker failure, cancel and undo paths per operation kind.
  12. Restoring an older database dump over a live panel.
  13. Hypervisor object identity in adapters: acting on a stored VM id without proving it is the panel-managed
      object.

  Several of these overlap with fixes above (items 1, 3, 4, 5, 6, 7 and 9 were touched by this release's changes),
  but none was reviewed as a unit, so no claim of coverage is made for them.

## Limits

- **Partial pass.** One hunting wave; 16 of 116 planned review units were deferred and the final coverage check
  never ran clean. There is no claim of complete coverage.
- **Not independent.** The review and the fixes were both produced with AI tooling under the maintainer's direction.
  No external party has audited the project.
- **How the fixes were verified.** By unit tests and by integration tests against real PostgreSQL and Redis
  (`apps/api/test/integration/security-*.test.mjs` and additions to the existing suites). They were **not** verified
  against real hypervisors, and the Param change was not verified against a real Param merchant account. The Caddy
  behaviour (one client address upstream) was not observed in the audit sandbox, which could not run Caddy.
- **Sandbox observations only.** Findings were reproduced with dummy data; several end states (a guest login, a
  hypervisor copy, a database import during restore) were reasoned from source rather than exercised.
- The deployed demo server and operators' own infrastructure (outer proxies, backup storage, hypervisors) were outside
  this audit.
