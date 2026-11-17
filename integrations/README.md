# Selling through WHMCS or WISECP

Lightning VM has its own billing. If you already sell through WHMCS or WISECP, these modules let that system sell the
servers instead. The billing system then bills; the panel never invoices these servers. The customer's panel account is
created on the first order; later orders with the same e-mail find that account. The first time, the customer sets a
password with **Forgot password** on the panel's sign-in page.

## How customers are matched

- **The integration matches only accounts it created itself.** A panel account that already exists with the buyer's
  e-mail address but was made another way (registration, staff, a reseller, another billing system) is never used
  silently, whether or not its address is verified: the order would hand that account's holder the new server, its
  console and its root password. `POST …/customers` answers `409 CUSTOMER_NEEDS_REVIEW` instead and the order stops.
- **Staff resolve it with the claim route**, once they know the account is to be the buyer's
  (needs **Manage users**):

  ```
  POST /api/admin/external/<source>/customers/<account id>/claim
  ```

  It binds the account to this billing system, marks its address verified and removes everything its earlier holder
  could still use: sessions, the password, API tokens, passkeys, linked sign-ins, webhooks, chat and push
  connections, saved SSH keys, the phone number and two-factor. Servers, invoices and tickets stay. The buyer then
  sets a password with **Forgot password**, and the order is retried. Staff accounts, resellers and their customers,
  and accounts of another billing system cannot be claimed. If the account is not the buyer's, rename or remove it
  in the panel instead.
- Accounts the integration created before this rule keep matching (they are marked on upgrade from the audit log).
  Accounts that existed beforehand and had been matched only because their address was verified need one claim.
- The WHMCS and WISECP modules do not know the code `CUSTOMER_NEEDS_REVIEW`; they show a general API error. Look
  for the code in the module's log.

## What customers can do in the panel

- **Servers the billing system sold** cannot be resized, given extra disks or copied by their owner in the panel
  (`409 EXTERNALLY_BILLED`): a package change is made in the billing system. Staff and the integration can.
- **Customers the integration created cannot order servers in the panel while the panel's own billing is off**
  (`409 EXTERNALLY_BILLED`): nobody would bill such a server. They order in the billing system. If you turn the
  panel's billing on, an order placed in the panel is invoiced by the panel like anyone's.
- **The integration's orders and package changes ignore the customer's role and quota.** What is sold is decided in
  the billing system: the customer's role does not need the order permission, and the account's quota is not
  applied to servers ordered through the integration.

## On the panel

1. Create a staff account for the billing system, with a role that has **Manage all servers** and **Manage users**.
2. Sign in as that account and open **Account → API**. Create a **full access** token without an expiry, and copy it.
3. Note the ids the products will use from **Catalog**: the resource pool (location), the package and the image.

## WHMCS (tested module structure: server module API 1.1)

1. Copy `whmcs/modules/servers/lightningvm` to `modules/servers/lightningvm` in WHMCS.
2. Go to **System Settings → Servers → Add New Server**:
   - **Module**: Lightning VM;
   - **Hostname**: the panel's address, for example `panel.example.com`;
   - **Password**: the token;
   - turn **Secure** on.

   **Test Connection** checks the token and its permissions.
3. In the product, open **Module Settings**, choose Lightning VM, and pick the location, package and image (the
   drop-downs are read from the panel's catalog).
   - A configurable option named `Image` lets the customer choose the image.
   - A custom field named `SSH Key` lets them give a key.
4. What each WHMCS action does:

   | WHMCS action | Panel |
   |---|---|
   | Create | Creates the server. A retry never creates a second one, because the reference is the service id. |
   | Suspend | Stops the server and holds it. |
   | Unsuspend | Starts the server again. |
   | Terminate | Deletes the server. |
   | Change Package | Resizes to the new package. The disk only grows. |
   | Power on, Shut down, Reset | Shown in the admin area and the client area. |
   | Client area | Shows the address and the state, with a link to the server in the panel (console, snapshots, firewall). |

## WISECP (not tested on a WISECP installation)

Copy `wisecp/coremio/modules/Product/LightningVM` to the same path in WISECP. Add the server with the panel's address as
host name and the token as password, then set the location, package and image ids in the product. The module makes the
same calls as the WHMCS module. Try an order, a suspension and a termination on a test WISECP before selling with it.

## The API they use

With a staff token (`Authorization: Bearer lvm_…`). `<source>` is `whmcs`, `wisecp` or any name of your own system.

| Call | What it does |
|---|---|
| `POST /api/admin/external/<source>/customers` `{ email, name?, locale? }` | Returns the customer's id, created when new. `409 CUSTOMER_NEEDS_REVIEW` when an account with that e-mail exists that this system did not create |
| `POST /api/admin/external/<source>/customers/<id>/claim` | Staff only (not called by the modules): hands an existing account to this system and removes its earlier sign-ins, tokens and keys. Returns what was removed |
| `POST /api/admin/external/<source>/servers` `{ reference, customerId, type: "package", poolId, packageId, imageId, name, rootPassword?, sshKey? }` | Orders a server. The same reference returns the same server |
| `GET /api/admin/external/<source>/servers/<reference>` | Returns the state, the address, the size and the last operation |
| `POST /api/admin/external/<source>/servers/<reference>/<action>` | Runs `suspend`, `unsuspend`, `power_on`, `shutdown`, `power_off`, `reset`, or `resize` (with a package or a custom size) |
| `DELETE /api/admin/external/<source>/servers/<reference>` | Removes the server |
