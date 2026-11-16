# Hypervisor adapter HTTP contract

This is the exact HTTP contract of the internal adapter service `services/vmware` (Go, govmomi), written from
the code so that other adapters can speak the same contract. Everything below was read from
`services/vmware/*.go`, `apps/api/src/*.ts`, `apps/worker/*.mjs` and `apps/api/migrations/*.sql`; nothing is
assumed. Where the VMware adapter behaves in a surprising way it is marked **Note**.

**Who implements it.** Seven adapters speak this contract today. `services/vmware` implements all of it. Six Node.js
adapters implement a common subset:

| Adapter | Platform | Connection kind | Base URL variable (default) |
| --- | --- | --- | --- |
| `services/vmware` | vCenter / ESXi | `vcenter`, `esxi` | `VMWARE_SERVICE_URL` (`http://vmware:8080`) |
| `services/proxmox` | Proxmox VE | `proxmox` | `PROXMOX_SERVICE_URL` (`http://proxmox:8080`) |
| `services/xcpng` | XCP-ng / XenServer (XAPI) | `xcpng` | `XCPNG_SERVICE_URL` (`http://xcpng:8080`) |
| `services/ovirt` | oVirt Engine (REST) | `ovirt` | `OVIRT_SERVICE_URL` (`http://ovirt:8080`) |
| `services/hyperv` | Hyper-V (PowerShell over WinRM) | `hyperv` | `HYPERV_SERVICE_URL` (`http://hyperv:8080`) |
| `services/libvirt` | KVM (virsh over SSH) | `libvirt` | `LIBVIRT_SERVICE_URL` (`http://libvirt:8080`) |
| `services/incus` | Incus / LXD (REST) | `incus` | `INCUS_SERVICE_URL` (`http://incus:8080`) |

The six implement: `/v1/discover`, `/v1/task`, `/v1/vm/clone`, `/v1/vm/find`, `/v1/vms/managed`, `/v1/vm/power`,
`/v1/vm/destroy`, `/v1/vm/resize`, `/v1/vm/rename`, `/v1/vm/details`, `/v1/vm/metrics`, `/v1/vm/snapshots`,
`/v1/vm/snapshot`, `/v1/vm/disks`, `/v1/vm/disk-add`, `/v1/vm/disk-remove`, `/v1/topology` and `/v1/power`
(Proxmox VE also `/v1/vm/guest-setup`, section 9). They answer `400 PLATFORM_NOT_SUPPORTED`, a permanent code, for
the rest: `/v1/console-ticket`, `/v1/vm/disk-copy`, `/v1/backup/delete`, `/v1/image/create`, `/v1/image/delete`,
`/v1/network/create`, `/v1/network/delete`, `/v1/vm/nic-add`, `/v1/vm/nic-remove`, `/v1/vm/nic-mac`,
`/v1/vm/migrate`, `/v1/vm/firewall`, `/v1/vm/shaping`, `/v1/vm/cdrom`, `/v1/iso/upload`, `/v1/iso/delete` and
`/v1/scan`. Each adapter's `server.mjs` holds both lists (`routes` and `later`); read them there, since they change as
an adapter grows. Within the common subset the answers are not equally rich: `/v1/vm/metrics` returns history
(`samples`) only on VMware and Proxmox VE, `/v1/power` returns traffic samples only on those two, and
`cpuUsedMhz` of a VM is always 0 on XCP-ng, oVirt, libvirt and Incus.

Contents

1. Transport, authentication, limits
2. Target (the connection fields every request carries)
3. Errors: the Failure shape, codes and HTTP status
4. Tasks: asynchronous calls and `/v1/task`
5. Names, markers and idempotency conventions
6. Routes (36)
7. How the callers use it
8. Discovery result in detail

---

## 1. Transport, authentication, limits

- Plain HTTP on `:8080` inside the Docker network; no published port. The callers reach it at
  `VMWARE_SERVICE_URL` (default `http://vmware:8080`).
- The service is stateless. Every request carries the full connection (host, credentials, TLS trust); the
  adapter logs in, does the work and logs out again. Request bodies are never logged.
- **Authentication**: every path except `/healthz` needs the shared service token.

  ```go
  if r.URL.Path != "/healthz" {
      got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
      if token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
          writeJSON(w, 401, Failure{Code: "UNAUTHORIZED", Message: "service token required"})
  ```

  The token is read at start from the file named by `VMWARE_SERVICE_TOKEN_FILE`, trimmed, and must be at least
  32 characters (otherwise the process exits). The comparison is constant-time. A missing or wrong token gives
  `401 {"code":"UNAUTHORIZED","message":"service token required"}`. The check runs before routing, so an unknown
  path without a token is 401, not 404. Both callers send `Authorization: Bearer <token>` where the token is the
  trimmed content of `VMWARE_SERVICE_TOKEN_FILE` (default `/run/secrets/vmware_token`).
- **Method and path** are matched by Go's `http.ServeMux` patterns (`"POST /v1/..."`). A wrong method gives
  ServeMux's plain-text 405, an unknown path its plain-text 404 (both after the token check).
- **Request body**: JSON, decoded with `encoding/json` without `DisallowUnknownFields`, so unknown fields are
  ignored and missing fields take their zero value. Field names are matched case-insensitively by Go. Body size
  limits: 64 KiB for `/v1/discover` and `/v1/console-ticket`, 256 KiB for every other POST route. A body that is
  not valid JSON (or exceeds the limit) gives `400 INVALID_REQUEST`.
- **Response**: always `Content-Type: application/json`; `200` with the result on success, otherwise a Failure
  (section 3). No other success status is used.
- **Timeouts** are per route (listed with each route); when the adapter's own deadline passes the result is
  `502 TIMEOUT`. The callers' own timeouts: the API passes one per call (30 to 120 s), the worker uses 130 s for
  every call.
- `GET /healthz` is used by the container health check only (`/vmware healthcheck` in `compose.yaml` runs the
  binary, which requests `http://127.0.0.1:8080/healthz`).
