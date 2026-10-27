# Selling through WHMCS or WISECP

Lightning VM has its own billing. If you already sell through WHMCS or WISECP, these modules let that system sell the
servers instead. The billing system then bills; the panel never invoices these servers. A customer is found by e-mail, or
created on the first order. The first time, the customer sets a password with **Forgot password** on the panel's
sign-in page.

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
| `POST /api/admin/external/<source>/customers` `{ email, name?, locale? }` | Returns the customer's id, created when new |
| `POST /api/admin/external/<source>/servers` `{ reference, customerId, type: "package", poolId, packageId, imageId, name, rootPassword?, sshKey? }` | Orders a server. The same reference returns the same server |
| `GET /api/admin/external/<source>/servers/<reference>` | Returns the state, the address, the size and the last operation |
| `POST /api/admin/external/<source>/servers/<reference>/<action>` | Runs `suspend`, `unsuspend`, `power_on`, `shutdown`, `power_off`, `reset`, or `resize` (with a package or a custom size) |
| `DELETE /api/admin/external/<source>/servers/<reference>` | Removes the server |
