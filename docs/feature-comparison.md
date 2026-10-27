# Features against AutoVM and similar panels

Sources (October 2026): AutoVM (autovm.net: home page, feature tour, FAQ). VirtFusion, Virtualizor, SolusVM 2, Convoy, the WGS VMware WHMCS module, HostBill and Proxmox VE, from their official feature pages and docs.

Status values:

- **Yes**: Lightning VM already had it.
- **New**: added in this round.
- **Planned**: not built yet.
- **N/A**: KVM- or Proxmox-specific, with no VMware equivalent the panel needs.

## Provisioning and the server's life

| Feature | Who has it | Lightning VM |
|---|---|---|
| Server built automatically after payment (about a minute) | everyone | Yes (an order waits for payment, then is built) |
| Linux and Windows templates, OS chosen at order | everyone | Yes |
| Reinstall / change OS | AutoVM, VirtFusion, Virtualizor, SolusVM, WGS, HostBill | **New**: same addresses, keys and firewalls; optional new key and password |
| Upgrade / downgrade CPU, RAM, disk | AutoVM, WGS, HostBill, SolusVM | **New**: package or custom size; the disk only grows; the increase is invoiced pro rata |
| Automatic disk/partition extension | AutoVM, HostBill | **New** (cloud-init growpart on the next boot) |
| Clone a server | AutoVM, Virtualizor, Proxmox | **New**: a copy with its disk; its own name, address and keys |
| Import existing VMs | Virtualizor, SolusVM, VirtFusion, HostBill, WGS | **New**: Admin → Servers → Import |
| cloud-init: hostname, password, SSH key, network | VirtFusion, SolusVM, HostBill | Yes |
| Script after installation / applications | AutoVM, Virtualizor, SolusVM | Yes (applications: cPanel, Plesk, custom script) |
| ISO library and customer ISO mount | VirtFusion, Virtualizor, SolusVM, WGS | Yes |
| Snapshots (customer, limit, schedule) | WGS, HostBill, Proxmox | Yes (with automatic snapshots and rotation) |
| Root password reset | VirtFusion, WGS, HostBill | Yes (stored encrypted, shown on request) |
| Rescue mode | SolusVM, HostBill | Yes: boot from an ISO in the library (SystemRescue, for example), then eject |
| Change hostname | HostBill, VirtFusion | Planned |
| Extra disks | SolusVM, HostBill | Planned |
| Backups | VirtFusion, Virtualizor, SolusVM, HostBill | **New**: disk copies on each location's backup datastore (an NFS store at another site works), by hand or on a schedule with retention, restored over the disk |
| Nested ESXi | — | Yes (ESXi images) |
| Containers (LXC/OpenVZ), GPU passthrough, NUMA | Virtualizor, SolusVM, Proxmox | N/A |

## Network

| Feature | Who has it | Lightning VM |
|---|---|---|
| IPv4/IPv6 pools, automatic assignment | everyone | Yes |
| Extra IPs sold | SolusVM, HostBill, WGS | Yes |
| Customer-editable reverse DNS (PowerDNS) | VirtFusion, Virtualizor, SolusVM, HostBill | Yes |
| Customer firewall | VirtFusion, Virtualizor, HostBill | Yes (distributed switch port rules) |
| Address quarantine after delete | — | Yes |
| Monthly traffic count and allowance | AutoVM, VirtFusion, SolusVM, HostBill | **New**: per server and day, in and out, warnings at 80% and 100% |
| Bandwidth graph per VM | AutoVM, VirtFusion, Virtualizor | Yes (live) and **New** (31 days) |
| Port speed limit / throttle on overage | VirtFusion, SolusVM, HostBill | **New**: distributed-switch traffic shaping once the allowance is used up, lifted when it is covered again |
| Private networks / VPC | Virtualizor, SolusVM, HostBill | Planned (port groups) |
| Load balancer | Virtualizor | Planned |

## Billing

| Feature | Who has it | Lightning VM |
|---|---|---|
| Monthly subscriptions, invoices, collection, suspension | everyone (through WHMCS etc.) | Yes, built in (no WHMCS needed) |
| Pro-rata charge on upgrade | HostBill, WGS | **New** |
| Balance top-up, saved cards, Turkish payment providers | — | Yes (iyzico, PayTR, Stripe, Craftgate, Param) |
| e-Fatura / e-Arşiv | — | Yes (seven integrators) |
| Hourly pay-as-you-go | AutoVM, Virtualizor, VirtFusion, HostBill | **New**: paid from the balance, with a hold when it runs out and a monthly usage invoice |
| WHMCS / WISECP module | AutoVM, everyone | **New**: `integrations/` (WHMCS server module; WISECP module not tried on a WISECP install) |
| Invoice disputes | — | **New**: reason, lines, files; collection paused; credit, refund or withdraw |

## Automation and API

| Feature | Who has it | Lightning VM |
|---|---|---|
| REST API | everyone | Yes; **New**: personal API tokens (read-only or full, with expiry) |
| Outgoing webhooks | VirtFusion, SolusVM | **New**: signed, retried, delivery log, test button |
| Hooks / scripts on events | AutoVM, Virtualizor, SolusVM | **New** (webhooks) |
| Task queue, retries, full log | AutoVM, WGS | Yes (operations, audit log) |
| Automatic synchronization with vCenter | AutoVM | Yes (reconciliation, inventory discovery) |

## Operations and security

| Feature | Who has it | Lightning VM |
|---|---|---|
| Multiple vCenters / locations | everyone | Yes |
| vMotion / migration between hosts | VirtFusion, Virtualizor, SolusVM, WGS | Planned (DRS covers it inside a cluster) |
| Location maintenance mode | SolusVM | Yes |
| Roles and permissions | VirtFusion, Virtualizor, SolusVM | Yes (with per-role limits) |
| Two-factor, LDAP, OIDC, passkeys | Proxmox (partly) | Yes |
| Abuse detection | Synergy CP | Yes (open risky ports, mining) |
| Resellers | Virtualizor, Hosting Controller | **New**: an allocation and a discount, own customers, servers ordered and managed for them |
| White label, two languages | Virtualizor, VirtFusion | Yes (branding, Turkish/English) |
| Status page, support tickets, energy report | — | Yes |
