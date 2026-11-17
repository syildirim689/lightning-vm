# Console gateway (Go)

Relays `wss://<panel>/console/ws` to a VM's WebMKS endpoint on the management network.

- The browser presents only `lvm_console`, a one-time HttpOnly cookie scoped to `/console/ws`.
  The session (with the VMware ticket) is read from Redis with GETDEL, so it works once.
- Same-origin check before the upgrade; per-user and total limits; maximum duration. A panel served over
  https refuses an `http://` origin. Extra origins come from `CONSOLE_ALLOWED_ORIGINS` (comma-separated,
  each `https://host[:port]`; anything else is ignored and logged as `allowed_origin_ignored`).
- Upstream TLS must match the thumbprint/PEM that came with the ticket; destination addresses
  are checked like in the VMware adapter.
- Revocations arrive on Redis `console:revoke`; events go to the `console:events` stream, which
  the worker writes to `audit_events`. Tickets, cookies and upstream URLs are never logged.
- Requests with an unknown ticket have no principal: at most 5 `denied` events per minute are written for
  them (console and terminal gateway alike), and the next event carries the number that was suppressed.

```sh
go vet ./... && go test ./...   # upstream is a TLS WebSocket echo server, not VMware
```

Details: `docs/console.md`.
