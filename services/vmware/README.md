# VMware adapter (Go + govmomi)

Internal HTTP service the API calls to talk to ESXi and vCenter through the vSphere Web Services
API (`/sdk`). Stateless, no published port, bearer token from `VMWARE_SERVICE_TOKEN_FILE`.

- `POST /v1/discover`: product, licenses (no keys), privileges, supported operations and the full
  inventory (hosts, datastores, networks, clusters, VMs). Read-only.
- `GET /healthz`

TLS modes `system`, `ca` and `pinned` (SHA-256 of the leaf); verification is never disabled.
Destination addresses are checked before every connection (see `netguard.go`).

```sh
go vet ./... && go test ./...   # tests run against govmomi's simulator, not real hardware
```

`cmd/simulator` is a test-only simulated vCenter/ESXi used by `compose.simulator.yaml`.
Details and the real-hardware acceptance list: `docs/vmware.md`.
