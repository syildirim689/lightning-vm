# Console gateway (Go)

Relays `wss://<panel>/console/ws` to a VM's WebMKS endpoint on the management network.

- The browser presents only `lvm_console`, a one-time HttpOnly cookie scoped to `/console/ws`.
  The session (with the VMware ticket) is read from Redis with GETDEL, so it works once.
- Same-origin check before the upgrade; per-user and total limits; maximum duration.
- Upstream TLS must match the thumbprint/PEM that came with the ticket; destination addresses
  are checked like in the VMware adapter.
- Revocations arrive on Redis `console:revoke`; events go to the `console:events` stream, which
  the worker writes to `audit_events`. Tickets, cookies and upstream URLs are never logged.

```sh
go vet ./... && go test ./...   # upstream is a TLS WebSocket echo server, not VMware
```

Details: `docs/console.md`.
