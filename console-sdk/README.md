# VMware HTML Console SDK (not included)

The browser console renders with VMware's HTML Console SDK (`wmks.min.js`). It is downloaded
from Broadcom's developer portal with a Broadcom account and its license does not state that it
may be redistributed, so this repository does not ship it.

Put these files in this folder (served at `/console-sdk/`):

    console-sdk/
      wmks.min.js
      css/wmks-all.css        (and the css/ and img/ folders from the SDK)
      jquery.min.js           jQuery version the SDK release notes name
      jquery-ui.min.js        jQuery UI version the SDK release notes name

Check the SDK's own license before deploying. Without these files the panel still issues console
sessions and the gateway works, but the console page shows that the SDK is missing.
See docs/console.md.
