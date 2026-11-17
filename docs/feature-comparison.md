# Features against AutoVM and similar panels

Sources (October 2026): AutoVM (autovm.net: home page, feature tour, FAQ). VirtFusion, Virtualizor, SolusVM 2, Convoy, the WGS VMware WHMCS module, HostBill and Proxmox VE, from their official feature pages and docs.

Status values:

- **Yes**: Lightning VM already had it.
- **New**: added in this round.
- **Planned**: not built yet.
- **Not built**: the panel does not have it.

**Read this first.** The table was written when the panel managed VMware only, and "Yes" / "New" mean "on VMware
(vCenter)". Six more platforms were added since (Proxmox VE, XCP-ng, oVirt, Hyper-V, KVM through libvirt, Incus / LXD),
as first releases with a narrower set: on them the adapters answer `PLATFORM_NOT_SUPPORTED` for the browser console,
firewall, traffic throttling, backups, personal images, the ISO library, private networks and migration. Rows that
are VMware-only say so below. The table per platform is in the README ("Platform kapsamı"). "Yes" also means the code
exists and its tests pass, not that it was tried on real hardware: VMware was tested mostly against the govmomi
simulator, and of the six newer adapters only Incus (containers) ran against a real server.

## Provisioning and the server's life

| Feature | Who has it | Lightning VM |
|---|---|---|
| Server built automatically after payment (about a minute) | everyone | Yes (an order waits for payment, then is built) |
| Linux and Windows templates, OS chosen at order | everyone | Yes |
| Reinstall / change OS | AutoVM, VirtFusion, Virtualizor, SolusVM, WGS, HostBill | **New**: same addresses, keys and firewalls; optional new key and password |
| Upgrade / downgrade CPU, RAM, disk | AutoVM, WGS, HostBill, SolusVM | **New**: package or custom size; the disk only grows; the increase is invoiced pro rata |
| Automatic disk/partition extension | AutoVM, HostBill | Partly: the panel grows the virtual disk only. The partition and file system grow on the next boot if the image's own cloud-init does it (growpart / resize_rootfs, the default on most cloud images). Not verified; the panel runs nothing in the guest for it |
| Clone a server | AutoVM, Virtualizor, Proxmox | **New**: a copy with its disk; its own name, address and keys (not on oVirt) |
| Import existing VMs | Virtualizor, SolusVM, VirtFusion, HostBill, WGS | **New**: Admin → Servers → Import |
| cloud-init: hostname, password, SSH key, network | VirtFusion, SolusVM, HostBill | Yes |
| Script after installation / applications | AutoVM, Virtualizor, SolusVM | Yes (applications: cPanel, Plesk, custom script) |
| ISO library and customer ISO mount | VirtFusion, Virtualizor, SolusVM, WGS | Yes (VMware only) |
| Snapshots (customer, limit, schedule) | WGS, HostBill, Proxmox | Yes (with automatic snapshots and rotation) |
| Root password reset | VirtFusion, WGS, HostBill | Yes (stored encrypted, shown on request) |
| Rescue mode | SolusVM, HostBill | Yes (VMware only): boot from an ISO in the library (SystemRescue, for example), then eject |
| Change hostname | HostBill, VirtFusion | **New**: renamed in the panel, with its default reverse DNS; the name inside the guest stays the customer's |
| Hand a server to another account | VirtFusion, HostBill | **New**: offered by e-mail and accepted within 7 days, with its subscription; staff move one at once |
| Extra disks | SolusVM, HostBill | **New**: priced per GB per location, added and removed while the server runs |
| Backups | VirtFusion, Virtualizor, SolusVM, HostBill | **New** (VMware only): disk copies on each location's backup datastore (an NFS store at another site works), by hand or on a schedule with retention, restored over the disk |
| Nested ESXi | — | Yes (ESXi images) |
| Containers | Virtualizor, SolusVM, Proxmox | Yes, on Incus / LXD only: system containers sold as servers (first release; the one adapter tried on a real server). Not LXC on Proxmox, not OpenVZ |
| GPU passthrough, NUMA | Virtualizor, SolusVM, Proxmox | Not built |
| KVM, Proxmox VE, XCP-ng, oVirt, Hyper-V | Virtualizor, SolusVM, VirtFusion, Convoy | First releases with the narrower set described above; none of these five was run against a real host |