- **Address guard** (`netguard.go`): the target host is resolved once, every resolved address is checked, and
  the checked address is dialled. Loopback, link-local, unspecified, multicast addresses and every subnet the
  container itself has an interface on are refused with `ENDPOINT_BLOCKED`, unless the address is inside
  `VMWARE_ALLOW_NETWORKS` (comma-separated CIDRs). `VMWARE_DENY_NETWORKS` adds blocked ranges. No HTTP proxy is
  ever used towards the endpoint.

  **Every adapter applies this guard**, with the same rule and its own pair of variables: `PROXMOX_`, `XCPNG_`,
  `OVIRT_`, `HYPERV_`, `LIBVIRT_` and `INCUS_ALLOW_NETWORKS` / `..._DENY_NETWORKS` (`addressGuard` in each
  adapter's client module: `pve.mjs`, `xapi.mjs`, `engine.mjs`, `winrm.mjs`, `ssh.mjs`, `incus.mjs`). The
  container's own interface subnets are read at start (`os.networkInterfaces()`), so an adapter refuses the Docker
  networks it sits on (PostgreSQL, Redis and the API live there) without any configuration; an address inside an
  `ALLOW` network is permitted even when a built-in rule, an own subnet or a `DENY` network would refuse it.
  `compose.yaml` passes all of these variables through (empty by default).

---

## 2. Target

Every route except `/healthz` and `/v1/scan` embeds this struct at the top level of its JSON body (Go struct
embedding: the fields are siblings of the route's own fields, not nested under a key):

```go
type TLSSettings struct {
    Mode   string `json:"mode"`
    CAPEM  string `json:"caPem,omitempty"`
    SHA256 string `json:"sha256,omitempty"`
}

type Request struct {
    Host     string      `json:"host"`
    Port     int         `json:"port"`
    Username string      `json:"username"`
    Password string      `json:"password"`
    TLS      TLSSettings `json:"tls"`
    // APIVersion pins the vSphere API (SOAP) version, e.g. "6.7.3" or "7.0.3.0". Empty: use the endpoint's own.
    APIVersion string `json:"apiVersion,omitempty"`
}
```

| JSON | Go type | Required | Meaning |
| --- | --- | --- | --- |
| `host` | string | yes | DNS name or IP of the ESXi/vCenter. Also the TLS server name that is verified. |
| `port` | int | no | `0`/absent means 443. |
| `username` | string | yes | Account used for the session login. |
| `password` | string | yes in practice | Never logged. |
| `tls.mode` | string | no | `""` or `"system"`: system CAs. `"ca"`: system CAs plus `tls.caPem` (host name still verified). `"pinned"`: the leaf certificate's SHA-256 must equal `tls.sha256`; chain and name are not checked. Anything else: `INVALID_TLS_MODE`. Verification is never off. Minimum TLS 1.2. |
| `tls.caPem` | string | for `ca` | PEM bundle; not parseable gives `INVALID_CA`. |
| `tls.sha256` | string | for `pinned` | 64 hex characters; colons and upper case are accepted and normalised. Other lengths give `INVALID_PIN`. |
| `apiVersion` | string | no | VMware only: pins the SOAP API version. Empty: the endpoint's own version is used. |

Only `/v1/discover` and `/v1/console-ticket` validate `host` and `username` up front (`400 INVALID_REQUEST`
when empty). The other routes do not; an empty host simply fails while connecting.

What the callers send (identical in the API's `storedTarget` and the worker's `connectionTarget`):
`{ host, port, username, password, tls: { mode, caPem?, sha256? }, apiVersion? }`, built from a
`vmware_connections` row with the password decrypted in memory. The API only ever stores `tls.sha256` as 64
lower-case hex characters and `tls.mode` as one of `system`, `ca`, `pinned`.

**Note**: for a connection whose kind is one of `proxmox`, `xcpng`, `ovirt`, `hyperv`, `libvirt` or `incus` the
callers also add `platform: "<kind>"` to the target and use it to choose the adapter's base URL (the table at the top
of this document). Connections of kind `vcenter` and `esxi` carry no `platform` and go to the VMware adapter, which
ignores the field. Every adapter should ignore unknown fields too (`apiVersion` in particular is still sent if a row
has one).

Connecting (`connect` in `discover.go`), done once per request:

1. TLS config from `tls` (errors `INVALID_CA`, `INVALID_PIN`, `INVALID_TLS_MODE`).
2. Guarded TCP dial, TLS handshake, the endpoint's service content is read (no credentials yet). A failure
   here is classified (section 3); for `TLS_UNTRUSTED`, `TLS_HOSTNAME_MISMATCH` and `TLS_PIN_MISMATCH` the
   presented leaf certificate is read on a second, unverified connection and attached as `certificate`.
3. Session login with user name and password (`INVALID_LOGIN` when rejected).
4. The work; then logout (even when the request context is already cancelled).

---

## 3. Errors

### 3.1 Failure shape

```go
type Failure struct {
    Code        string           `json:"code"`
    Message     string           `json:"message"`
    Certificate *CertificateInfo `json:"certificate,omitempty"`
}

type CertificateInfo struct {
    Subject  string   `json:"subject"`
    Issuer   string   `json:"issuer"`
    NotAfter string   `json:"notAfter"`   // UTC, "2006-01-02T15:04:05Z"
    SHA256   string   `json:"sha256"`     // lower-case hex of the DER leaf
    DNSNames []string `json:"dnsNames"`   // may be null
    IPs      []string `json:"ips"`        // always an array
    PEM      string   `json:"pem"`
}
```

`code` is the stable part; `message` is English text for logs. `certificate` appears only on the three TLS trust
failures while connecting, and only if the certificate could be read. The API passes `code`, `message` and
`certificate` on to the web UI (the "trust this certificate" dialog uses `certificate.sha256` and
`certificate.pem`).

### 3.2 HTTP status per code (`failureStatus`)

```go
func failureStatus(code string) int {
    switch code {
    case "VM_NOT_FOUND", "DATASTORE_NOT_FOUND", "SNAPSHOT_NOT_FOUND":
        return http.StatusNotFound
    case "VM_POWERED_OFF", "TOOLS_NOT_RUNNING", "NOT_MANAGED", "NO_CDROM_CONTROLLER", "NOT_IMPORTABLE", "DISK_HAS_SNAPSHOTS", "DISK_SHRINK_NOT_SUPPORTED", "INVALID_STATE", "VM_HAS_NO_DISK", "DISK_NOT_SUPPORTED", "SYSTEM_DISK", "NO_DISK_CONTROLLER",
        "FIREWALL_NEEDS_DVS", "FIREWALL_NO_PORT", "CONSOLE_TLS_UNVERIFIABLE", "WRITE_RESTRICTED", "INSUFFICIENT_RESOURCES", "DUPLICATE_NAME":
        // The request is fine; the VM, its network or the endpoint's licence is not in a state that allows it.
        return http.StatusConflict
    case "INVALID_LOGIN", "PERMISSION_DENIED":
        return http.StatusUnauthorized
    case "INVALID_CA", "INVALID_PIN", "INVALID_TLS_MODE", "INVALID_REQUEST", "ENDPOINT_BLOCKED", "PROVISIONING_NOT_SUPPORTED", "TEMPLATE_NOT_FOUND", "NETWORK_NOT_FOUND", "TEMPLATE_HAS_NO_NIC", "DISK_SMALLER_THAN_TEMPLATE", "FIREWALL_TOO_MANY_RULES":
        return http.StatusBadRequest
    }
    return http.StatusBadGateway
}
```

| Status | Codes |
| --- | --- |
| 400 | `INVALID_REQUEST`, `INVALID_CA`, `INVALID_PIN`, `INVALID_TLS_MODE`, `ENDPOINT_BLOCKED`, `PROVISIONING_NOT_SUPPORTED`, `TEMPLATE_NOT_FOUND`, `NETWORK_NOT_FOUND`, `TEMPLATE_HAS_NO_NIC`, `DISK_SMALLER_THAN_TEMPLATE`, `FIREWALL_TOO_MANY_RULES` |
| 401 | `UNAUTHORIZED` (service token), `INVALID_LOGIN`, `PERMISSION_DENIED` |
| 404 | `VM_NOT_FOUND`, `DATASTORE_NOT_FOUND`, `SNAPSHOT_NOT_FOUND` |
| 409 | `VM_POWERED_OFF`, `TOOLS_NOT_RUNNING`, `NOT_MANAGED`, `NO_CDROM_CONTROLLER`, `NOT_IMPORTABLE`, `DISK_HAS_SNAPSHOTS`, `DISK_SHRINK_NOT_SUPPORTED`, `INVALID_STATE`, `VM_HAS_NO_DISK`, `DISK_NOT_SUPPORTED`, `SYSTEM_DISK`, `NO_DISK_CONTROLLER`, `FIREWALL_NEEDS_DVS`, `FIREWALL_NO_PORT`, `CONSOLE_TLS_UNVERIFIABLE`, and the task-fault codes `WRITE_RESTRICTED`, `INSUFFICIENT_RESOURCES`, `DUPLICATE_NAME` when a route waits for a task itself |
| 502 | everything else: `TLS_UNTRUSTED`, `TLS_HOSTNAME_MISMATCH`, `TLS_PIN_MISMATCH`, `DNS_FAILED`, `CONNECTION_REFUSED`, `TIMEOUT`, `NOT_VSPHERE`, `VMWARE_ERROR`, `FIREWALL_APPLY_FAILED`, `TASK_FAILED` |

The Node.js adapters use the same table (`statusOf` in each `server.mjs`), with their own catch-all code in place of
`VMWARE_ERROR`: `PROXMOX_ERROR`, `XAPI_ERROR`, `OVIRT_ERROR`, `HYPERV_ERROR`, `LIBVIRT_ERROR`, `INCUS_ERROR`.

Neither caller looks at the exact status: both test `res.ok` and then read `code` (and `message`). The API turns
every adapter failure into its own `422` with the adapter's `code`; the worker turns it into an
`OperationError(code, message)`. So the code is the contract, the status is advisory.

### 3.3 How a Go error becomes a code (`classify`)

Every error returned by a handler goes through `classify`, in this order:

| Condition | Code | Message |
| --- | --- | --- |
| the error is already a `*Failure` | unchanged | unchanged |
| address guard refused | `ENDPOINT_BLOCKED` | `endpoint address is not permitted` |
| pinned fingerprint differs | `TLS_PIN_MISMATCH` | fixed text |
| `x509.HostnameError` | `TLS_HOSTNAME_MISMATCH` | Go's text |
| unknown authority / certificate verification error | `TLS_UNTRUSTED` | Go's text |
| DNS error | `DNS_FAILED` | Go's text |
| `ECONNREFUSED` | `CONNECTION_REFUSED` | Go's text |
| network timeout or context deadline | `TIMEOUT` | `timed out` |
| vSphere fault `InvalidLogin` | `INVALID_LOGIN` | `user name or password rejected` |
| vSphere fault `ManagedObjectNotFound` | `VM_NOT_FOUND` | `virtual machine not found` |
| vSphere fault `NoPermission` | `PERMISSION_DENIED` | `the account lacks a required privilege` |
| a task the adapter waited for itself failed | the task-fault code of section 4 | the fault's text |
| the request was cancelled | `TIMEOUT` | fixed text |
| anything else | `VMWARE_ERROR` | the error's text |

**Notes**

- `VM_NOT_FOUND` is returned for *any* managed object that no longer exists (a VM, but also a port group, host
  or datastore referenced by the call), because the mapping is on the fault type.
- `VMWARE_ERROR` is the catch-all: vSphere answered with something the adapter has no code for (any fault not
  listed above, raised synchronously). It comes back as `502 VMWARE_ERROR` with the fault text in the message, and
  the worker treats it as retryable.
- `NOT_VSPHERE` now means only what it says. It is decided in one place, while connecting: when creating the
  client fails with something that is not a SOAP fault, nothing spoke the vSphere API at `/sdk`
  (`no vSphere Web Services API answered at /sdk: <error>`).
- Faults inside tasks are reported by `/v1/task` with the task-fault codes (section 4), not through `classify`.

### 3.4 Codes the worker treats as permanent

`apps/worker/operations.mjs` retries (with backoff) every failure whose code is not in this set:

```
SNAPSHOT_NOT_FOUND INVALID_LOGIN PERMISSION_DENIED WRITE_RESTRICTED PROVISIONING_NOT_SUPPORTED TEMPLATE_NOT_FOUND
NETWORK_NOT_FOUND TEMPLATE_HAS_NO_NIC DISK_SMALLER_THAN_TEMPLATE INSUFFICIENT_RESOURCES NOT_MANAGED TOOLS_NOT_RUNNING
TLS_UNTRUSTED TLS_HOSTNAME_MISMATCH TLS_PIN_MISMATCH ENDPOINT_BLOCKED INVALID_REQUEST SECRET_KEY_UNAVAILABLE
INVALID_STATE VM_NOT_FOUND FIREWALL_NEEDS_DVS FIREWALL_TOO_MANY_RULES DISK_SHRINK_NOT_SUPPORTED DISK_HAS_SNAPSHOTS
VM_HAS_NO_DISK DISK_NOT_SUPPORTED DATASTORE_NOT_FOUND PLATFORM_NOT_SUPPORTED HOST_IS_SLAVE
```

A second adapter should use these codes with the same meaning: a permanent code ends the operation at once; any
other code (including `TASK_FAILED`, `TIMEOUT`, `NOT_VSPHERE`, `VMWARE_ERROR` and the other adapters' catch-all codes,
`DUPLICATE_NAME`, `ENGINE_BUSY`) is retried until the job's attempts run out.

`ENGINE_BUSY` (oVirt adapter) is the retryable code for "the platform is still working on this object": the engine
refused a call because the VM, a disk or a snapshot is locked by an earlier action, or a server that must be down
for a snapshot restore is still stopping. Nothing was changed; the same call succeeds once the lock is gone.

---

## 4. Tasks

Routes are either **synchronous** (the response is the final result) or **task** routes: they start a
vSphere task and return its id at once as `{"task": "<id>"}`. The caller stores the id and polls
`POST /v1/task` until it is done. A task route may also answer `{"task": ""}` (empty string) to say "nothing to
do, already in the wanted state"; the callers test `if (out.task)`.

| Kind | Routes |
| --- | --- |
| Task (returns `task`) | `/v1/vm/clone`, `/v1/vm/power`, `/v1/vm/destroy`, `/v1/vm/resize`, `/v1/vm/disk-copy`, `/v1/vm/disk-add`, `/v1/vm/disk-remove`, `/v1/image/create`, `/v1/vm/nic-add`, `/v1/vm/nic-remove`, `/v1/vm/migrate`, `/v1/vm/snapshot` |
| Synchronous (waits inside the adapter where needed) | everything else, including `/v1/vm/rename`, `/v1/backup/delete`, `/v1/image/delete`, `/v1/network/create`, `/v1/network/delete`, `/v1/vm/firewall`, `/v1/vm/shaping`, `/v1/vm/cdrom`, `/v1/iso/delete`, `/v1/iso/upload` |

### POST /v1/task

- Timeout 30 s. Synchronous (it is the poll).
- Request: Target plus

  | JSON | Go type | Required | Meaning |
  | --- | --- | --- | --- |
  | `task` | string | yes | The task id returned by a task route (a vSphere `Task` managed object id, for example `task-123`). |

  (The body is decoded into `VMRequest`; its other fields `vm`, `name`, `action` are ignored here.)
- Response:

  ```go
  type TaskState struct {
      State string `json:"state"` // queued, running, success, error
      VM    string `json:"vm,omitempty"`
      Code  string `json:"code,omitempty"`
      Error string `json:"error,omitempty"`
  }
  ```

  | JSON | Meaning |
  | --- | --- |
  | `state` | vSphere's `TaskInfo.state` verbatim: `"queued"`, `"running"`, `"success"`, `"error"`. Plus `"unknown"` when the task no longer exists. |
  | `vm` | Present when the task's result is a managed object reference: its id. For a clone this is the new VM's id. **Note**: the field is filled for any task whose result is a reference (a snapshot task returns the snapshot's id here), so it is only meaningful after `/v1/vm/clone` and `/v1/image/create`. The worker reads it only after a clone. |
  | `code` | Only with `state: "error"` (see below), or `"TASK_NOT_FOUND"` with `state: "unknown"`. |
  | `error` | Only with `state: "error"`: vSphere's localized fault message (may be empty). |

  There is **no progress field**. The HTTP status is 200 for every task state, including `error` and `unknown`.
- A task that has expired from vCenter's memory is not an error:
  `200 {"state":"unknown","code":"TASK_NOT_FOUND"}`. A task the platform no longer knows proves nothing about its
  result, so the worker does not treat it as finished: see "How the worker polls" below.
- Task error codes (`taskFault`):

  | vSphere fault | `code` |
  | --- | --- |
  | `RestrictedVersion` (free ESXi licence, read-only API) | `WRITE_RESTRICTED` |
  | `NoPermission` | `PERMISSION_DENIED` |
  | `InsufficientResourcesFault`, `NotEnoughLicenses` | `INSUFFICIENT_RESOURCES` |
  | `DuplicateName` | `DUPLICATE_NAME` |
  | `InvalidState`, `InvalidPowerState` | `INVALID_STATE` |
  | anything else, or no fault attached | `TASK_FAILED` |

- Other errors of this route: connection codes; any other failure to read the task goes through `classify`.

How the worker polls (`waitTask`): every 2 seconds, forever, bounded only by the operation's own deadline and
cancel flag. `state === "success"` ends the wait; `state === "error"` throws `code`/`error`;
`code === "TASK_NOT_FOUND"` ends the wait and is handed back to the step that waited; anything else (`queued`,
`running`, any unknown string) keeps polling. The task id is written to `operations.provider_task_id` before the
first poll, so a restarted worker resumes the wait instead of starting the action again. Task ids must therefore stay
valid across adapter restarts and be usable with a fresh login.

What a step does with `TASK_NOT_FOUND` (`lostTask` in `apps/worker/operations.mjs`): the stored task id is dropped,
then

- where the result can be read from the real object, it is read: the VM is looked up by name after a clone, the
  power state is compared with the wanted one after `on` / `off`, a created or removed snapshot is looked for in
  the snapshot list. If the result is there, the step is done;
- otherwise the step fails with the retryable `TASK_FAILED`, and the next attempt issues the call again. This is
  safe because every step that can come here either is safe to repeat or first checks what already exists (a
  migration asked for again is answered "already there" by the adapter when it did finish);
- two exceptions: a `reset` cannot be read back and a second one would cut the guest off again, so a lost reset
  counts as done; a lost destroy task is simply not waited for, and the VM's absence is verified by `/v1/vm/find`
  (a VM that is still listed fails the step, and the retry destroys anew).

An adapter must therefore make its task routes either repeatable or answer "already done" when asked again.

**Task ids of the other adapters.** A task id is opaque to the callers: they store it and hand it back to the same
adapter's `/v1/task`. Because an adapter keeps no state, an id says by itself what to look at:

| Adapter | Task id | What `/v1/task` does with it |
| --- | --- | --- |
| Proxmox VE | the UPID | reads the task's status on its node |
| Proxmox VE | `<UPID>|<vmid>` (a clone) | when the copy has ended, gives the new VM its settings (CPU, memory, network, cloud-init, disk size) before answering `success` with `vm` |
| Proxmox VE | `wait|<vmid>` | a copy whose UPID is not known (the clone's answer was lost and the call was repeated): the VM's `lock: clone` tells whether it still runs; then as above |
| oVirt | `create:<vm>` | ready when the VM and its disks are no longer locked; the network profile and the disk size are applied on the way |
| oVirt | `remove:<vm>` | done when the VM is gone |
| oVirt | `disk:<disk>` | a disk being grown: done when the disk is no longer locked |
| oVirt | `snapshot:<vm>:<snapshot>`, `unsnap:<vm>:<snapshot>`, `restore:<vm>:<snapshot>` | a snapshot being taken, removed or restored: done when the snapshot (and the VM) has settled, or is gone for `unsnap` |
| XCP-ng | the XAPI task reference | the copy task carries the VM's name (`other_config`), so a repeated clone finds the running copy by name and hands back the same task instead of starting a second one |
| Hyper-V, libvirt | the id of a job file on the host | reads the state the background copy wrote |
| Incus | the operation's id | reads the operation |

Requests an adapter refuses before starting anything: the libvirt adapter's clone answers `400 INVALID_REQUEST` for a
`serverId` that is not a UUID (the MAC address and the job are derived from it) and for network settings whose
addresses are not IP addresses (they are written into the domain's description and a shell script).

---

## 5. Names, markers and idempotency conventions

- **Managed prefix**: `const managedPrefix = "lvm-"`. A VM whose name starts with `lvm-` belongs to the panel.
  - Server VM: `lvm-<server uuid>` (the callers build it; the server id is a 36-character UUID).
  - Personal image template: `lvm-img-<image uuid>`.
  - Private network port group: `lvm-net-<network uuid>`.
- **Name is the idempotency anchor.** `/v1/vm/clone` first looks for a VM with exactly the requested name and
  returns it (`existed: true`) instead of cloning again. `/v1/image/create` and `/v1/network/create` do the
  same for their names. The panel finds its VMs again by name (`/v1/vm/find`, `/v1/vms/managed`), never by a
  stored id alone.
- **Refusing foreign objects**: routes that change or delete something check the prefix on the live object and
  answer `409 NOT_MANAGED` otherwise: `/v1/vm/destroy`, `/v1/vm/resize`, `/v1/vm/cdrom`, `/v1/vm/disks`,
  `/v1/vm/disk-add`, `/v1/vm/disk-remove`, `/v1/vm/disk-copy`, `/v1/vm/nic-add`, `/v1/vm/nic-remove`,
  `/v1/vm/nic-mac`, `/v1/vm/migrate`, `/v1/image/create` (source must be `lvm-` but not `lvm-img-`),
  `/v1/image/delete` (`lvm-img-` only), `/v1/network/delete` (`lvm-net-` only).
  **Note**: `/v1/vm/power`, `/v1/vm/snapshot`, `/v1/vm/snapshots`, `/v1/vm/firewall`, `/v1/vm/shaping`,
  `/v1/vm/details`, `/v1/vm/metrics` and `/v1/console-ticket` do *not* check the prefix (the admin console and
  details work on any VM of a connection).
- **Markers written on a cloned VM**:
  - annotation (notes): `Managed by Lightning VM (server <serverId>)`
  - extra config key `lightning.server-id` = `<serverId>`; read back as `serverId` in `VMState`.
- **Already gone is success**: `/v1/vm/destroy` (VM missing: `{"task":"","gone":true}`),
  `/v1/vm/disk-remove` (disk missing: `{"task":"","gone":true}`), `/v1/backup/delete`, `/v1/iso/delete`,
  `/v1/image/delete`, `/v1/network/delete` (all `{}` when the object is missing).
- **Already done is success**: `/v1/vm/rename` (already has the name), `/v1/vm/nic-add` (a NIC on that port
  group exists: `{"task":""}`), `/v1/vm/nic-remove` (none there: `{"task":""}`), `/v1/vm/migrate` (already on
  that host: `{"task":"","already":true}`), `/v1/vm/firewall` and `/v1/vm/shaping` (the whole state is written
  each time).
- **Datastore folders**: ISOs in `[datastore] lightning-iso/<name>.iso`; backups in
  `[datastore] lightning-backups/<server id>/<backup id>.vmdk`.
- **Snapshot names** used by the callers: a customer's own name; `auto ...` for scheduled snapshots (the API
  filters `name.startsWith('auto ')`); `lightning-backup <backup id>` for the short snapshot a backup takes (the
  worker finds it again by exact name).
- **Identifiers are opaque strings to the callers, with three exceptions**:
  - a VM id passed to the console must match `^[\w-]{1,80}$` (`apps/api/src/console.ts`);
  - a snapshot id coming from the web UI must match `^snapshot-\d{1,12}$` (`apps/api/src/snapshots.ts`);
  - a disk `key` is an integer (`int32`), stored in `server_disks.device_key`.
  Inside the VMware adapter a network id starting with `dvportgroup-` is treated as a distributed port group,
  anything else as a standard network.
- **Power state strings** are vSphere's and are compared literally by the callers: `"poweredOn"`,
  `"poweredOff"`, `"suspended"`.

---

## 6. Routes

Conventions used below: "Target" means the fields of section 2 at the top level of the body. "Connection
errors" means the codes any route can return from connecting: `INVALID_CA`, `INVALID_PIN`,
`INVALID_TLS_MODE`, `ENDPOINT_BLOCKED`, `TLS_UNTRUSTED`, `TLS_HOSTNAME_MISMATCH`, `TLS_PIN_MISMATCH`,
`DNS_FAILED`, `CONNECTION_REFUSED`, `TIMEOUT`, `INVALID_LOGIN`, `NOT_VSPHERE` (nothing answered at `/sdk`). "Common errors" means the
connection errors plus what `classify` can produce from the work itself: `VM_NOT_FOUND` (object gone),
`PERMISSION_DENIED`, `TIMEOUT`, `VMWARE_ERROR` (any other fault). Every POST route can also return
`400 INVALID_REQUEST` ("invalid JSON").

Route list:

| # | Method | Path | Kind | Timeout |
| --- | --- | --- | --- | --- |
| 1 | GET | `/healthz` | sync | - |
| 2 | POST | `/v1/discover` | sync | 60 s |
| 3 | POST | `/v1/scan` | sync | 120 s |
| 4 | POST | `/v1/console-ticket` | sync | 30 s |
| 5 | POST | `/v1/task` | sync (poll) | 30 s |
| 6 | POST | `/v1/vm/clone` | task | 60 s |
| 7 | POST | `/v1/vm/find` | sync | 30 s |
| 8 | POST | `/v1/vms/managed` | sync | 60 s |
| 9 | POST | `/v1/vm/power` | task | 60 s |
| 10 | POST | `/v1/vm/destroy` | task | 120 s |
| 11 | POST | `/v1/vm/resize` | task | 60 s |
| 12 | POST | `/v1/vm/rename` | sync | 60 s |
| 13 | POST | `/v1/vm/details` | sync | 30 s |
| 14 | POST | `/v1/vm/metrics` | sync | 30 s |
| 15 | POST | `/v1/vm/snapshots` | sync | 30 s |
| 16 | POST | `/v1/vm/snapshot` | task | 60 s |
| 17 | POST | `/v1/vm/disks` | sync | 30 s |
| 18 | POST | `/v1/vm/disk-add` | task | 60 s |
| 19 | POST | `/v1/vm/disk-remove` | task | 60 s |
| 20 | POST | `/v1/vm/disk-copy` | task | 60 s |
| 21 | POST | `/v1/backup/delete` | sync | 120 s |
| 22 | POST | `/v1/image/create` | task | 60 s |
| 23 | POST | `/v1/image/delete` | sync | 120 s |
| 24 | POST | `/v1/network/create` | sync | 90 s |
| 25 | POST | `/v1/network/delete` | sync | 90 s |
| 26 | POST | `/v1/vm/nic-add` | task | 90 s |
| 27 | POST | `/v1/vm/nic-remove` | task | 90 s |
| 28 | POST | `/v1/vm/nic-mac` | sync | 90 s |
| 29 | POST | `/v1/vm/migrate` | task | 60 s |
| 30 | POST | `/v1/vm/firewall` | sync | 90 s |
| 31 | POST | `/v1/vm/shaping` | sync | 90 s |
| 32 | POST | `/v1/vm/cdrom` | sync | 60 s |
| 33 | PUT | `/v1/iso/upload` | sync (streaming) | 12 h |
| 34 | POST | `/v1/iso/delete` | sync | 120 s |
| 35 | POST | `/v1/topology` | sync | 60 s |
| 36 | POST | `/v1/power` | sync | 60 s |

Several routes decode the same generic struct and use only some of its fields:

```go
type VMRequest struct {
    Request
    VM     string `json:"vm"`
    Name   string `json:"name"`
    Task   string `json:"task"`
    Action string `json:"action"`
}
```

Used by `/v1/vm/find` (`name`), `/v1/task` (`task`), `/v1/vm/power` (`vm`, `action`), `/v1/vm/destroy`
(`vm`), `/v1/vm/details` (`vm`), `/v1/vm/metrics` (`vm`), `/v1/vms/managed`, `/v1/topology`, `/v1/power`
(Target only).

### 6.1 GET /healthz

- No authentication. No body.
- Response `200 {"status":"ok"}`. It does not contact any endpoint.

### 6.2 POST /v1/discover

- Synchronous, read-only, 60 s. Body limit 64 KiB.
- Request: Target only. `host` and `username` must be non-empty, else
  `400 {"code":"INVALID_REQUEST","message":"host and username are required"}`.
- Response: the `Result` structure; see section 8 for every field.
- Errors: connection errors (with `certificate` on TLS trust failures), then for each inventory read
  `VM_NOT_FOUND`, `PERMISSION_DENIED`, `TIMEOUT`, `VMWARE_ERROR`. A licence list or privilege check that cannot
  be read is not an error; it becomes a warning (`LICENSE_UNREADABLE`, `PRIVILEGES_UNREADABLE`).
- Nothing is changed on the endpoint. The whole inventory is returned in one response (no paging).

### 6.3 POST /v1/scan

- Synchronous, 120 s. The only route without a Target: no credentials are sent to anything.
- Request:

  ```go
  type ScanRequest struct {
      Addresses []string `json:"addresses"`
      Port      int      `json:"port"`
      TimeoutMs int      `json:"timeoutMs"`
  }
  ```

  | JSON | Go type | Required | Meaning |
  | --- | --- | --- | --- |
  | `addresses` | []string | yes | 1 to 256 literal IP addresses (v4 or v6; no names, no CIDR). Otherwise `INVALID_REQUEST`. |
  | `port` | int | no | `0` means 443; must be 1 to 65535. |
  | `timeoutMs` | int | no | Per-address probe timeout. `0` means 1500; other values are clamped to 300..5000. |

- Response:

  ```go
  type ScanResult struct {
      Hits    []ScanHit `json:"hits"`
      Closed  int       `json:"closed"`  // refused the connection
      Silent  int       `json:"silent"`  // no answer in time, or not TLS
      Blocked int       `json:"blocked"` // not permitted by the address guard
  }
  type ScanHit struct {
      Address     string    `json:"address"`
      State       string    `json:"state"`
      Hostname    string    `json:"hostname,omitempty"`
      Product     *Product  `json:"product,omitempty"`
      Certificate *ScanCert `json:"certificate,omitempty"`
  }
  type ScanCert struct {
      Subject     string   `json:"subject"`
      Issuer      string   `json:"issuer"`
      NotAfter    string   `json:"notAfter"`
      SHA256      string   `json:"sha256"`
      DNSNames    []string `json:"dnsNames"`
      IPs         []string `json:"ips"`
      SelfSigned  bool     `json:"selfSigned"`
      TrustedName string   `json:"trustedName"` // a name the system CAs verify this certificate for; empty when not trusted
  }
  ```

  - `hits`: always an array (order is not defined; probes run 32 at a time). One entry per address that
    completed a TLS handshake.
  - `state`: `"vsphere"` when the anonymous service-content call answered as ESXi or vCenter (then `product` is
    set, same `Product` struct as in discovery), otherwise `"https"` (some other TLS service; no `product`).
  - `hostname`: the PTR name of the address if one resolves within 700 ms, without trailing dot.
  - `certificate`: the leaf certificate read without trusting it. `trustedName` is the address or the PTR name
    if the system CAs verify the chain for it, else `""`.
  - `closed` + `silent` + `blocked` + `len(hits)` = number of addresses.
- Errors: `INVALID_REQUEST` (count, port, non-IP address); `TIMEOUT` if the whole call exceeds its deadline.
- The certificate is deliberately not verified here: trust is decided later, when the admin adds the endpoint.

### 6.4 POST /v1/console-ticket

- Synchronous, 30 s. Body limit 64 KiB.
- Request: Target plus

  ```go
  type TicketRequest struct {
      Request
      VM string `json:"vm"` // VirtualMachine managed object id, e.g. "vm-42"
  }
  ```

  `host`, `username` required at decode time (`INVALID_REQUEST`, message "host, username and vm are
  required"); empty `vm` gives `INVALID_REQUEST` ("vm is required").
- Response:

  ```go
  type ConsoleTicket struct {
      URL      string   `json:"url"`
      Host     string   `json:"host"`
      SHA1     string   `json:"sha1,omitempty"`
      SHA256   []string `json:"sha256,omitempty"`
      CertPEM  string   `json:"certPem,omitempty"`
      VMName   string   `json:"vmName"`
      PowerOn  bool     `json:"poweredOn"`
      Endpoint string   `json:"endpoint"` // the connection's own host, for logs
  }
  ```

  | JSON | Meaning |
  | --- | --- |
  | `url` | The WebSocket URL the console gateway dials. The ticket's own URL when vSphere returns one (API 7.0+), otherwise built as `wss://<host>:<port>/ticket/<ticket>` (port 443 when the ticket has none). Contains the single-use secret. |
  | `host` | The host that serves the console (the ESXi host the VM runs on, or the connection's host when the ticket names none). |
  | `sha1` | The serving host's certificate SHA-1 thumbprint, lower-case hex without colons. Omitted when empty. |
  | `sha256` | SHA-256 thumbprints from the ticket's thumbprint list, same normalisation. Omitted when empty. |
  | `certPem` | The serving host's certificate when the ticket carries it. Omitted when empty. |
  | `vmName` | The VM's name. |
  | `poweredOn` | Always `true` in a success response. |
  | `endpoint` | The request's `host`, for logs. |

- Errors: `VM_NOT_FOUND` (the VM's properties cannot be read, for any reason), `VM_POWERED_OFF` (409),
  `CONSOLE_TLS_UNVERIFIABLE` (409; the ticket has neither thumbprint nor certificate, so the gateway could not
  verify the host), common errors.
- The ticket is a vSphere `webmks` ticket. The console gateway (`services/console`) connects to `url` as a
  WebSocket client offering the browser's sub-protocol (one of `binary`, `base64`, `uint8utf8`) and verifies
  the upstream certificate against `certPem`, `sha1` or `sha256`; it then relays frames between browser and
  host unchanged. The browser side is VMware's WebMKS client.

### 6.5 POST /v1/task

See section 4.

### 6.6 POST /v1/vm/clone

- Task route, 60 s. vCenter only.
- Request: Target plus

  ```go
  type CloneRequest struct {
      Request
      Name      string `json:"name"`      // "lvm-<server id>": the idempotency anchor in VMware
      Template  string `json:"template"`  // template VM moref
      Pool      string `json:"pool"`      // resource pool moref
      Datastore string `json:"datastore"` // datastore moref
      Network   string `json:"network"`   // network or dvportgroup moref
      VCPU      int32  `json:"vcpu"`
      MemoryMB  int64  `json:"memoryMb"`
      DiskGB    int64  `json:"diskGb"`
      Metadata  string `json:"metadata"` // cloud-init metadata (instance id, hostname, network)
      Userdata  string `json:"userdata"` // cloud-init user data (SSH keys); never logged
      ServerID  string `json:"serverId"`
      Customization string `json:"customization"`
      CPUHotAdd    bool `json:"cpuHotAdd"`
      MemoryHotAdd bool `json:"memoryHotAdd"`
      NestedHV     bool `json:"nestedHv"`
      VAppProperties map[string]string `json:"vappProperties"`
  }
  ```

  | JSON | Go type | Required | Meaning |
  | --- | --- | --- | --- |
  | `name` | string | yes | Must start with `lvm-`. The new VM's name and the idempotency key. |
  | `template` | string | yes | Id of the VM (template, or another server's VM when cloning a server) to clone from. |
  | `pool` | string | yes | Resource pool id (from discovery: `compute[].resourcePool`). |
  | `datastore` | string | yes | Datastore id. |
  | `network` | string | yes | Network id for the first NIC. |
  | `vcpu` | int32 | yes in practice | Number of vCPUs of the new VM. |
  | `memoryMb` | int64 | yes in practice | Memory in MiB. |
  | `diskGb` | int64 | yes in practice | Size of the first disk in GiB. Larger than the template: the disk is grown as part of the clone. Equal: unchanged. Smaller: `DISK_SMALLER_THAN_TEMPLATE`. |
  | `metadata` | string | for `cloudinit`/`guestinfo` | cloud-init meta-data document (see below). |
  | `userdata` | string | for `cloudinit`/`guestinfo` | cloud-init user-data document. |
  | `serverId` | string | yes in practice | The panel's server UUID; written into the annotation and `lightning.server-id`. |
  | `customization` | string | no | `"cloudinit"` (also the default for any other value, including `""`), `"guestinfo"` or `"appliance"`. |
  | `cpuHotAdd`, `memoryHotAdd` | bool | no | Hardware hot-add flags, always written (false when absent). |
  | `nestedHv` | bool | no | Expose hardware virtualization to the guest. |
  | `vappProperties` | map[string]string | for `appliance` | OVF/vApp property id to value. |

  Missing `name` prefix, `template`, `pool`, `datastore` or `network` gives
  `400 INVALID_REQUEST` ("name, template, pool, datastore and network are required"). This check runs before
  connecting.
- Response, one of:
  - `{"vm": "<vm id>", "existed": true}`: a VM with this name already exists; nothing was started.
  - `{"task": "<task id>", "existed": false}`: the clone task was started. When it succeeds, `/v1/task` returns
    the new VM's id in `vm`.

  Either answer may carry `warnings`: an array of codes for what the platform will not do although the clone goes
  through. Today only the Proxmox VE adapter sends one, `EXTRA_ADDRESSES_NOT_CONFIGURED` (the first interface was
  given more than one IPv4 or IPv6 address; `ipconfig0` carries one of each). The worker keeps the codes on the
  operation (`operations.params.warnings`, shown in the admin's operations list) and logs them.
- Behaviour:
  1. Not vCenter: `400 PROVISIONING_NOT_SUPPORTED` ("cloning needs vCenter").
  2. Exact-name lookup over the whole inventory (idempotency).
  3. Template must exist and be in a folder, else `TEMPLATE_NOT_FOUND`. The clone is created in the template's
     folder.
  4. The template's first NIC is re-attached to `network` (`NETWORK_NOT_FOUND` when the id cannot be resolved;
     `TEMPLATE_HAS_NO_NIC` when the template has no NIC). Further NICs of the template are left as they are.
  5. First disk grown to `diskGb` if larger.
  6. The clone is created **powered off** (`PowerOn: false`), with CPU count, memory, hot-add flags, nested HV,
     the annotation and `lightning.server-id`. The worker powers it on afterwards.
- How guest data is passed, by `customization`:
  - **`cloudinit`** (default; needs vCenter 7.0 U3+): a vCenter customization spec with
    `CustomizationCloudinitPrep{Metadata: metadata, Userdata: userdata}`; both strings are handed to vCenter
    as they are (plain text) and delivered to cloud-init in the guest by VMware Tools.
  - **`guestinfo`**: no customization spec. The same two strings are base64-encoded (standard encoding) and
    written as extra config: `guestinfo.metadata`, `guestinfo.metadata.encoding` = `base64`,
    `guestinfo.userdata`, `guestinfo.userdata.encoding` = `base64`. cloud-init's VMware datasource (cloud-init
    21.3+ in the template) reads them.
  - **`appliance`**: no cloud-init at all. For each vApp property the template defines whose id is a key of
    `vappProperties`, the property's value is set. In addition every key of `vappProperties` that starts with
    `guestinfo.` is written as extra config (sorted by key). Used for nested ESXi.
- What the worker puts in `metadata` and `userdata` (`cloudInit` in `apps/worker/operations.mjs`); both are
  JSON, which is valid YAML:
  - `metadata`: `{"instance-id": <server id>, "local-hostname": <name>, "network": {"version": 2, "ethernets":
    {"nic0": {"match": {"name": "e*"}, "addresses": ["<ip>/<prefix>", ...], "routes": [{"to":"default","via":
    <gateway>}, {"to":"::/0","via":<v6 gateway>,"on-link":true}?], "nameservers": {"addresses": [...]}}}}}`.
    The network configuration is **inside the metadata** (the VMware datasource's convention), not a separate
    network-config document.
  - `userdata`: the line `#cloud-config` followed by one JSON object with `hostname`, `ssh_authorized_keys`,
    `ssh_pwauth: false`, optionally `chpasswd` (`{expire:false, list:"root:<sha512 crypt hash>"}`),
    `write_files` and `runcmd`.
  - For image family `esxi` the worker sends `customization: "appliance"`, `nestedHv: true` and
    `vappProperties` with the keys `guestinfo.hostname`, `guestinfo.ipaddress`, `guestinfo.netmask`,
    `guestinfo.gateway`, `guestinfo.dns`, `guestinfo.domain`, `guestinfo.ntp`, `guestinfo.ssh`,
    `guestinfo.createvmfs`, `guestinfo.password`, and no `metadata`/`userdata`.
- Errors: `INVALID_REQUEST`, `PROVISIONING_NOT_SUPPORTED`, `TEMPLATE_NOT_FOUND`, `NETWORK_NOT_FOUND`,
  `TEMPLATE_HAS_NO_NIC`, `DISK_SMALLER_THAN_TEMPLATE`, common errors. Task errors: `DUPLICATE_NAME` (a parallel
  clone won; the worker then finds the VM by name), `INSUFFICIENT_RESOURCES`, `WRITE_RESTRICTED`,
  `PERMISSION_DENIED`, `TASK_FAILED`.

### 6.7 POST /v1/vm/find

- Synchronous, 30 s.
- Request: Target plus `name` (string, required): the exact VM name.
- Response: `{"vm": VMState}` or `{"vm": null}` when no VM has that name (not an error).

  ```go
  type VMState struct {
      MoRef        string   `json:"moref"`
      Name         string   `json:"name"`
      PowerState   string   `json:"powerState"`
      ToolsRunning bool     `json:"toolsRunning"`
      IPs          []string `json:"ips"`
      ServerID     string   `json:"serverId,omitempty"`
  }
  ```

  | JSON | Meaning |
  | --- | --- |
  | `moref` | The VM's id (used as `vm` in every other route). |
  | `name` | The VM's name. |
  | `powerState` | `"poweredOn"`, `"poweredOff"` or `"suspended"`. |
  | `toolsRunning` | The guest agent (VMware Tools) is running. |
  | `ips` | Every address the guest reports on any NIC (IPv4 and IPv6, no prefix length). Always an array. |
  | `serverId` | Value of the `lightning.server-id` marker; omitted when the VM has none. |

- Templates are VMs too: the worker finds a personal image's template with this route.
- If several VMs share the name, the first one found is returned.
- Errors: common errors.

### 6.8 POST /v1/vms/managed

- Synchronous, 60 s.
- Request: Target only.
- Response: `{"vms": [VMState, ...]}`: every VM (templates included) whose name starts with `lvm-`. Always an
  array.
- Errors: common errors.

### 6.9 POST /v1/vm/power

- Task route, 60 s.
- Request: Target plus

  | JSON | Go type | Required | Meaning |
  | --- | --- | --- | --- |
  | `vm` | string | yes | VM id. |
  | `action` | string | yes | `"on"`, `"off"` (hard power off), `"reset"` (hard reset), `"shutdown"` (clean guest shutdown). |

- Response: `{"task": "<task id>"}` for `on`, `off`, `reset`. For `shutdown`: `{"task": ""}`; the guest
  shutdown has no task, and the caller watches `/v1/vm/find` until the VM is `poweredOff`.
- Errors: `INVALID_REQUEST` (unknown action), `TOOLS_NOT_RUNNING` (409; `shutdown` without a running guest
  agent), common errors. A VM that is already in the wanted state fails the *task* with `INVALID_STATE`; the
  worker treats `INVALID_STATE` as success when `/v1/vm/find` then shows the wanted power state.
- No managed-name check.

### 6.10 POST /v1/vm/destroy

- Task route, 120 s.
- Request: Target plus `vm` (string, required).
- Response:
  - `{"task": "", "gone": true}` when the VM does not exist any more.
  - `{"task": "<task id>"}` otherwise: the delete task (removes the VM and its disks).
- Behaviour: `NOT_MANAGED` (409) unless the VM's name starts with `lvm-`. A powered-on VM is powered off first
  and the adapter waits for that inside the request (an "already off" fault is ignored).
- Errors: `NOT_MANAGED`, common errors; task errors as in section 4.

### 6.11 POST /v1/vm/resize

- Task route, 60 s.
- Request: Target plus

  ```go
  type ResizeRequest struct {
      Request
      VM       string `json:"vm"`
      VCPU     int32  `json:"vcpu"`
      MemoryMB int64  `json:"memoryMb"`
      DiskGB   int64  `json:"diskGb"`
  }
  ```

  All three sizes are required: `vcpu >= 1`, `memoryMb >= 256`, `diskGb >= 1`, else `INVALID_REQUEST`. They are
  the new absolute values, not deltas. `diskGb` is the first disk's size.
- Response: `{"task": "<task id>"}` (one reconfigure task for CPU, memory and, if larger, the disk).
- Behaviour: `NOT_MANAGED` unless `lvm-`. Disk smaller than now: `DISK_SHRINK_NOT_SUPPORTED` (409). Disk larger
  while the VM has any snapshot: `DISK_HAS_SNAPSHOTS` (409). Disk equal: only CPU and memory change. The adapter
  does not check the power state; the worker stops the VM first and starts it again afterwards. Growing the
  partition and file system is left to cloud-init in the guest on the next boot.
- Errors: `INVALID_REQUEST`, `NOT_MANAGED`, `DISK_SHRINK_NOT_SUPPORTED`, `DISK_HAS_SNAPSHOTS`, common errors.

### 6.12 POST /v1/vm/rename

- Synchronous (waits for the rename), 60 s. Used to take over an existing VM.
- Request: Target plus

  ```go
  type RenameRequest struct {
      Request
      VM   string `json:"vm"`
      Name string `json:"name"`
  }
  ```

  `name` must start with `lvm-` and be at most 80 characters, else `INVALID_REQUEST`.
- Response: `{"name": "<name>", "diskGb": <int>}` where `diskGb` is the first disk's size in whole GiB, rounded
  up (0 when the VM has no disk).
- Behaviour: already has this name: success (a retry). Already managed (`lvm-` prefix) or a template:
  `NOT_IMPORTABLE` (409).
- Errors: `INVALID_REQUEST`, `NOT_IMPORTABLE`, common errors. A failed rename task goes through `classify`, which maps a task the
  adapter waited for with the same task-fault table as `/v1/task`.

### 6.13 POST /v1/vm/details

- Synchronous, read-only, 30 s.
- Request: Target plus `vm` (string, required; empty gives `INVALID_REQUEST`).
- Response:

  ```go
  type VMDetails struct {
      MoRef               string          `json:"moref"`
      Name                string          `json:"name"`
      InstanceUUID        string          `json:"instanceUuid"`
      BiosUUID            string          `json:"biosUuid"`
      GuestID             string          `json:"guestId"`
      ConfiguredOS        string          `json:"configuredOs"`
      HardwareVersion     string          `json:"hardwareVersion"`
      Firmware            string          `json:"firmware"` // bios or efi
      SecureBoot          bool            `json:"secureBoot"`
      Annotation          string          `json:"annotation"`
      PowerState          string          `json:"powerState"`
      ConnectionState     string          `json:"connectionState"`
      BootTime            *time.Time      `json:"bootTime"`
      UptimeSeconds       int32           `json:"uptimeSeconds"`
      OverallStatus       string          `json:"overallStatus"`
      ConsolidationNeeded bool            `json:"consolidationNeeded"`
      Snapshots           int             `json:"snapshots"`
      CommittedGB         float64         `json:"committedGb"`
      UncommittedGB       float64         `json:"uncommittedGb"`
      CPU                 DetailCPU       `json:"cpu"`
      Memory              DetailMemory    `json:"memory"`
      NICs                []DetailNIC     `json:"nics"`
      Disks               []DetailDisk    `json:"disks"`
      Cdroms              []DetailCdrom   `json:"cdroms"`
      Tools               DetailTools     `json:"tools"`
      Guest               DetailGuest     `json:"guest"`
      Placement           DetailPlacement `json:"placement"`
  }
  type DetailCPU struct {
      Count          int32 `json:"count"`
      CoresPerSocket int32 `json:"coresPerSocket"`
      HotAdd         bool  `json:"hotAdd"`
      ReservationMhz int64 `json:"reservationMhz"`
      LimitMhz       int64 `json:"limitMhz"` // -1: none
      Shares         int32 `json:"shares"`
      UsageMhz       int32 `json:"usageMhz"`
  }
  type DetailMemory struct {
      SizeMB        int32 `json:"sizeMb"`
      HotAdd        bool  `json:"hotAdd"`
      ReservationMB int64 `json:"reservationMb"`
      LimitMB       int64 `json:"limitMb"` // -1: none
      Shares        int32 `json:"shares"`
      GuestUsageMB  int32 `json:"guestUsageMb"`
      HostUsageMB   int32 `json:"hostUsageMb"`
      BalloonedMB   int32 `json:"balloonedMb"`
      SwappedMB     int32 `json:"swappedMb"`
  }
  type DetailNIC struct {
      Label          string   `json:"label"`
      Adapter        string   `json:"adapter"` // vmxnet3, e1000e, e1000...
      MAC            string   `json:"mac"`
      MACType        string   `json:"macType"` // assigned, manual, generated
      Connected      bool     `json:"connected"`
      StartConnected bool     `json:"startConnected"`
      Network        string   `json:"network"`        // port group name
      Kind           string   `json:"kind"`           // standard or distributed
      PortKey        string   `json:"portKey"`        // distributed port the NIC holds
      PortgroupKey   string   `json:"portgroupKey"`   // distributed port group key
      Switch         string   `json:"switch"`         // vSwitch name or distributed switch UUID
      VLAN           *int32   `json:"vlan"`           // nil when unknown or trunk
      IPs            []string `json:"ips"`            // addresses the guest reports on this MAC, with prefix
      GuestConnected *bool    `json:"guestConnected"` // the guest's own link state
  }
  type DetailDisk struct {
      Label        string  `json:"label"`
      CapacityGB   float64 `json:"capacityGb"`
      Datastore    string  `json:"datastore"`
      File         string  `json:"file"`
      Provisioning string  `json:"provisioning"` // thin, thick-lazy, thick-eager
      Mode         string  `json:"mode"`         // persistent, independent_persistent...
      Controller   string  `json:"controller"`   // e.g. "SCSI 0:1"
      Bus          string  `json:"bus"`          // pvscsi, lsilogic, lsilogic-sas, buslogic, sata, nvme, ide
  }
  type DetailCdrom struct {
      Label     string `json:"label"`
      ISO       string `json:"iso"`
      Connected bool   `json:"connected"`
  }
  type DetailTools struct {
      Status        string `json:"status"`        // toolsOk, toolsOld, toolsNotRunning, toolsNotInstalled
      RunningStatus string `json:"runningStatus"` // guestToolsRunning...
      Version       string `json:"version"`
      VersionStatus string `json:"versionStatus"` // guestToolsCurrent, guestToolsNeedUpgrade...
  }
  type DetailGuest struct {
      HostName  string   `json:"hostName"`
      OS        string   `json:"os"`
      Family    string   `json:"family"`
      IPs       []string `json:"ips"`
      Gateways  []string `json:"gateways"`
      DNS       []string `json:"dns"`
      Domain    string   `json:"domain"`
      State     string   `json:"state"`
      Heartbeat string   `json:"heartbeat"` // green, yellow, red, gray
  }
  type DetailPlacement struct {
      Host         string   `json:"host"`
      Cluster      string   `json:"cluster"`
      ResourcePool string   `json:"resourcePool"`
      Folder       string   `json:"folder"`
      Datastores   []string `json:"datastores"`
      VMXPath      string   `json:"vmxPath"`
  }
  ```

  Details worth knowing:
  - `bootTime` is RFC 3339 or `null`. `committedGb`, `uncommittedGb`, `capacityGb` are GiB rounded to two
    decimals.
  - `nics`, `disks`, `cdroms`, `guest.ips`, `guest.gateways`, `guest.dns`, `placement.datastores` and each
    `nics[].ips` are always arrays, never `null`.
  - `nics[].kind` is `"standard"`, `"distributed"` or `"opaque"` (for an opaque network `network` holds its id);
    it is `""` for other backings. `nics[].ips` entries carry the prefix length (`10.0.0.5/24`) when the guest
    reports it; `guest.ips` are the same addresses without prefix, de-duplicated.
  - `nics[].guestConnected` is `null` when the guest reports nothing for that MAC.
  - `disks[].file` is a datastore path `[datastore1] dir/file.vmdk`; `disks[].datastore` is the name inside the
    brackets. `cdroms[].iso` is also a datastore path (the API strips `[...]` and the folder for customers).
  - `placement.*` are names, not ids. `placement.cluster` is `""` on a standalone host.
    `placement.datastores` is sorted.
  - `snapshots` is the total count in the snapshot tree.
  - `guest.gateways` are the gateways of default routes (prefix length 0) the guest reports.
- Errors: `INVALID_REQUEST`, `VM_NOT_FOUND` ("the VM no longer exists"), common errors.
- No managed-name check. Nothing is changed.

### 6.14 POST /v1/vm/metrics

- Synchronous, read-only, 30 s.
- Request: Target plus `vm` (string, required).
- Response:

  ```go
  type Sample struct {
      T    time.Time `json:"t"`
      CPU  *float64  `json:"cpu"`  // percent of the VM's vCPUs
      Mem  *float64  `json:"mem"`  // percent of configured memory actively used
      Net  *float64  `json:"net"`  // KB/s, all NICs
      Disk *float64  `json:"disk"` // KB/s, all disks
  }
  type Metrics struct {
      Interval int32              `json:"interval"`
      Samples  []Sample           `json:"samples"`
      Quick    map[string]float64 `json:"quick"`
  }
  ```

  | JSON | Meaning |
  | --- | --- |
  | `interval` | Seconds between samples; always `20`. |
  | `samples` | Up to 45 samples (about the last 15 minutes), oldest first, `t` in RFC 3339. Each metric is a number or `null` when that counter has no value for the sample. `cpu` and `mem` are percent (0..100), `net` and `disk` are KB/s summed over all NICs / disks. Empty array for a VM that is not powered on. |
  | `quick` | Exactly three keys: `cpuMhz` (current CPU use in MHz), `memoryActiveMb` (guest active memory in MiB), `uptimeSeconds`. |

- Errors: common errors (a performance query that fails is an error here, unlike `/v1/topology` and
  `/v1/power`).

### 6.15 POST /v1/vm/snapshots

- Synchronous, read-only, 30 s.
- Request: Target plus `vm` (string, required). (Decoded into `SnapshotRequest`; other fields ignored.)
- Response: `{"snapshots": [Snapshot, ...]}`, always an array; the tree is flattened depth-first, parents before
  their children.

  ```go
  type Snapshot struct {
      ID          string    `json:"id"`
      Name        string    `json:"name"`
      Description string    `json:"description"`
      Created     time.Time `json:"created"`
      PowerState  string    `json:"powerState"`
      Current     bool      `json:"current"`
      Parent      string    `json:"parent"`
  }
  ```

  | JSON | Meaning |
  | --- | --- |
  | `id` | Snapshot id (vSphere: `snapshot-<n>`). Passed back as `snapshot` to `/v1/vm/snapshot`. |
  | `name`, `description` | As given at creation. Names need not be unique. |
  | `created` | RFC 3339. |
  | `powerState` | The VM's power state when the snapshot was taken (`poweredOn`, `poweredOff`, `suspended`). |
  | `current` | True for the snapshot the VM currently sits on. |
  | `parent` | Id of the parent snapshot, `""` for a root. |

- Errors: common errors.

### 6.16 POST /v1/vm/snapshot

- Task route, 60 s.
- Request: Target plus

  ```go
  type SnapshotRequest struct {
      Request
      VM          string `json:"vm"`
      Snapshot    string `json:"snapshot"`
      Name        string `json:"name"`
      Description string `json:"description"`
      Action      string `json:"action"`
  }
  ```

  | JSON | Required | Meaning |
  | --- | --- | --- |
  | `vm` | yes | VM id. |
  | `action` | yes | `"create"`, `"revert"` or `"remove"`. |
  | `name` | for `create` | 1 to 80 bytes. |
  | `description` | no | At most 500 bytes (`create`). |
  | `snapshot` | for `revert`/`remove` | Snapshot id from `/v1/vm/snapshots`; must belong to this VM. |

- Response: `{"task": "<task id>"}`.
- Behaviour:
  - `create`: snapshot **without memory and without quiescing** (works without a guest agent; crash-consistent).
  - `revert`: reverts to the snapshot with power-on suppressed. Because snapshots carry no memory the VM is
    powered off afterwards; the worker powers it on again if it was running.
  - `remove`: removes that one snapshot (children are kept) and consolidates the disks.
- Errors: `INVALID_REQUEST` (name/description length, unknown action), `SNAPSHOT_NOT_FOUND` (404; the id is not
  in this VM's tree; permanent for the worker), common errors.
- No managed-name check.

### 6.17 POST /v1/vm/disks

- Synchronous, read-only, 30 s.
- Request: Target plus `vm` (decoded into `DiskRequest`).

  ```go
  type DiskRequest struct {
      Request
      VM     string `json:"vm"`
      SizeGB int64  `json:"sizeGb"`
      Key    int32  `json:"key"` // the disk to remove (its device key)
  }
  ```

- Response: `{"disks": [DiskInfo, ...]}`, always an array, in device order.

  ```go
  type DiskInfo struct {
      Key    int32  `json:"key"`
      Label  string `json:"label"`
      SizeGB int64  `json:"sizeGb"`
      System bool   `json:"system"`
  }
  ```

  `key` is the disk's stable device key (integer). `sizeGb` is whole GiB rounded down. `system` is true for the
  first disk only.
- Errors: `NOT_MANAGED`, common errors.

### 6.18 POST /v1/vm/disk-add

- Task route, 60 s.
- Request: Target plus `vm` and `sizeGb` (int64, 1 to 65536, else `INVALID_REQUEST`).
- Response: `{"task": "<task id>"}`. The response does not name the new disk; the worker lists the disks before
  and after and takes the new `key`.
- Behaviour: a new **thin** disk on the first controller with a free slot, on the system disk's datastore, in
  the VM's folder, with its own file name (`<system disk>_extra<random>.vmdk`). Works while the VM runs.
  **Not idempotent**: calling it twice adds two disks. The stored task id alone does not prevent that (some
  adapters answer only after the disk exists and without a task id, so a crash can leave a disk the worker never
  recorded). The worker therefore lists the VM's disks before calling: a retry that cannot tell whether its earlier
  call went through first **adopts** a disk of the asked size that is not the system disk and that no `server_disks`
  row holds, and only calls `/v1/vm/disk-add` when there is none. An adapter must list a new disk in `/v1/vm/disks`
  with a stable `key` and its exact `sizeGb`.
- Errors: `INVALID_REQUEST`, `NOT_MANAGED`, `VM_HAS_NO_DISK` (409), `NO_DISK_CONTROLLER` (409), common errors.

### 6.19 POST /v1/vm/disk-remove

- Task route, 60 s.
- Request: Target plus `vm` and `key` (int32, the disk's `key` from `/v1/vm/disks`).
- Response: `{"task": "<task id>"}`; or `{"task": "", "gone": true}` when the VM has no disk with that key.
- Behaviour: detaches the disk and deletes its file. The first disk is refused with `SYSTEM_DISK` (409).
- Errors: `NOT_MANAGED`, `SYSTEM_DISK`, common errors.

### 6.20 POST /v1/vm/disk-copy

- Task route, 60 s. The copy itself can run for a long time; it is polled with `/v1/task`.
- Request: Target plus

  ```go
  type DiskCopyRequest struct {
      Request
      VM        string `json:"vm"`
      Datastore string `json:"datastore"` // the backup datastore
      Name      string `json:"name"`      // <server id>/<backup id>.vmdk under the backup folder
      Direction string `json:"direction"` // "backup" (VM disk -> backup) or "restore" (backup -> VM disk)
  }
  ```

  `name` must match `^[0-9a-f-]{36}/[0-9a-f-]{36}\.vmdk$` and `direction` must be `backup` or `restore`, else
  `INVALID_REQUEST`.
- Response: `{"task": "<task id>"}`.
- Behaviour:
  - `backup`: requires that the VM has at least one snapshot (`INVALID_STATE` otherwise: the caller takes the
    snapshot first so the base disk does not change). Creates the folder
    `lightning-backups/<server id>` on the backup datastore and copies the **base file of the first disk**
    (below all snapshot deltas) to `lightning-backups/<name>` as a thin disk, overwriting an existing file.
  - `restore`: requires the VM powered off (`INVALID_STATE`) and without snapshots (`DISK_HAS_SNAPSHOTS`).
    Copies the backup over the first disk's base file (overwrite).
  - Only the first (system) disk is backed up; extra disks are not.
- Errors: `INVALID_REQUEST`, `DATASTORE_NOT_FOUND` (404), `NOT_MANAGED`, `VM_HAS_NO_DISK`, `DISK_NOT_SUPPORTED`
  (409; the disk is not a flat VMDK), `INVALID_STATE`, `DISK_HAS_SNAPSHOTS`, common errors.

### 6.21 POST /v1/backup/delete

- Synchronous (waits for the delete), 120 s.
- Request: Target plus `datastore` and `name` (same struct and same name pattern as disk-copy; `vm` and
  `direction` are not used).
- Response: `{}`. A file that is already gone is success.
- Errors: `INVALID_REQUEST`, `DATASTORE_NOT_FOUND`, common errors.

### 6.22 POST /v1/image/create

- Task route, 60 s.
- Request: Target plus

  ```go
  type ImageRequest struct {
      Request
      VM        string `json:"vm"`
      Name      string `json:"name"`
      Datastore string `json:"datastore"`
  }
  ```

  | JSON | Required | Meaning |
  | --- | --- | --- |
  | `vm` | yes | The server's VM to copy. |
  | `name` | yes | Must start with `lvm-img-`, else `INVALID_REQUEST`. |
  | `datastore` | no | Target datastore; empty keeps the source's. (The worker does not send it.) |

- Response:
  - `{"task": "", "template": "<vm id>"}` when a VM with this name already exists (a retry).
  - `{"task": "<task id>"}`: the clone-to-template task. On success `/v1/task` returns the template's id in `vm`.
- Behaviour: the source must be a server of the panel (`lvm-` but not `lvm-img-`), else `NOT_MANAGED`. The
  source keeps running; the result is a template (not powered on) in the source's folder.
- Errors: `INVALID_REQUEST`, `NOT_MANAGED`, `INVALID_STATE` (the VM is not in a folder), common errors.

### 6.23 POST /v1/image/delete

- Synchronous (waits for the delete), 120 s.
- Request: Target plus `name` (the template's name; looked up by exact name). `vm` and `datastore` are not used.
- Response: `{}`. No VM with that name: success.
- Behaviour: only a name starting with `lvm-img-` is deleted, otherwise `NOT_MANAGED`.
- Errors: `NOT_MANAGED`, common errors.

### 6.24 POST /v1/network/create

- Synchronous (waits for the task), 90 s.
- Request: Target plus (all five network/NIC routes decode the same struct)

  ```go
  type PortgroupRequest struct {
      Request
      Reference string `json:"reference"` // a distributed port group on the switch to use (create)
      Portgroup string `json:"portgroup"` // the network's port group (delete, NICs)
      Name      string `json:"name"`      // "lvm-net-<network id>"
      VLAN      int32  `json:"vlan"`
      VM        string `json:"vm"`
  }
  ```

  | JSON | Required | Meaning |
  | --- | --- | --- |
  | `reference` | yes | Id of an existing distributed port group; the new network is created on the same switch. |
  | `name` | yes | Must start with `lvm-net-`. |
  | `vlan` | yes | 1 to 4094. |

  A wrong name prefix or VLAN gives `INVALID_REQUEST`.
- Response: `{"portgroup": "<port group id>"}`.
- Behaviour: a port group with this name already exists (anywhere): its id is returned unchanged (a retry; the
  VLAN is not compared). Otherwise a new port group: static (early) binding, 32 ports, auto-expand, tagged with
  the VLAN id.
- Errors: `INVALID_REQUEST`, `NETWORK_NOT_FOUND` (the reference is not a distributed port group), `VM_NOT_FOUND`
  (the reference id does not exist; see the note in 3.3), common errors.

### 6.25 POST /v1/network/delete

- Synchronous (waits for the task), 90 s.
- Request: Target plus `portgroup` (id returned by create).
- Response: `{}`. A port group that no longer exists is success.
- Behaviour: only a port group named `lvm-net-...` is deleted, else `NOT_MANAGED`.
- Errors: `NOT_MANAGED`, common errors (for example a port group that still has NICs attached fails with
  `VMWARE_ERROR`).

### 6.26 POST /v1/vm/nic-add

- Task route, 90 s.
- Request: Target plus `vm` and `portgroup`.
- Response: `{"task": "<task id>"}`; `{"task": ""}` when the VM already has a NIC on that port group.
- Behaviour: adds one `vmxnet3` NIC attached to the port group (hot-add while running). MAC is assigned by the
  platform.
- Errors: `NOT_MANAGED`, `NETWORK_NOT_FOUND`, common errors.

### 6.27 POST /v1/vm/nic-remove

- Task route, 90 s.
- Request: Target plus `vm` and `portgroup`.
- Response: `{"task": "<task id>"}`; `{"task": ""}` when the VM has no NIC on that port group.
- Errors: `NOT_MANAGED`, common errors.

### 6.28 POST /v1/vm/nic-mac

- Synchronous, read-only, 90 s.
- Request: Target plus `vm` and `portgroup`.
- Response: `{"mac": "<MAC address>"}`; `{"mac": ""}` when the VM has no NIC on that port group.
- Errors: `NOT_MANAGED`, common errors.

In the three NIC routes the NIC is found by comparing its distributed port group key with `portgroup`; for
vSphere the port group key equals the port group's id.

### 6.29 POST /v1/vm/migrate

- Task route, 60 s.
- Request: Target plus

  ```go
  type MigrateRequest struct {
      Request
      VM        string `json:"vm"`
      Host      string `json:"host"`
      Datastore string `json:"datastore"`
  }
  ```

  At least one of `host` (host id) and `datastore` (datastore id) must be non-empty, else `INVALID_REQUEST`.
  The worker always sends both keys, empty string for "unchanged".
- Response: `{"task": "<task id>"}`; or `{"task": "", "already": true}` when only a host was asked for and the
  VM already runs there.
- Behaviour: live migration of a running VM, or a cold move of a stopped one; compute, storage or both. The VM
  keeps its resource pool. `NOT_MANAGED` unless `lvm-`.
- Errors: `INVALID_REQUEST`, `NOT_MANAGED`, common errors; task errors as in section 4.

### 6.30 POST /v1/vm/firewall

- Synchronous (waits for every port reconfiguration), 90 s.
- Request: Target plus

  ```go
  type FirewallRule struct {
      Direction string   `json:"direction"` // "in" or "out", from the VM's point of view
      Protocol  string   `json:"protocol"`  // tcp, udp, icmp, esp, gre
      Port      string   `json:"port"`      // tcp/udp only: "443" or "8000-8100"
      IPs       []string `json:"ips"`       // CIDRs: sources for "in", destinations for "out"
  }
  type FirewallRequest struct {
      Request
      VM      string         `json:"vm"`
      Enabled bool           `json:"enabled"` // false removes the filter (no firewall attached any more)
      Rules   []FirewallRule `json:"rules"`
  }
  ```

  | JSON | Meaning |
  | --- | --- |
  | `vm` | VM id. |
  | `enabled` | `false`: remove the firewall from the VM entirely (`rules` ignored). `true`: replace the firewall with exactly `rules`. |
  | `rules[].direction` | `"in"` or `"out"`. A rule with any other value is silently skipped. |
  | `rules[].protocol` | `tcp`, `udp`, `icmp`, `esp`, `gre`; anything else gives `INVALID_REQUEST`. |
  | `rules[].port` | `""` (any port), `"443"` or `"8000-8100"` (1..65535, low <= high). The destination port. The worker sends `""` for protocols without ports. |
  | `rules[].ips` | At least one CIDR (IPv4 or IPv6). Sources for `in`, destinations for `out`. A `/0` prefix of either family means "any address". |

  The rules are all "allow" rules; there are no deny rules in the request.
- Response: `{"ports": <int>, "rules": <int>}`: number of the VM's switch ports that were written and number of
  generated low-level rules (0 when disabled).
- Semantics (what the VMware adapter enforces; a second adapter must give the guest the same behaviour):
  - `enabled: true` always restricts **inbound**: only what the `in` rules allow reaches the VM, plus the
    automatic rules below; everything else inbound is dropped. With zero `in` rules all new inbound connections
    are dropped.
  - **Outbound** is restricted only if at least one `out` rule exists; then only the `out` rules, the replies
    of allowed inbound services and IPv6 neighbour discovery leave the VM. Without any `out` rule all outbound
    traffic is allowed.
  - The vSphere filter is stateless, so the adapter adds: inbound TCP and UDP to destination ports 32768-65535
    from anywhere ("replies to outgoing connections"), inbound ICMPv6 (neighbour discovery), and, when outbound
    is restricted, outbound traffic of each inbound rule's protocol from that rule's port ("replies of rule N")
    plus outbound ICMPv6. A stateful firewall needs none of these.
  - It applies to every NIC of the VM (including a private-network NIC).
  - The call is a full replace and can be repeated freely. `enabled: false` on a VM without a firewall is a
    no-op.
- How it is applied in VMware: a traffic-filter ruleset (agent `dvfilter-generic-vmware`) on each distributed
  switch port the VM's NICs hold, edited in place if one exists. If the port group does not allow per-port
  filter overrides the adapter turns that on first (reconfigures the port group). At most 500 generated rules.
- Errors: `INVALID_REQUEST` (protocol, port, CIDR, a rule without networks), `FIREWALL_TOO_MANY_RULES`,
  `FIREWALL_NEEDS_DVS` (a NIC is not on a distributed switch), `FIREWALL_NO_PORT` (a NIC has no port assigned,
  or the port was not found), `FIREWALL_APPLY_FAILED` (the port or port-group reconfiguration failed for a
  reason not in the task-fault table), the task-fault codes `WRITE_RESTRICTED`, `PERMISSION_DENIED`,
  `INSUFFICIENT_RESOURCES`, `DUPLICATE_NAME`, `INVALID_STATE` when the reconfiguration task fails with one of
  those faults, common errors. HTTP status of the `FIREWALL_*` codes: `FIREWALL_TOO_MANY_RULES` 400,
  `FIREWALL_NEEDS_DVS` and `FIREWALL_NO_PORT` 409, `FIREWALL_APPLY_FAILED` 502.
- No managed-name check.

### 6.31 POST /v1/vm/shaping

- Synchronous (waits for every port reconfiguration), 90 s.
- Request: Target plus

  ```go
  type ShapingRequest struct {
      Request
      VM   string `json:"vm"`
      Mbps int64  `json:"mbps"`
  }
  ```

  `mbps > 0`: limit every NIC of the VM to that many Mbit/s (1 Mbit = 1,000,000 bit) in both directions.
  `mbps <= 0`: remove the limit.
- Response: `{"ports": <int>, "mbps": <the requested value>}`.
- How it is applied in VMware: inbound and outbound traffic shaping on each distributed port: average = peak =
  `mbps * 1,000,000` bit/s, burst size = one second at the limit in bytes. Removing sets the port back to
  inheriting from its port group. Like the firewall, the port group's shaping override is switched on first if
  needed. The call is a full replace and idempotent.
- Errors: `FIREWALL_NEEDS_DVS`, `FIREWALL_NO_PORT` (same NIC requirements as the firewall), the task-fault codes
  including `TASK_FAILED`, common errors.

### 6.32 POST /v1/vm/cdrom

- Synchronous, 60 s.
- Request: Target plus

  ```go
  type CdromRequest struct {
      Request
      VM        string `json:"vm"`
      Datastore string `json:"datastore"` // empty: eject
      Name      string `json:"name"`
      Boot      bool   `json:"boot"` // boot from the CD first (install or rescue); ejecting restores the default order
  }
  ```

  | JSON | Meaning |
  | --- | --- |
  | `vm` | VM id. |
  | `datastore` | Datastore id holding the ISO. Empty or absent: eject. |
  | `name` | ISO file name inside `lightning-iso/`; must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.iso$` when `datastore` is set. |
  | `boot` | With an ISO: boot order becomes CD-ROM then disk. Otherwise (and always when ejecting) the boot order is reset to the platform default. |

- Response: `{}`.
- Behaviour: `NOT_MANAGED` unless `lvm-`. Inserts `[datastore] lightning-iso/<name>` into the VM's first
  CD-ROM drive, adding a drive on the IDE controller if the VM has none (`NO_CDROM_CONTROLLER` if that is
  impossible). Eject on a VM without a drive is a no-op. The boot order is written on every call. The ISO's
  existence is not checked. The VM is not restarted.
- Errors: `VM_NOT_FOUND`, `NOT_MANAGED`, `INVALID_REQUEST` (file name), `DATASTORE_NOT_FOUND`,
  `NO_CDROM_CONTROLLER`, common errors.

### 6.33 PUT /v1/iso/upload

- Synchronous and streaming; adapter timeout 12 hours. The only non-JSON request.
- Request:
  - Header `Authorization: Bearer <token>`.
  - Header `X-Upload`: standard base64 of a JSON document with the Target fields plus

    ```go
    type FileRequest struct {
        Request
        Datastore string `json:"datastore"` // datastore moref
        Name      string `json:"name"`      // file name inside the ISO folder
    }
    ```

  - Header `Content-Length`: required and greater than 0 (the exact file size; chunked uploads are refused).
  - Body: the raw file bytes (the worker sends `Content-Type: application/octet-stream`).
  - A missing or undecodable `X-Upload`, or no `Content-Length`:
    `400 INVALID_REQUEST` ("X-Upload header and Content-Length are required").
- Response: `{"path": "[<datastore name>] lightning-iso/<name>"}`.
- Behaviour: `name` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.iso$`. The folder `lightning-iso` is created
  on the datastore if missing, then the body is streamed straight to the datastore through vCenter's file URL
  (nothing is stored in the adapter). An existing file of the same name is overwritten.
- Errors: `INVALID_REQUEST`, `DATASTORE_NOT_FOUND`, common errors.

### 6.34 POST /v1/iso/delete

- Synchronous (waits for the delete), 120 s.
- Request: Target plus `datastore` and `name` (`FileRequest`; same name pattern).
- Response: `{}`. A file that is already gone is success.
- Errors: `INVALID_REQUEST` ("invalid file name"), `DATASTORE_NOT_FOUND`, common errors.

### 6.35 POST /v1/topology

- Synchronous, read-only, 60 s.
- Request: Target only.
- Response:

  ```go
  type Topology struct {
      Time       time.Time       `json:"time"`
      Compute    []TopoCompute   `json:"compute"`
      Hosts      []TopoHost      `json:"hosts"`
      Datastores []TopoDatastore `json:"datastores"`
      VMs        []TopoVM        `json:"vms"`
      OtherVMs   int             `json:"otherVms"` // VMs this platform did not create
  }
  type TopoCompute struct {
      MoRef string `json:"moref"`
      Name  string `json:"name"`
      Kind  string `json:"kind"` // cluster | host
  }
  type TopoHost struct {
      MoRef       string `json:"moref"`
      Name        string `json:"name"`
      Compute     string `json:"compute"`
      State       string `json:"state"` // connected, disconnected, notResponding
      Power       string `json:"power"`
      CPUUsedMhz  int64  `json:"cpuUsedMhz"`
      CPUTotalMhz int64  `json:"cpuTotalMhz"`
      MemUsedMb   int64  `json:"memUsedMb"`
      MemTotalMb  int64  `json:"memTotalMb"`
  }
  type TopoDatastore struct {
      MoRef      string   `json:"moref"`
      Name       string   `json:"name"`
      CapacityGb float64  `json:"capacityGb"`
      FreeGb     float64  `json:"freeGb"`
      Hosts      []string `json:"hosts"`
  }
  type TopoVM struct {
      MoRef      string   `json:"moref"`
      Name       string   `json:"name"`
      Host       string   `json:"host"`
      Power      string   `json:"power"`
      CPUUsedMhz int32    `json:"cpuUsedMhz"`
      MemUsedMb  int32    `json:"memUsedMb"`
      RxKBps     *float64 `json:"rxKBps"`
      TxKBps     *float64 `json:"txKBps"`
  }
  ```

  - `time`: adapter clock, UTC, RFC 3339. All four lists are always arrays.
  - `compute[].kind`: `"cluster"` or `"host"` (**Note**: discovery calls the same thing `"standalone"`).
  - `hosts[].compute`: id of the compute resource the host belongs to (equals a `compute[].moref`).
    `hosts[].power`: `poweredOn`, `poweredOff`, `standBy`, `unknown`. `cpuTotalMhz` = MHz per core x cores;
    `memTotalMb` in MiB; totals are 0 when hardware details are unavailable.
  - `datastores[].capacityGb`/`freeGb`: GiB, not rounded. `hosts`: ids of the hosts that mount it.
  - `vms`: only VMs named `lvm-...` (this includes `lvm-img-` templates). `host` is a host id; `power` is the
    power state string; `memUsedMb` is guest active memory. `rxKBps`/`txKBps` are the latest 20-second network
    rates in KB/s over all NICs, `null` when not running or when the counters are unavailable (not an error).
  - `otherVms`: count of VMs without the prefix, templates excluded.
- Errors: common errors.

### 6.36 POST /v1/power

- Synchronous, read-only, 60 s.
- Request: Target only.
- Response:

  ```go
  type PowerReport struct {
      Time  time.Time   `json:"time"`
      Hosts []PowerHost `json:"hosts"`
      VMs   []PowerVM   `json:"vms"`
  }
  type PowerHost struct {
      MoRef       string   `json:"moref"`
      Name        string   `json:"name"`
      Watts       *float64 `json:"watts"` // nil: the host does not report power
      CPUUsedMhz  int64    `json:"cpuUsedMhz"`
      CPUTotalMhz int64    `json:"cpuTotalMhz"`
      CoreMhz     int64    `json:"coreMhz"` // one core, for a VM's CPU percentage
      Connected   bool     `json:"connected"`
  }
  type PowerVM struct {
      Name       string `json:"name"`
      Host       string `json:"host"`
      CPUUsedMhz int32  `json:"cpuUsedMhz"`
      Traffic []TrafficSample `json:"traffic"`
  }
  type TrafficSample struct {
      T  time.Time `json:"t"`
      Rx float64   `json:"rx"` // net.received.average
      Tx float64   `json:"tx"` // net.transmitted.average
  }
  ```

  - `hosts`: every host. `watts` is the latest measured power draw in watts, `null` when the host has no power
    counter (the worker then estimates from CPU use). `coreMhz` is the speed of one core.
  - `vms`: only VMs that are **powered on** and whose name starts with `lvm-` (and is longer than the prefix).
    `host` is the host id (matched against `hosts[].moref`). There is no `moref` for the VM; the worker
    derives the server id from the name (`name.slice(4)`).
  - `vms[].traffic`: up to 45 samples of 20 seconds each (the last 15 minutes), oldest first; `rx`/`tx` in
    **KB/s** averaged over the sample, summed over all NICs. Always an array; empty when the counters are
    unavailable. The worker counts each sample once by its timestamp `t` and converts it with
    `rate * 1024 * 20` bytes, so the sample length of 20 seconds and stable, repeatable timestamps are part of
    the contract.
- Errors: common errors. Missing performance counters are never an error.

---

## 7. How the callers use it

Two callers exist. Both read the token file on every call and send `POST` with `content-type:
application/json` (except the ISO upload).

- API: `callAdapter<T>(path, body, timeoutMs)` in `apps/api/src/vmware.ts`. Non-2xx becomes an API error
  `422` with the adapter's `code`, `message` and, if present, `certificate`; an unreachable adapter becomes
  `503 VMWARE_SERVICE_UNAVAILABLE`.
- Worker: `adapter(path, body)` in `apps/worker/operations.mjs` (130 s timeout). Non-2xx becomes
  `OperationError(code ?? 'VMWARE_ERROR', message, permanent.has(code))`; unreachable becomes
  `VMWARE_SERVICE_UNAVAILABLE` (retried).

`apps/worker/abuse.mjs` does not call the adapter (it reads the CPU samples that `power.mjs` stored).
`/healthz` is called by no application code, only by the container health check.

| Route | Caller | What it sends | What it reads from the result |
| --- | --- | --- | --- |
| `/v1/discover` | `apps/api/src/vmware.ts` (`discover`, 70 s): test connection, create, update, refresh, set compat | Target (plus `apiVersion` when pinned) | Everything: `product` (whole object stored; `product.kind` becomes the connection's `kind`, `product.instanceUuid` its `instance_uuid`), `licenses`, `writeApi`, `privileges`, `operations`, `warnings`, `compat`, and the five inventory lists stored in tables (section 8). Returned to the UI: `product`, `writeApi`, `operations`, `warnings`, `compat` and the list lengths. On failure during refresh the `code` is stored in `vmware_connections.last_error_code`. |
| `/v1/scan` | `apps/api/src/vmware-scan.ts` (100 s), in chunks of addresses | `{addresses, port, timeoutMs: 1500}` | `hits[]` (`address`, `state`, `hostname`, `product`, `certificate` stored in `vmware_scan_hits`; `product.instanceUuid`, `product.kind`, `certificate.dnsNames` used to match known connections), `closed`, `silent`, `blocked` (counters) |
| `/v1/console-ticket` | `apps/api/src/console.ts` (30 s) | Target, `vm` (validated `^[\w-]{1,80}$`) | `url`, `sha1`, `sha256`, `certPem`, `vmName`; stored in Redis for the console gateway (`services/console`), which dials `url` and verifies the certificate. Only `vmName` reaches the browser. |
| `/v1/task` | `apps/worker/operations.mjs` (`waitTask`) | Target, `task` | `state`, `code`, `error`, `vm` (after a clone) |
| `/v1/vm/clone` | `apps/worker/operations.mjs` (`ensureVM`; kinds `create`, `reinstall`) | Target, `name: lvm-<server id>`, `serverId`, `template`, `pool`, `datastore`, `network`, `vcpu`, `memoryMb`, `diskGb`, `cpuHotAdd`, `memoryHotAdd`, `nestedHv`, and either `customization` + `metadata` + `userdata` or `customization: "appliance"` + `vappProperties` | `vm` (already exists) or `task` (stored, then polled; the new id comes from the task's `vm`, falling back to `/v1/vm/find`). `existed` is not read. |
| `/v1/vm/find` | `apps/worker/operations.mjs` (`find`, `waitReady`, `refreshPower`, `power`, `removeVM`, `image_create`) | Target, `name` | `vm` (null check), `vm.moref`, `vm.powerState`, `vm.toolsRunning`, `vm.ips`. A server is "ready" when `powerState === 'poweredOn' && toolsRunning && ips.includes(<primary address>)`. After delete, `vm` must be null. |
| `/v1/vms/managed` | `apps/worker/operations.mjs` (`reconcile`; connections that have a resource pool and whose kind is `vcenter`, `proxmox`, `xcpng`, `ovirt`, `hyperv`, `libvirt` or `incus`) | Target | `vms[].name`, `vms[].moref`, `vms[].powerState`. Compared with the `servers` table: missing VMs, power drift, orphan VMs (names not starting `lvm-img-` and not a known server). Failure sets the connection's status to `error`. |
| `/v1/vm/power` | `apps/worker/operations.mjs` (`power`; kinds `create`, `power_on`, `power_off`, `reset`, `shutdown`, `resize`, `backup_restore`, `snapshot_revert`) | Target, `vm`, `action` | `task` (polled if non-empty). `INVALID_STATE` is success if the VM is in the wanted state. |
| `/v1/vm/destroy` | `apps/worker/operations.mjs` (`removeVM`; kinds `delete`, `reinstall`, rollback of `create`) | Target, `vm` | `task` (polled if non-empty); then `/v1/vm/find` must return null |
| `/v1/vm/resize` | `apps/worker/operations.mjs` (kind `resize`) | Target, `vm`, `vcpu`, `memoryMb`, `diskGb` | `task` |
| `/v1/vm/rename` | `apps/api/src/import.ts` (60 s; take over an existing VM) | Target, `vm`, `name: lvm-<new server id>` | `diskGb` (stored as the server's disk size) |
| `/v1/vm/details` | `apps/api/src/servers.ts` (30 s, cached 20 s) | Target, `vm` | The whole object is passed to the UI. For customers the API blanks `placement`, `annotation`, `nics[].network`, `nics[].switch`, `nics[].portgroupKey`, `nics[].vlan`, `disks[].datastore`, `disks[].file` and shortens `cdroms[].iso` to the file name, so those keys must exist with those names. |
| `/v1/vm/metrics` | `apps/api/src/servers.ts` (30 s, cached 15 s) | Target, `vm` | `interval`, `samples[]` (`t`, `cpu`, `mem`, `net`, `disk`), `quick`; passed to the UI |
| `/v1/vm/snapshots` | `apps/api/src/snapshots.ts` (list; limit check before create), `apps/api/src/servers.ts` (refuse a disk-growing resize when any snapshot exists), `apps/api/src/schedules.ts` (rotation), `apps/worker/operations.mjs` (`snapshotNamed`) | Target, `vm` | `snapshots[]`: the whole list for the UI; `length`; `id`, `name` (prefix `auto `, exact name `lightning-backup <id>`), `created` (sorting) |
| `/v1/vm/snapshot` | `apps/worker/operations.mjs` (kinds `snapshot_create`, `snapshot_revert`, `snapshot_delete`, `backup_create`, cleanup after a failed backup) | Target, `vm`, `action`, and `name` + `description` or `snapshot` | `task` |
| `/v1/vm/disks` | `apps/worker/operations.mjs` (kind `disk_add`, before and after) | Target, `vm` | `disks[].key`, `disks[].system` |
| `/v1/vm/disk-add` | `apps/worker/operations.mjs` (kind `disk_add`) | Target, `vm`, `sizeGb` | `task` |
| `/v1/vm/disk-remove` | `apps/worker/operations.mjs` (kind `disk_remove`) | Target, `vm`, `key` | `task` |
| `/v1/vm/disk-copy` | `apps/worker/operations.mjs` (kinds `backup_create`, `backup_restore`) | Target, `vm`, `datastore`, `name` (the backup's `path`), `direction` | `task` |
| `/v1/backup/delete` | `apps/worker/operations.mjs` (kind `backup_delete`; all backups of a deleted server, errors ignored there) | Target, `datastore`, `name` | nothing |
| `/v1/image/create` | `apps/worker/operations.mjs` (kind `image_create`) | Target, `vm`, `name: lvm-img-<image id>` | `task`; afterwards `/v1/vm/find` by name gives the template id |
| `/v1/image/delete` | `apps/api/src/images.ts` (120 s) | Target, `name: lvm-img-<image id>` | nothing |
| `/v1/network/create` | `apps/api/src/privnet.ts` (90 s) | Target, `reference` (the location's private port group), `name: lvm-net-<network id>`, `vlan` | `portgroup` (stored in `private_networks.portgroup_moref`) |
| `/v1/network/delete` | `apps/api/src/privnet.ts` (90 s) | Target, `portgroup` | nothing |
| `/v1/vm/nic-add` | `apps/worker/operations.mjs` (kind `nic_add`) | Target, `vm`, `portgroup` | `task` |
| `/v1/vm/nic-mac` | `apps/worker/operations.mjs` (kind `nic_add`) | Target, `vm`, `portgroup` | `mac` (stored for the member; the customer configures the guest interface by MAC) |
| `/v1/vm/nic-remove` | `apps/worker/operations.mjs` (kind `nic_remove`) | Target, `vm`, `portgroup` | `task` |
| `/v1/vm/migrate` | `apps/worker/operations.mjs` (kind `migrate`) | Target, `vm`, `host`, `datastore` (empty string when unchanged) | `task` (empty: already there) |
| `/v1/vm/firewall` | `apps/worker/operations.mjs` (`writeFirewall`: firewall jobs and before first boot in `create`) | Target, `vm`, `enabled` (true when at least one firewall is attached), `rules` (the union of all attached firewalls: `direction`, `protocol`, `port` or `""`, `ips`) | nothing (success records the applied version; the failure `code` is stored in `servers.firewall_error`) |
| `/v1/vm/shaping` | `apps/worker/traffic.mjs` (`shape`) | Target, `vm`, `mbps` (the throttle speed, or 0 to lift it) | nothing |
| `/v1/vm/cdrom` | `apps/api/src/isos.ts` (60 s) | Target, `vm`, `boot`, and `datastore` + `name` when inserting | nothing |
| `/v1/iso/upload` | `apps/worker/iso.mjs` (`importIso`; raw `node:http` PUT, body piped from `rclone cat`) | `X-Upload` = base64 JSON of Target + `datastore` + `name`; `content-length` = file size | status 200 or the failure `code`/`message`; `path` is only logged |
| `/v1/iso/delete` | `apps/worker/iso.mjs` (`deleteIso`) | Target, `datastore`, `name` | nothing |
| `/v1/topology` | `apps/api/src/topology.ts` (60 s, cached 15 to 60 s) | Target | `time`, `compute[]`, `hosts[]`, `datastores[]`, `vms[]` (matched to servers by `name === 'lvm-' + server id`), `otherVms`; on failure only the `code` |
| `/v1/power` | `apps/worker/power.mjs` (`samplePower`, every `POWER_SAMPLE_MINUTES`), which hands `vms` to `apps/worker/traffic.mjs` (`countTraffic`) | Target | `hosts[]`: `connected`, `moref`, `name`, `watts`, `cpuUsedMhz`, `cpuTotalMhz`, `coreMhz`. `vms[]`: `name`, `host`, `cpuUsedMhz`, `traffic[]` (`t`, `rx`, `tx`) |

Caller-side facts a second adapter must respect:

- The worker chooses clone inputs from the stored inventory: `datastore` is the accessible datastore of the
  pool with the most `free_bytes`; `pool` is `vmware_compute.resource_pool` of the pool's compute resource;
  `network` is the pool's network id; `template` is the image's template id (or another server's VM id).
- `customization` sent to clone: the connection's setting, or with `auto` the discovered
  `compat.customization` (default `cloudinit`); `none` stops the operation with `PROVISIONING_NOT_SUPPORTED`.
- The API creates servers only on connections whose `operations.cloneFromImage` is true (and whose kind allows
  it), attaches firewalls only when `operations.firewall` is true, and opens consoles only when
  `operations.console` is true.
- Stored ids (`servers.vm_moref`, template, datastore, network, port group, host ids) are reused for the
  lifetime of the object, across adapter restarts and re-discoveries. They must be stable.

---

## 8. Discovery result in detail

`POST /v1/discover` returns:

```go
type Result struct {
    Product    Product           `json:"product"`
    Licenses   []License         `json:"licenses"`
    WriteAPI   string            `json:"writeApi"` // "available", "restricted" or "unknown"
    Privileges map[string]bool   `json:"privileges"`
    Operations map[string]bool   `json:"operations"`
    Warnings   []string          `json:"warnings"`
    Hosts      []Host            `json:"hosts"`
    Datastores []Datastore       `json:"datastores"`
    Networks   []Network         `json:"networks"`
    Compute    []ComputeResource `json:"compute"`
    VMs        []VM              `json:"vms"`
    Compat     Compat            `json:"compat"`
}
```

There is no separate "clusters" or "resource pools" list: clusters are entries of `compute` with
`kind: "cluster"`, and the only resource pool reported is each compute resource's root pool
(`compute[].resourcePool`).

**Note (null lists)**: in the VMware adapter `licenses`, `hosts`, `datastores`, `networks`, `compute` and
`vms` are Go slices that are never initialised, so an empty list is encoded as `null`, not `[]`. The API
tolerates `null` only for `licenses`; for the five inventory lists it calls `.length` / `.map` and
`json_to_recordset`, which fail on `null`. A second adapter must always send arrays. `warnings`,
`privileges` and `operations` are always present.

### 8.1 product

```go
type Product struct {
    Kind       string `json:"kind"` // "vcenter" or "esxi", from about.apiType
    Name       string `json:"name"`
    FullName   string `json:"fullName"`
    Version    string `json:"version"`
    Build      string `json:"build"`
    APIType    string `json:"apiType"`
    APIVersion string `json:"apiVersion"`
    InstanceID string `json:"instanceUuid"`
}
```

| JSON | Meaning | Use |
| --- | --- | --- |
| `kind` | `"vcenter"` when `apiType` is `VirtualCenter`, else `"esxi"`. | Stored as `vmware_connections.kind` (CHECK constraint on the allowed values). An update of a connection is refused (`ENDPOINT_CHANGED`) when the kind differs from the stored one. |
| `name` | Short product name. | Display. |
| `fullName` | Product name with version and build. | Display. |
| `version` | Product version, dotted. | Display. |
| `build` | Build number (string). | Display. |
| `apiType` | `VirtualCenter` or `HostAgent`. | Display. |
| `apiVersion` | API version, dotted; drives `compat`. | Display, compat. |
| `instanceUuid` | Unique id of the installation (may be empty on ESXi). | Stored as `instance_uuid`; unique among connections of kind `vcenter`; an update is refused when it changes. Also the key for scan hits. |

The whole object is stored as `vmware_connections.product` (jsonb) and returned to the UI.

### 8.2 licenses, writeApi

```go
type License struct {
    Name       string `json:"name"`
    EditionKey string `json:"editionKey"`
    Total      int32  `json:"total"`
    Used       int32  `json:"used"`
}
```

- Licence keys are never returned. Stored as `vmware_connections.licenses` (jsonb), display only.
- `writeApi`: `"available"` when the licence list could be read and no licence has `editionKey == "esxBasic"`
  or a name containing "hypervisor" (case-insensitive); `"restricted"` when one does (the free ESXi licence
  makes the API read-only); `"unknown"` when the list could not be read (then also warning
  `LICENSE_UNREADABLE`). Stored in `vmware_connections.write_api`, which has a CHECK constraint on exactly these
  three values.

### 8.3 privileges, operations

`privileges` maps each checked privilege id to whether the account has it on the inventory root:

```
System.View  System.Read
VirtualMachine.Inventory.Create  VirtualMachine.Inventory.Delete
VirtualMachine.Interact.PowerOn  VirtualMachine.Interact.PowerOff  VirtualMachine.Interact.Reset
VirtualMachine.Interact.ConsoleInteract  VirtualMachine.Config.CPUCount  VirtualMachine.Config.Memory
VirtualMachine.Config.AddNewDisk  VirtualMachine.Provisioning.Clone  VirtualMachine.State.CreateSnapshot
Datastore.AllocateSpace  Network.Assign  Resource.AssignVMToPool  DVSwitch.PortConfig  DVPortgroup.PolicyOp
```

It is `{}` when the check could not be made (warning `PRIVILEGES_UNREADABLE`); then every operation that needs
a privilege is false. Stored as jsonb, display only (the keys are free-form for the callers).

`operations` always has exactly these ten keys (`write` = `writeApi == "available"`):

| Key | True when | Read by |
| --- | --- | --- |
| `inventory` | `System.View` and `System.Read` | UI |
| `createVm` | write, and `VirtualMachine.Inventory.Create`, `Datastore.AllocateSpace`, `Network.Assign`, `Resource.AssignVMToPool`, `VirtualMachine.Config.AddNewDisk` | UI |
| `cloneFromImage` | write, kind `vcenter`, and `VirtualMachine.Provisioning.Clone`, `Datastore.AllocateSpace` | API: required to create a server (`servers.ts`) |
| `power` | write, and `VirtualMachine.Interact.PowerOn`, `.PowerOff`, `.Reset` | UI |
| `resize` | write, and `VirtualMachine.Config.CPUCount`, `VirtualMachine.Config.Memory` | UI |
| `deleteVm` | write, and `VirtualMachine.Inventory.Delete` | UI |
| `snapshot` | write, and `VirtualMachine.State.CreateSnapshot` | UI |
| `console` | `VirtualMachine.Interact.ConsoleInteract` | API: required to open a console (`console.ts`) |
| `firewall` | write, kind `vcenter`, and `DVSwitch.PortConfig`, `DVPortgroup.PolicyOp` | API: required to attach a firewall (`servers.ts`, `firewalls.ts`, `insights.ts` via `operations->>'firewall'`) |
| `automationApi` | kind `vcenter` | UI |

Stored as `vmware_connections.operations` (jsonb).

### 8.4 warnings

Array of codes (always an array, possibly empty), stored as jsonb and translated by the UI:

| Code | When |
| --- | --- |
| `LICENSE_UNREADABLE` | The licence list could not be read. |
| `PRIVILEGES_UNREADABLE` | The privilege check failed. |
| `HOST_MANAGED_BY_VCENTER` | Kind `esxi` and a host reports a management server (it is managed by a vCenter). Added once per such host. |
| `VERSION_LEGACY` | API version below 7.0. |
| `VERSION_END_OF_SUPPORT` | API version 7.x. |
| `CUSTOMIZATION_GUESTINFO` | Kind `vcenter` and API below 7.0.3 (native cloud-init customization unavailable). |
| `FEDERATED_LOGIN_BLOCKED` | Kind `vcenter` and API 9.0 or newer. |
| `GUEST_AGENT_NOT_PERMITTED` | Proxmox VE: the account lacks the guest agent privilege (`VM.Monitor` up to PVE 8, `VM.GuestAgent.Unrestricted` from PVE 9). |
| `GUEST_NIC_NAME_ETH0` | oVirt, always: the engine writes network settings for an interface named `eth0`. |
| `VIRTINST_MISSING` | libvirt: the host has no `virt-clone` / `virt-xml`, so servers cannot be created. |
| `NO_IMAGES` | Incus: the image store is empty. |

### 8.5 compat

```go
type Compat struct {
    APIVersion    string `json:"apiVersion"`
    Customization string `json:"customization"` // "cloudinit" (native, vCenter 7.0U3+), "guestinfo" (cloud-init VMware datasource), "none"
    Clone         bool   `json:"clone"`         // template cloning needs vCenter
    ConsoleURL    bool   `json:"consoleUrl"`    // AcquireTicket returns a ready URL (API 7.0+); older ones are built by the adapter
    Support       string `json:"support"`       // "supported", "end-of-support" (6.7, 7.0) or "legacy" (below 7.0)
}
```

| JSON | Value | Use |
| --- | --- | --- |
| `apiVersion` | Same as `product.apiVersion`. | Display. |
| `customization` | `"none"` unless kind `vcenter` and `writeApi != "restricted"`; then `"cloudinit"` for API 7.0.3 or newer, else `"guestinfo"`. | Worker: the customization used when the connection is set to `auto`; `none` blocks provisioning. API: choosing `cloudinit` for a connection is refused (`NOT_SUPPORTED_BY_VERSION`) unless this is `cloudinit`. |
| `clone` | Kind is `vcenter`. | Display. |
| `consoleUrl` | API 7.0 or newer. | Display. |
| `support` | `"legacy"` below 7.0, `"end-of-support"` for 7.x, `"supported"` from 8.0. (The code is authoritative; the struct comment is slightly different.) | Display. |

Stored as `vmware_connections.compat` (jsonb). Versions are compared numerically per dotted component.
`vmware_connections.customization` (the admin's choice) is constrained to `auto`, `cloudinit`, `guestinfo`.

### 8.6 Inventory lists and their tables

`storeInventory` (`apps/api/src/vmware.ts`) deletes the connection's rows and re-inserts each list with

```sql
INSERT INTO vmware_hosts SELECT $1, * FROM json_to_recordset($2) AS x(<columns>)
```

so each JSON object is read **by key name** with the type given below and written **by position** into the
table. A key that is missing becomes `NULL`; extra keys are ignored. The column lists are:

```ts
const recordsets = {
  vmware_hosts: `moref text, name text, "hardwareUuid" text, vendor text, model text, "cpuMhz" int, "cpuCores" int, "cpuThreads" int, "memoryBytes" bigint,
    "connectionState" text, "powerState" text, "inMaintenance" boolean, version text, "managementServer" text, parent text`,
  vmware_datastores: `moref text, name text, type text, "capacityBytes" bigint, "freeBytes" bigint, "uncommittedBytes" bigint, accessible boolean, "maintenanceMode" text, hosts text[]`,
  vmware_networks: 'moref text, name text, kind text, vlan int, switch text',
  vmware_compute: `moref text, name text, kind text, hosts int, "effectiveCpuMhz" int, "effectiveMemoryMb" bigint, "resourcePool" text`,
  vmware_vms: `moref text, name text, uuid text, "instanceUuid" text, "powerState" text, host text, cpu int, "memoryMb" int, template boolean, guest text,
    "committedBytes" bigint, "uncommittedBytes" bigint`,
};
```

All five tables have the primary key `(connection_id, moref)`: ids must be unique per list within one
discovery, and non-empty.

#### hosts -> `vmware_hosts`

```go
type Host struct {
    MoRef            string `json:"moref"`
    Name             string `json:"name"`
    HardwareUUID     string `json:"hardwareUuid"`
    Vendor           string `json:"vendor"`
    Model            string `json:"model"`
    CPUMhz           int32  `json:"cpuMhz"`
    CPUCores         int16  `json:"cpuCores"`
    CPUThreads       int16  `json:"cpuThreads"`
    MemoryBytes      int64  `json:"memoryBytes"`
    ConnectionState  string `json:"connectionState"`
    PowerState       string `json:"powerState"`
    InMaintenance    bool   `json:"inMaintenance"`
    Version          string `json:"version"`
    ManagementServer string `json:"managementServer"`
    Parent           string `json:"parent"`
}
```

| JSON | Column | Meaning and constraints |
| --- | --- | --- |
| `moref` | `moref` (PK part) | Host id. Used as `host` in `/v1/vm/migrate`, and matched against `vms[].host`, topology and power reports. |
| `name` | `name` NOT NULL | Host name. Scan results are matched to managed hosts by this name (lower-cased). |
| `hardwareUuid` | `hardware_uuid` NOT NULL, **globally unique** | The machine's hardware UUID. The same physical host may not be counted through two connections: a clash is refused with `HOSTS_ALREADY_MANAGED`. When empty the API substitutes `unknown:<connection id>:<moref>`. |
| `vendor`, `model` | `vendor`, `model` | Hardware vendor and model; empty when unknown. |
| `cpuMhz` | `cpu_mhz` | Speed of one core in MHz. |
| `cpuCores` | `cpu_cores` | Physical cores (capacity: `sum(cpu_mhz * cpu_cores)`, `sum(cpu_cores)`). |
| `cpuThreads` | `cpu_threads` | Logical CPUs. |
| `memoryBytes` | `memory_bytes` | Physical memory in bytes. |
| `connectionState` | `connection_state` | `connected`, `disconnected`, `notResponding`. |
| `powerState` | `power_state` | `poweredOn`, `poweredOff`, `standBy`, `unknown`. |
| `inMaintenance` | `in_maintenance` | Maintenance mode. |
| `version` | `version` | The host's own product version. |
| `managementServer` | `management_server` | Address of the vCenter managing this host, `""` when none. |
| `parent` | `parent` | Id of the compute resource the host belongs to (a `compute[].moref`). **Load-bearing**: capacity (`catalog.ts`) and placement (`placement.ts`) select a pool's hosts with `h.parent = pool.compute_moref` (placement also accepts `h.moref = compute_moref`). |

Hardware fields are zero/empty for a host whose hardware summary is unavailable (for example disconnected).

#### datastores -> `vmware_datastores`

```go
type Datastore struct {
    MoRef            string   `json:"moref"`
    Name             string   `json:"name"`
    Type             string   `json:"type"`
    CapacityBytes    int64    `json:"capacityBytes"`
    FreeBytes        int64    `json:"freeBytes"`
    UncommittedBytes int64    `json:"uncommittedBytes"`
    Accessible       bool     `json:"accessible"`
    MaintenanceMode  string   `json:"maintenanceMode"`
    Hosts            []string `json:"hosts"`
}
```

| JSON | Column | Meaning and constraints |
| --- | --- | --- |
| `moref` | `moref` | Datastore id: `datastore` in clone, migrate, disk-copy, backup, ISO and CD-ROM routes. |
| `name` | `name` NOT NULL | Display name. |
| `type` | `type` | `VMFS`, `NFS`, `vsan`, ... (free text). |
| `capacityBytes` | `capacity_bytes` NOT NULL | Total size. |
| `freeBytes` | `free_bytes` NOT NULL | Free space. The worker clones onto the pool's accessible datastore with the most free bytes. |
| `uncommittedBytes` | `uncommitted_bytes` NOT NULL | Space thin disks may still grow into. Must be sent (the insert writes the value explicitly, so the column default does not apply). Provisioned = capacity - free + uncommitted. |
| `accessible` | `accessible` NOT NULL | Usable right now. Inaccessible datastores are never chosen. |
| `maintenanceMode` | `maintenance_mode` | `normal`, `enteringMaintenance`, `inMaintenance`. |
| `hosts` | `host_morefs` text[] NOT NULL | Ids of hosts that mount it. Always an array. |

#### networks -> `vmware_networks`

```go
type Network struct {
    MoRef  string `json:"moref"`
    Name   string `json:"name"`
    Kind   string `json:"kind"` // "standard" or "distributed"
    VLAN   *int32 `json:"vlan"`
    Switch string `json:"switch"`
}
```

| JSON | Column | Meaning and constraints |
| --- | --- | --- |
| `moref` | `moref` | Network id: `network` in clone; `reference` in `/v1/network/create`. |
| `name` | `name` NOT NULL | Port group / network name. |
| `kind` | `kind` NOT NULL, CHECK `IN ('standard','distributed')` | `distributed` for a distributed port group. A location's private-network reference must be a network of kind `distributed` (`privnet.ts`). |
| `vlan` | `vlan` | VLAN id, or `null` when unknown or a trunk. For standard port groups it is taken from the hosts' port group of the same name. |
| `switch` | `switch` | Distributed: the distributed switch's id. Standard: the vSwitch name. May be empty. |

The list contains every network object, distributed port groups included (uplink port groups too). Port groups
created by `/v1/network/create` (`lvm-net-...`) appear here after the next discovery.

#### compute -> `vmware_compute`

```go
type ComputeResource struct {
    MoRef          string `json:"moref"`
    Name           string `json:"name"`
    Kind           string `json:"kind"` // "cluster" or "standalone"
    Hosts          int32  `json:"hosts"`
    EffectiveCPU   int32  `json:"effectiveCpuMhz"`
    EffectiveMemMB int64  `json:"effectiveMemoryMb"`
    ResourcePool   string `json:"resourcePool"`
}
```

| JSON | Column | Meaning and constraints |
| --- | --- | --- |
| `moref` | `moref` | Compute resource id. A resource pool of the panel (location capacity) points at one: `resource_pools.compute_moref`. Equals `hosts[].parent` of its hosts. |
| `name` | `name` NOT NULL | Cluster name, or the host's name for a standalone host. |
| `kind` | `kind` NOT NULL, CHECK `IN ('cluster','standalone')` | Cluster or single host. |
| `hosts` | `hosts` | Number of hosts. |
| `effectiveCpuMhz` | `effective_cpu_mhz` | CPU available to VMs in MHz. |
| `effectiveMemoryMb` | `effective_memory_mb` | Memory available to VMs in MiB. |
| `resourcePool` | `resource_pool` | Id of the root resource pool. **Load-bearing**: the worker sends it as `pool` to `/v1/vm/clone`; when it is empty the operation fails with `INVENTORY_STALE`. |

On a standalone ESXi there is one entry of kind `standalone`. On vCenter every cluster and every standalone
host is one entry.

#### vms -> `vmware_vms`

```go
type VM struct {
    MoRef            string `json:"moref"`
    Name             string `json:"name"`
    UUID             string `json:"uuid"`
    InstanceUUID     string `json:"instanceUuid"`
    PowerState       string `json:"powerState"`
    Host             string `json:"host"`
    CPU              int32  `json:"cpu"`
    MemoryMB         int32  `json:"memoryMb"`
    Template         bool   `json:"template"`
    Guest            string `json:"guest"`
    CommittedBytes   int64  `json:"committedBytes"`
    UncommittedBytes int64  `json:"uncommittedBytes"`
}
```

| JSON | Column | Meaning and constraints |
| --- | --- | --- |
| `moref` | `moref` | VM id: the same id every `/v1/vm/*` route takes as `vm`, and what `/v1/vm/find` returns. Stored in `servers.vm_moref`, `os_images.template_moref`. |
| `name` | `name` NOT NULL | The VM's current name. Names starting `lvm-` are the panel's own and are excluded from "foreign" capacity and from the import list. |
| `uuid` | `uuid` | BIOS UUID. |
| `instanceUuid` | `instance_uuid` | Instance UUID. |
| `powerState` | `power_state` | `poweredOn`, `poweredOff`, `suspended`. An imported VM is marked guest-ready when this is `poweredOn`. |
| `host` | `host_moref` | Id of the host it runs on (a `hosts[].moref`). Used for placement, per-host server lists and capacity of foreign VMs; updated by the worker after a migration. |
| `cpu` | `cpu` | Configured vCPUs. |
| `memoryMb` | `memory_mb` | Configured memory in MiB. |
| `template` | `template` NOT NULL | True for a template. Must be sent as a boolean. OS images can only point at a VM with `template = true`; templates are excluded from import and from capacity. |
| `guest` | `guest` | Configured guest OS name (free text). |
| `committedBytes` | `committed_bytes` | Storage in use by the VM. |
| `uncommittedBytes` | `uncommitted_bytes` | Storage it may still grow into. |

All VMs and templates of the endpoint are listed (not only the panel's).

### 8.7 Connection row

For completeness, what `vmware_connections` holds from a discovery (migrations `004_vmware.sql`,
`008_two_factor_branding.sql`, and `064_proxmox.sql` to `069_incus.sql`, each of which widens the `kind` check by
one platform: `proxmox`, `xcpng`, `ovirt`, `hyperv`, `libvirt`, `incus`):

| Column | From |
| --- | --- |
| `kind` | `product.kind` |
| `instance_uuid` | `product.instanceUuid` (null when empty; unique among `kind = 'vcenter'`) |
| `product` | `product` |
| `licenses` | `licenses` (or `[]`) |
| `write_api` | `writeApi` (CHECK: `available`, `restricted`, `unknown`) |
| `privileges` | `privileges` |
| `operations` | `operations` |
| `warnings` | `warnings` |
| `compat` | `compat` |
| `api_version` | the admin's pinned version (not from discovery) |
| `customization` | the admin's choice (CHECK: `auto`, `cloudinit`, `guestinfo`) |
| `status`, `last_error_code` | `ok`, or `error` with the failure `code` of the last discovery / reconcile |
| `host`, `port` | unique together |

Other tables that hold adapter ids: `resource_pools` (`compute_moref`, `datastore_morefs`, `network_moref`,
`backup_datastore_moref`, `private_portgroup_moref`), `os_images.template_moref`, `servers.vm_moref` and
`clone_from_moref`, `isos.datastore_moref`, `backups.datastore_moref`, `private_networks.portgroup_moref`,
`server_disks.device_key`, `power_host_profiles.host_moref`, `power_samples.host_moref`,
`reconciliation_findings.vm_moref`. The scan tables (`059_vmware_scans.sql`) store `/v1/scan` hits:
`vmware_scan_hits(address, state CHECK IN ('vsphere','https'), hostname, product jsonb, certificate jsonb)`.

---

## 9. Routes only some adapters have

### POST /v1/vm/guest-setup (Proxmox VE adapter)

- Synchronous, 60 s. Called by the worker (`kinds.create` in `apps/worker/operations.mjs`) once a new server is
  ready, for connections of platform `proxmox` only.
- Request: Target plus `vm` (string, required) and `userdata` (the same cloud-config document sent to
  `/v1/vm/clone`).
- What it does: Proxmox's own cloud-init carries the network and the SSH keys only, so the rest of the
  cloud-config is applied through the QEMU guest agent: the root password (`chpasswd.list`, handed over as the
  hash it is), the host name, `write_files` and `runcmd`. The commands run from one script that leaves a marker
  in the guest (`/var/lib/lightning-guest-setup.done`), so a repeated call does nothing.
- Response: `{"applied": true, "password": bool, "files": n, "commands": n}`, or `{"applied": false, "reason":
  "NO_GUEST_AGENT" | "NOTHING_TO_DO"}`.
- Errors: `TOOLS_NOT_RUNNING` (the agent is enabled but does not answer yet; the worker retries), `VM_NOT_FOUND`,
  `INVALID_REQUEST` (a file larger than the agent takes), common errors.