## Network

| Feature | Who has it | Lightning VM |
|---|---|---|
| IPv4/IPv6 pools, automatic assignment | everyone | Yes for IPv4. IPv6 is an optional prefix on an IPv4 pool: one address per server, no separate IPv6 pools |
| Extra IPs sold | SolusVM, HostBill, WGS | Yes |
| Customer-editable reverse DNS (PowerDNS) | VirtFusion, Virtualizor, SolusVM, HostBill | Yes |
| Customer firewall | VirtFusion, Virtualizor, HostBill | Yes (VMware only: distributed switch port rules) |
| Address quarantine after delete | — | Yes |
| Monthly traffic count and allowance | AutoVM, VirtFusion, SolusVM, HostBill | **New**, on VMware and Proxmox VE only: per server and day, in and out, warnings at 80% and 100%. The other five adapters report no traffic, so nothing is counted there |
| Bandwidth graph per VM | AutoVM, VirtFusion, Virtualizor | Yes (live) and **New** (31 days), on VMware and Proxmox VE only; the graphs are empty on the other five |
| Port speed limit / throttle on overage | VirtFusion, SolusVM, HostBill | **New**, VMware only: distributed-switch traffic shaping once the allowance is used up, lifted when it is covered again |
| Private networks / VPC | Virtualizor, SolusVM, HostBill | **New** (VMware only): a distributed port group with its own VLAN per network, a second NIC per server |
| Load balancer | Virtualizor | Planned |

## Billing

| Feature | Who has it | Lightning VM |
|---|---|---|
| Monthly subscriptions, invoices, collection, suspension | everyone (through WHMCS etc.) | Yes, built in (no WHMCS needed) |
| Pro-rata charge on upgrade | HostBill, WGS | **New** |
| Balance top-up, saved cards, Turkish payment providers | — | Yes: iyzico, PayTR, Stripe and Craftgate take payments; Param payments are confirmed by staff by hand, TRY only (none tried with a real merchant account). The other 41 providers in Settings are credential forms only |
| e-Fatura / e-Arşiv | — | Yes: seven integrators written; only İzibiz and Uyumsoft were sent a real e-Arşiv invoice (in their test systems), the other five were written from their documents and not tried |
| Hourly pay-as-you-go | AutoVM, Virtualizor, VirtFusion, HostBill | **New**: paid from the balance, with a hold when it runs out and a monthly usage invoice |
| WHMCS / WISECP module | AutoVM, everyone | **New**: `integrations/` (WHMCS server module; WISECP module not tried on a WISECP install) |
| Coupons / promo codes | WHMCS, HostBill, Virtualizor (through billing) | **New**: percent or fixed, first N invoices or all, limited by uses, date, packages and new customers |
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
| vMotion / migration between hosts | VirtFusion, Virtualizor, SolusVM, WGS | **New** (VMware only): move a server to a host or datastore while it runs; evacuate a host before maintenance |
| Location maintenance mode | SolusVM | Yes |
| Roles and permissions | VirtFusion, Virtualizor, SolusVM | Yes (with per-role limits) |
| Two-factor, LDAP, OIDC, passkeys | Proxmox (partly) | Yes |
| Abuse detection | Synergy CP | Yes (open risky ports, mining). Mining needs CPU usage, which XCP-ng, oVirt, libvirt and Incus do not report |
| Resellers | Virtualizor, Hosting Controller | **New**: an allocation and a discount, own customers, servers ordered and managed for them |
| White label, two languages | Virtualizor, VirtFusion | Yes (branding, Turkish/English) |
| Status page, support tickets, energy report | — | Yes. The energy report is estimated from CPU usage, so it means little on XCP-ng, oVirt, libvirt and Incus |
