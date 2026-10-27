# Payment flows: hosted 3DS checkout, stored cards, refunds, webhooks

Date: 2026-10-27. Scope: actually taking money for monthly hosting subscriptions with iyzico, PayTR, Stripe, Param (TurkPos), Craftgate.
Companion to [research-payments.md](research-payments.md) (credentials and the "Test" button). Field names below are the ones
`apps/api/src/payment-providers.ts` already stores: iyzico `apiKey`/`secretKey`; PayTR `merchant_id`/`merchant_key`/`merchant_salt`;
Param `CLIENT_CODE`/`CLIENT_USERNAME`/`CLIENT_PASSWORD`/`GUID`; Craftgate `apiKey`/`secretKey`; Stripe `secretKey`/`publishableKey`/`webhookSecret`.

Confidence tags:
- **docs**: read in the provider's official docs (URL given).
- **sdk**: read in the provider's own official SDK / sample repo (code is the spec; docs not readable or silent).
- **community**: third-party library (mewebstudio/pos etc.) or blog/search result.
- **guess**: my inference; verify against a real sandbox call before shipping.

---

## 0. Decisions this research supports (read first)

1. **Recurring = stored card + merchant-initiated non-3D charge.** Every Turkish provider here can store a card; charging it without
   the customer needs *non-3D (NS) permission* on the merchant account. PayTR says so explicitly and grants it only after review (docs).
   For iyzico, Craftgate and Param the permission is per-account/POS configuration (guess, but universal practice in TR).
   **Plan for the fallback:** when the non-3D charge is refused (or the account is 3D-only), email the customer a link to a hosted 3DS
   checkout for that invoice. The scheduler must treat "needs customer action" as a normal state, not an error.
2. **Never post card numbers to our own server.** Hosted pages exist for iyzico (Checkout Form), PayTR (iFrame), Stripe (Checkout),
   Param (Ortak Ödeme Sayfası / TP_Modal_Payment), Craftgate (Ortak Ödeme Formu). Card *storage* on PayTR and Param, however, only exists
   on their direct APIs where the card form posts **directly from the browser to the provider** (PayTR) or via our server (Param
   `KS_Kart_Ekle`, which would put us in PCI scope). See per-provider notes.
3. **Always verify by a server-side retrieve**, not only by the callback hash: iyzico `checkoutform/auth/ecom/detail`, PayTR status query,
   Stripe `GET /v1/payment_intents/{id}` (or trust the signed webhook), Param `TP_Islem_Sorgulama4`, Craftgate
   `GET /payment/v1/checkout-payments/{token}`. Compare amount + currency + our order id with our invoice row before marking it paid.
4. **Idempotency on our side:** one `payment_attempts` row per (invoice, attempt number); the provider order id (`conversationId`,
   `merchant_oid`, `Siparis_ID`, `conversationId`/`externalId`) is that row's id. Callback/webhook handlers mark paid with
   `UPDATE ... WHERE status = 'pending'` and treat 0 rows as "already handled, answer OK". All five providers can deliver duplicates.
5. **Stripe**: still not available to Turkey-incorporated businesses (research-payments.md §3). Only useful if the operator has a
   non-TR entity. Documented here because the panel supports it.
6. **Param**: search results (Foreks, 2026-09) report that TMSF was appointed trustee over Türk Elektronik Para (PARAM) and group
   companies on 2026-07-13, with merchant payouts released in stages (community:
   https://www.foreks.com/haber/detay/6ab3723295016b5817e5eb7f/FRKS/tr/param-ve-grup-sirketlerinin-yonetimine-tmsf-kayyim-olarak-atandi-23-09-26/).
   Suggest implementing Param last and showing a warning in the admin UI.
7. **Currencies:** TRY everywhere. USD/EUR: iyzico CF (docs), PayTR iFrame (docs), Stripe (docs), Craftgate (sdk enum), Param only through
   a separate FX method `TP_Islem_Odeme_WD` with a direct card form (sdk). Whether the merchant's acquiring agreement actually allows
   FX settlement is a contract question for each provider (guess).

---

## 1. iyzico

Hosts: live `https://api.iyzipay.com`, sandbox `https://sandbox-api.iyzipay.com` (docs). Auth header `IYZWSv2` exactly as in
`payment-providers.ts` (`hex(HMAC_SHA256(secretKey, randomKey + uriPath + body))`), every call below is `POST` JSON with that header.

### 1.1 Hosted checkout (Checkout Form) with 3DS
- `POST /payment/iyzipos/checkoutform/initialize/auth/ecom` (docs: https://docs.iyzico.com/en/payment-methods/checkoutform/cf-implementation/cf-initialize)
- Required: `price` (sum of `basketItems[].price`), `paidPrice` (charged amount, may include installment interest), `currency`
  (`TRY` default, `USD`, `EUR`, `GBP`, `NOK`, `CHF`), `callbackUrl`, `buyer`, `billingAddress`, `basketItems[]`. `shippingAddress` may be
  omitted when all items are `VIRTUAL` (docs; the schema marks it required, description says omit - send it anyway, it is cheap).
- Optional: `locale` (`tr`|`en`), `conversationId` (use our attempt id), `basketId` (our invoice id), `paymentGroup`
  (`PRODUCT`|`LISTING`|`SUBSCRIPTION`; use `SUBSCRIPTION`), `enabledInstallments` (send `[1]`), `cardUserKey` (shows the user's stored
  cards and lets them save a new one), `forceThreeDS` (`1`), `debitCardAllowed`, `posOrderId` (sdk: iyzipay-php `CreateCheckoutFormInitializeRequest`).
- `buyer` required: `id`, `name`, `surname`, `identityNumber` (TCKN, 11 digits; foreigners commonly send `11111111111` - community),
  `email`, `gsmNumber` (`+905...`), `registrationAddress`, `city`, `country`; optional `ip`, `zipCode`, `registrationDate`,
  `lastLoginDate` (`YYYY-MM-DD hh:mm:ss`). Send `ip` (the customer's) - fraud scoring uses it (docs lists it optional).
- Address: `contactName`, `city`, `country`, `address` required, `zipCode` optional.
- `basketItems[]`: `id`, `name`, `category1`, `itemType` (`VIRTUAL` for hosting), `price` required.
- Prices are decimal strings/numbers; the SDK normalises `"10"` to `"10.0"` and strips trailing zeros (sdk `RequestFormatter::formatPrice`).
  `price` must equal the basket sum exactly or the call fails (community, well known).
- Response: `status`, `token`, `paymentPageUrl` (redirect the customer here - simplest), `checkoutFormContent` (script for an embedded
  popup/iframe), `tokenExpireTime`, `signature` (docs).
- Response signature: `hex(HMAC_SHA256(secretKey, conversationId + ":" + token))` (sdk: samples/initialize_checkout_form.php).

### 1.2 Result
- iyzico redirects the browser to `callbackUrl` with an HTTP **POST** containing `token` (docs: cf-retrieve page).
- Do not trust anything else in that POST. Call `POST /payment/iyzipos/checkoutform/auth/ecom/detail` with `{locale, conversationId, token}`
  (docs: https://docs.iyzico.com/en/payment-methods/checkoutform/cf-implementation/cf-retrieve).
- Paid iff `status == "success"` **and** `paymentStatus == "SUCCESS"` (docs field; the exact enum value is from SDK samples - sdk).
  Also check `fraudStatus == 1` (`0` = under review, `-1` = rejected) (community/sdk), `paidPrice`, `currency`, `basketId`.
- Response signature: `hex(HMAC_SHA256(secretKey, [paymentStatus, paymentId, currency, basketId, conversationId, paidPrice, price, token].join(":")))`
  (sdk: samples/retrieve_checkout_form_result.php + signature_verification.php). Prices in the signature are the formatted strings
  as returned (guess on exact formatting; log both sides on first mismatch).
- Store `paymentId` and `itemTransactions[].paymentTransactionId` (needed for the older refund API), and `cardUserKey`/`cardToken` when
  the user ticked "save card" (fields exist on the shared `PaymentResource`, sdk `PaymentResourceMapper`).

### 1.3 Stored cards and charging without the customer
- Store during checkout: pass our known `cardUserKey` (or none for a first card) to CF init; the customer ticks save; read `cardUserKey`
  + `cardToken` from the retrieve response (sdk).
- Store outside a payment: `POST /cardstorage/card` `{locale, conversationId, email, externalId, cardUserKey?, card:{cardAlias,
  cardHolderName, cardNumber, expireMonth, expireYear}}` (sdk `Card::create`, samples/create_card.php). This takes a raw PAN on our
  server, so avoid it. List: `POST /cardstorage/cards` `{cardUserKey}`; delete: `DELETE /cardstorage/card` `{cardUserKey, cardToken}` (sdk).
- Merchant-initiated charge (non-3D): `POST /payment/auth` with the same buyer/address/basket fields as CF plus
  `installment: 1`, `paymentChannel: "WEB"`, `paymentGroup: "SUBSCRIPTION"`, `paymentCard: {cardUserKey, cardToken}` (no CVC)
  (sdk: samples/create_payment_with_registered_card.php). Synchronous: `status`, `paymentId`, `fraudStatus`, `signature =
  hex(HMAC_SHA256(secretKey, [paymentId, currency, basketId, conversationId, paidPrice, price].join(":")))` (sdk).
- 3DS charge on a stored card (customer present): `POST /payment/3dsecure/initialize` with the same `paymentCard` + `callbackUrl`;
  returns `threeDSHtmlContent` (base64); callback POSTs `status`, `paymentId`, `conversationData`, `conversationId`, `mdStatus`;
  complete with `POST /payment/3dsecure/auth` `{paymentId, conversationData}` (docs/sdk). Callback hash per mewebstudio:
  `hex(HMAC_SHA256(secretKey, conversationData:conversationId:mdStatus:paymentId:status))` (community).
- Rules: non-3D `/payment/auth` only works if the iyzico account allows non-3D; many new accounts are 3D-forced (guess - ask iyzico
  account manager; expect error on refusal). iyzico also sells a **Subscription API** (`/v2/subscription/...`, products/pricing plans,
  iyzico charges the card itself and sends `subscription.order.success|failure` webhooks) - a valid alternative if non-3D is refused
  (docs: https://docs.iyzico.com/en/products/subscription). Not detailed here.

### 1.4 Refund
- Same day, full: `POST /payment/cancel` `{locale, conversationId, paymentId, ip}` (sdk `Cancel`).
- Amount-based (full or partial, any day): `POST /v2/payment/refund` `{locale, conversationId, paymentId, price, ip}` (sdk
  `AmountBaseRefund`, `AmountBaseRefundRequest`). Older per-item API: `POST /payment/refund` `{paymentTransactionId, price, ip,
  currency, reason?, description?}` (sdk `CreateRefundRequest`). Use v2; one basket item per invoice makes either work.

### 1.5 Webhooks
- Configure in merchant panel: Settings > Merchant Settings > Merchant Notifications (HTTPS) (docs: https://docs.iyzico.com/en/advanced/webhook).
- JSON POST, first try ~10-15 s after the payment; non-2xx -> retry every 15 min, max 3 attempts (docs).
- CF ("HPP format") payload: `paymentConversationId, merchantId, token, status, iyziReferenceCode, iyziEventType, iyziEventTime, iyziPaymentId`.
  Direct/registered-card payload: same but `paymentId` instead of `token`.
- Header `X-IYZ-SIGNATURE-V3` only if enabled by iyzico (email entegrasyon@iyzico.com). Formula, hex HMAC-SHA256 with key `secretKey`:
  - HPP: `secretKey + iyziEventType + iyziPaymentId + token + paymentConversationId + status`
  - Direct: `secretKey + iyziEventType + paymentId + paymentConversationId + status`
  (docs; yes, the secret is both the key and the first part of the message.)
- Treat the webhook as a hint; still call the retrieve endpoint. Idempotency: no request idempotency header; dedupe by our
  `conversationId` (guess).

### 1.6 Test data
- No public sandbox keys; sign up at https://sandbox-merchant.iyzipay.com (community).
- Success cards (docs: https://docs.iyzico.com/en/add-ons/test-cards): `5528790000000008` (Halkbank MC credit), `5526080000000006`,
  `4603450000000000`, `5890040000000016` (debit), `4766620000000001` (debit). Any future expiry, any CVC.
- Failure cards (docs): `4111111111111129` insufficient funds, `4129111111111111` do not honour, `4127111111111113` lost,
  `4126111111111114` stolen, `4125111111111115` expired, `4124111111111116` invalid CVC, `4121111111111119` fraud suspect,
  `4130111111111118` general error, `4151111111111112` 3DS initialize failed. `5406670000000009` succeeds but cannot be refunded.
- Sandbox 3DS page SMS code: `283126` (community; the docs page does not state it).

---

## 2. PayTR

Host `https://www.paytr.com` for both live and test; test transactions use `test_mode=1` while the store is in test or live mode (docs).
All requests are `application/x-www-form-urlencoded`. Token everywhere: `base64(HMAC_SHA256(key=merchant_key, <concat> + merchant_salt))`.

### 2.1 Hosted checkout (iFrame API) with 3DS
- Step 1 (server): `POST /odeme/api/get-token` (docs: https://dev.paytr.com/en/iframe-api/iframe-api-1-adim). Fields:
  `merchant_id, user_ip, merchant_oid` (unique, alphanumeric only, <= 64 - so no dashes in our ids), `email, payment_amount`
  (**integer kuruş**, 34.56 -> `3456`), `currency` (`TL`/`TRY`, `USD`, `EUR`, `GBP`, `RUB`), `user_basket`
  (`base64(JSON.stringify([["Hosting plan X","34.56",1]]))`), `no_installment` (`1`), `max_installment` (`0`), `user_name`,
  `user_address`, `user_phone`, `merchant_ok_url`, `merchant_fail_url`, `test_mode` (`0|1`), `debug_on` (`1` during integration),
  `timeout_limit` (min, default 30), `lang` (`tr|en`), `paytr_token`.
- `paytr_token` concat order (docs): `merchant_id + user_ip + merchant_oid + email + payment_amount + user_basket + no_installment +
  max_installment + currency + test_mode`, then `+ merchant_salt`, HMAC-SHA256 with `merchant_key`, base64.
- Response `{"status":"success","token":"..."}`; render `<iframe src="https://www.paytr.com/odeme/guvenli/{token}">` (+ their
  `iframeResizer.min.js`). It is an iframe, not a redirect; it can live on our own `/pay/:invoice` page.
- `merchant_ok_url` is just where the browser goes afterwards. It is **not** proof of payment (docs).
- The notification URL is set **in the PayTR merchant panel**, not per request (docs, step 2 page). One URL per store.

### 2.2 Result (notification / "Bildirim URL")
- PayTR POSTs (form) to the panel-configured URL: `merchant_oid, status` (`success|failed`), `total_amount` (kuruş, includes
  installment interest), `hash`, `payment_type` (`card|eft`), `currency`, `payment_amount`, `failed_reason_code`,
  `failed_reason_msg`, `test_mode`; Direct API with card storage adds `utoken` (docs: https://dev.paytr.com/en/iframe-api/iframe-api-2-adim).
- Verify: `hash == base64(HMAC_SHA256(merchant_key, merchant_oid + merchant_salt + status + total_amount))` (docs). Reject on mismatch.
- Must reply plain text `OK` (nothing else). No OK -> retried about every minute; transaction shows "in progress" in the panel (docs).
  Process only the first notification per `merchant_oid`; answer `OK` to repeats (docs). No session/auth on that URL.
- Optional server-side check: `POST /odeme/durum-sorgu` `{merchant_id, merchant_oid, paytr_token = base64(HMAC_SHA256(merchant_key,
  merchant_id + merchant_oid + merchant_salt))}` (community: mewebstudio; docs page https://dev.paytr.com/en/durum-sorgu not re-read).

### 2.3 Stored cards (CAPI, "kart saklama") and recurring
- Card storage is **Direct API only** (the card form is ours but posts straight from the browser to `https://www.paytr.com/odeme`; the
  docs warn never to route it through our server). The iFrame API docs mention no storage (docs:
  https://dev.paytr.com/en/direkt-api/kart-saklama-api/yeni-kart-ekleme). PCI: the form is on our page, so SAQ A-EP rather than SAQ A (guess).
- Direct API first payment with storage: browser form POST to `/odeme` with `merchant_id, user_ip, merchant_oid, email,
  payment_amount` (**decimal** here, `100.99`), `payment_type=card`, `installment_count=0`, `currency`, `test_mode`, `non_3d=0`,
  `merchant_ok_url, merchant_fail_url, user_name, user_address, user_phone, user_basket` (JSON, html-escaped, not base64),
  `cc_owner, card_number, expiry_month, expiry_year, cvv`, `store_card=1`, `utoken` (only if this user already has one), `paytr_token`
  (docs: https://dev.paytr.com/en/direkt-api/direkt-api-1-adim).
- Direct API `paytr_token` order (docs samples): `merchant_id + user_ip + merchant_oid + email + payment_amount + payment_type +
  installment_count + currency + test_mode + non_3d` + `merchant_salt`. The token is computed on our server and put in the hidden form.
- `utoken` arrives in the notification POST; save it on the user (docs). One utoken per user; send it with later `store_card` calls
  or cards end up under different users.
- List cards: `POST /odeme/capi/list` `{merchant_id, utoken, paytr_token = b64(HMAC(merchant_key, utoken + merchant_salt))}` ->
  array of `{ctoken, last_4, require_cvv, month, year, c_bank, c_name, c_brand, c_type, schema, ...}` (docs:
  https://dev.paytr.com/en/direkt-api/kart-saklama-api/kayitli-kart-listesi).
- Delete: `POST /odeme/capi/delete` `{merchant_id, ctoken, utoken, paytr_token = b64(HMAC(merchant_key, ctoken + utoken + merchant_salt))}` (community).
- Recurring charge (no customer): server POST to `/odeme` with the Direct API fields **minus card fields**, plus `utoken`, `ctoken`,
  `non_3d=1`, `recurring_payment=1` (docs: https://dev.paytr.com/en/direkt-api/kart-saklama-api/kayitli-kart-tekrarlayan-odeme).
  Response is synchronous JSON `{status: success|failed|wait_callback, msg, try_again}`; the notification URL also gets the result.
  `try_again=true` means "another transaction on this card is in flight, retry later".
- Rules: **non-3D must be enabled for the store by PayTR, only after their team approves** (docs, Direct API page). Cards with
  `require_cvv=1` cannot be charged unattended (docs, kayitli-karttan-odeme page) - fall back to a customer-present payment.
- Test a failing recurring charge: `non_3d=1, test_mode=1, non3d_test_failed=1` (docs).

### 2.4 Refund
- `POST /odeme/iade` `{merchant_id, merchant_oid, return_amount ("10.25"), paytr_token, reference_no?}`;
  token = `b64(HMAC(merchant_key, merchant_id + merchant_oid + return_amount + merchant_salt))` (docs: https://dev.paytr.com/en/iade-api).
  Partial allowed (repeat until the total is reached). Response `status: success|failed|error`, `err_no`, `err_msg`, `is_test`.
  Use `reference_no` = our refund row id for traceability (no documented idempotency; guess: a retried refund is a second refund).

### 2.5 Test data
- No public test merchant; every store gets test credentials in the panel ("Bilgi" page) (docs/community).
- Cards: `9792030394440796` (TEST KARTI, 12/99, CVV 000) is in the official Direct API sample (docs). `4355084355084358`,
  `5406675406675403` (12/30, 000) from community samples. Fail path for non-3D via `non3d_test_failed=1` (docs).
  3DS test page password: not found (unknown).

---

## 3. Stripe

Host `https://api.stripe.com`, test vs live by key prefix (`sk_test_` / `sk_live_`). Form-encoded, `Authorization: Bearer secretKey`.
All facts docs unless noted.

### 3.1 Hosted checkout with 3DS
- `POST /v1/checkout/sessions` with `mode=payment`, `line_items[0][price_data][currency]=try` (or `usd`, `eur`),
  `line_items[0][price_data][unit_amount]=<minor units>`, `line_items[0][price_data][product_data][name]=...`,
  `line_items[0][quantity]=1`, `success_url=https://.../pay/return?session_id={CHECKOUT_SESSION_ID}`, `cancel_url`,
  `client_reference_id=<invoice id>`, `metadata[invoice_id]`, `customer=<cus_...>` (create the Customer first so the card is attached),
  and to keep the card: `payment_intent_data[setup_future_usage]=off_session`
  (https://docs.stripe.com/api/checkout/sessions/create, https://docs.stripe.com/payments/save-during-payment).
- Redirect to the returned `url`. Stripe runs 3DS itself (SCA/3DS2 when the issuer asks).
- Card setup without a charge: `mode=setup` + `customer` (+ `currency`) (https://docs.stripe.com/payments/save-and-reuse).
- Stripe's native recurring alternative: `mode=subscription` with a Price; then Stripe Billing retries and dunning handle renewals
  (https://docs.stripe.com/billing/subscriptions/build-subscriptions). Simpler, but our panel already owns the billing schedule.

### 3.2 Result and verification
- Webhook `checkout.session.completed` (check `payment_status == "paid"`), plus `payment_intent.succeeded` / `payment_intent.payment_failed`.
- Signature: header `Stripe-Signature: t=<unix>,v1=<hex>[,v1=...]`; expected = `hex(HMAC_SHA256(webhookSecret, t + "." + rawBody))`;
  compare constant-time against any `v1`; reject if `|now - t| > 300 s` (https://docs.stripe.com/webhooks#verify-manually). Needs the
  **raw** request body (NestJS: `rawBody: true` in `NestFactory.create`).
- Or retrieve: `GET /v1/checkout/sessions/{id}?expand[]=payment_intent` on the success page.

### 3.3 Off-session charge
- `POST /v1/payment_intents` `amount, currency, customer, payment_method=<pm_...>, off_session=true, confirm=true,
  metadata[invoice_id]` with header `Idempotency-Key: <attempt id>` (https://docs.stripe.com/payments/save-and-reuse#charge-saved-payment-method).
- Get `payment_method` from the PaymentIntent of the first checkout or `GET /v1/customers/{id}/payment_methods?type=card`.
- Failure `card_error` with `code=authentication_required` -> the issuer wants 3DS: email the customer a link (new Checkout Session, or
  confirm the same PaymentIntent client-side). Other declines: `insufficient_funds` etc.

### 3.4 Refund
- `POST /v1/refunds` `payment_intent=<pi_...>` (full) or + `amount=<minor units>` (partial; repeatable) (https://docs.stripe.com/api/refunds/create).
  Event `charge.refunded` / `refund.updated`.

### 3.5 Webhooks, idempotency
- Live mode: retries with exponential backoff for up to 3 days; sandbox: 3 retries over a few hours. Events can arrive out of order
  and more than once; dedupe by `event.id` (https://docs.stripe.com/webhooks#retries, #handle-duplicate-events).
- `Idempotency-Key` header on every POST; keys kept at least 24 h (https://docs.stripe.com/api/idempotent_requests).

### 3.6 Test data (https://docs.stripe.com/testing)
- `4242424242424242` success, no auth. `4000002500003155` needs 3DS on setup, then off-session works. `4000002760003184` always needs
  3DS (off-session fails with `authentication_required`). `4000000000009995` insufficient funds. `4000000000000002` generic decline.
  `4000000000000341` attaches fine but fails on charge (good for renewal failures). Any future expiry, any CVC.
  3DS test page: click "Complete"/"Fail", no password. No public API keys (each account has its own `sk_test_`).

---

## 4. Param (TurkPos)

SOAP 1.1, namespace `https://turkpos.com.tr/`, every call carries `<G><CLIENT_CODE/><CLIENT_USERNAME/><CLIENT_PASSWORD/></G>` and
most also `<GUID>`. dev.param.com.tr returns 403 to scripts (bot protection), so the source is Param's **official** GitHub org
`PARAMPOS/nodejs-client` and `PARAMPOS/php-client` (sdk) plus mewebstudio/pos (community).

Hosts (sdk, `PARAMPOS/nodejs-client/example_code/*.js`):
- Payments test: `https://testposws.param.com.tr/turkpos.ws/service_turkpos_prod.asmx` (resolves the conflict noted in
  research-payments.md: Param's own samples use `testposws`; `payment-providers.ts` currently has `test-dmz...service_turkpos_test.asmx`
  from mewebstudio - **switch the test host to `testposws`**). Live: `https://posws.param.com.tr/turkpos.ws/service_turkpos_prod.asmx`.
- Card storage test: `https://testposws.param.com.tr/out.ws/service_ks.asmx`; live presumably `https://posws.param.com.tr/out.ws/service_ks.asmx` (guess).
- Hosted page (Ortak Ödeme) test: `https://testpos.param.com.tr/Tahsilat/to.ws/Service_Odeme.asmx`, live
  `https://pos.param.com.tr/Tahsilat/to.ws/Service_Odeme.asmx` (sdk + community).
- Public test credentials (sdk): CLIENT_CODE `10738`, CLIENT_USERNAME `Test`, CLIENT_PASSWORD `Test`, GUID `0c13d406-873b-403b-9c09-a5766840d98c`.

### 4.1 Hosted checkout options
- **Ortak Ödeme Sayfası** (redirect): `TO_Pre_Encrypting_OOS` with SOAP header `ServiceSecuritySoapHeader{CLIENT_CODE, CLIENT_USERNAME,
  CLIENT_PASSWORD}` and body `Borclu_Kisi_TC, Borclu_Aciklama ("r|text"), Borclu_Tutar ("r|10,00"), Borclu_GSM ("r|5555555555"),
  Borclu_Odeme_Tip ("r|"), Borclu_AdSoyad ("r|name"), Return_URL ("r|https://..."), Islem_ID, Taksit ("1"), Terminal_ID (= CLIENT_CODE)`.
  The `r|` prefix marks the field read-only on the page (guess from samples). Result string `s`; redirect to
  `https://testpos.param.com.tr/Tahsilat/Default.aspx?s=<result>` (live `https://pos.param.com.tr/Tahsilat/Default.aspx?s=`) (sdk: ortak_odeme.js).
  Amounts use a **comma** decimal separator. TRY only (guess). Requires our server IP registered with Param (community: bera65/frisay module).
- **TP_Modal_Payment** (iframe/modal): `d{GSM, Amount ("100,50"), Order_ID, TransactionId, Callback_URL, Installment, MaxInstallment}` (sdk iFrame.js).
  Response/callback fields not documented in the SDK (unknown).
- Return of the hosted page (Ortak Ödeme, 3D_HOST) POSTs `TURKPOS_RETVAL_Sonuc, TURKPOS_RETVAL_Sonuc_Str, TURKPOS_RETVAL_GUID,
  TURKPOS_RETVAL_Islem_Tarih, TURKPOS_RETVAL_Dekont_ID, TURKPOS_RETVAL_Tahsilat_Tutari, TURKPOS_RETVAL_Odeme_Tutari,
  TURKPOS_RETVAL_Siparis_ID, TURKPOS_RETVAL_Islem_ID, TURKPOS_RETVAL_Hash, ...`. Verify:
  `TURKPOS_RETVAL_Hash == base64(SHA1(CLIENT_CODE + TURKPOS_RETVAL_GUID + TURKPOS_RETVAL_Dekont_ID + TURKPOS_RETVAL_Tahsilat_Tutari +
  TURKPOS_RETVAL_Siparis_ID + TURKPOS_RETVAL_Islem_ID))` (community: mewebstudio `ParamPosCrypt::check3DPayOr3DHostHash`). Success = `Sonuc > 0`.

### 4.2 Direct 3D (our card form, card data passes our server - PCI scope)
- `TP_WMD_UCD`: `KK_Sahibi, KK_No, KK_SK_Ay, KK_SK_Yil, KK_CVC, KK_Sahibi_GSM, Hata_URL, Basarili_URL, Siparis_ID, Siparis_Aciklama,
  Taksit, Islem_Tutar ("100,00"), Toplam_Tutar, Islem_Guvenlik_Tip ("3D"|"NS"), Islem_ID, IPAdr, Ref_URL, Data1..Data5, Islem_Hash` (sdk).
- `Islem_Hash = base64(SHA1(ISO-8859-9 bytes of CLIENT_CODE + GUID + Taksit + Islem_Tutar + Toplam_Tutar + Siparis_ID))` (sdk
  `Hash.SHA2B64` - despite the name it is SHA-1). Note Param's sample appends `"|SDK_NODEJS_..."` to `Islem_ID`; we don't need to.
- Response `UCD_HTML` (auto-submitting bank form, write it to the browser) / `UCD_MD`, `Islem_GUID`. Bank POSTs back to `Basarili_URL`
  with `md, mdStatus, orderId, transactionAmount, islemGUID, islemHash, ...`; verify
  `islemHash == base64(SHA1(islemGUID + md + mdStatus + orderId + GUID))` (community: mewebstudio `check3DHash`), require `mdStatus == 1`,
  then complete with `TP_WMD_Pay {UCD_MD, Islem_GUID, Siparis_ID}` (sdk threds_tamamla.js). `NS` skips the completion step (sdk comment).
- FX: `TP_Islem_Odeme_WD` adds `Doviz_Kodu` (`1001` USD, `1002` EUR, `1003` GBP); hash = `CLIENT_CODE + GUID + Islem_Tutar +
  Toplam_Tutar + Siparis_ID + Hata_URL + Basarili_URL` (no Taksit) (sdk + community).

### 4.3 Stored cards
- Store: `KS_Kart_Ekle {KK_Sahibi, KK_No, KK_SK_Ay, KK_SK_Yil, KK_Kart_Adi, KK_Islem_ID}` on `service_ks.asmx` -> returns `KS_GUID` (sdk).
  This takes the PAN on our server. Older equivalent: `KK_Saklama` on the main service (sdk WSDL references in PARAMPOS samples).
  Whether the Ortak Ödeme page can store a card for us: not found (unknown) - ask Param.
- List `KS_Kart_Liste`, delete `KS_Kart_Sil` (sdk method names; fields not read).
- Charge: `KS_Tahsilat {KS_GUID, CVV, KK_Sahibi_GSM, Hata_URL, Basarili_URL, Siparis_ID, Siparis_Aciklama, Taksit, Islem_Tutar,
  Toplam_Tutar, Islem_Guvenlik_Tip ("3D"|"NS"), Islem_ID, IPAdr, Ref_URL, Data1..Data4, KK_Islem_ID}` (sdk). The SDK sends no hash for
  this call and passes `CVV` - whether an unattended `NS` charge can omit CVV is unknown; `NS` needs Param to enable non-3D on the
  terminal (guess, standard).

### 4.4 Refund, query
- `TP_Islem_Iptal_Iade_Kismi2 {Durum: "IPTAL"|"IADE", Siparis_ID, Tutar ("1.00")}` (sdk). IPTAL = same-day void, IADE = (partial) refund.
  Note the sample uses a **dot** decimal here, unlike payments (sdk; verify).
- Query: `TP_Islem_Sorgulama4 {Dekont_ID, Siparis_ID, Islem_ID}` (sdk) - use it to confirm a payment server-side.
- Results: `Sonuc` (> 0 success), `Sonuc_Str`.

### 4.5 Webhooks / test cards
- No webhook found; the browser return is the only push. If the customer closes the tab after paying, only `TP_Islem_Sorgulama4`
  reveals the payment -> poll pending attempts (guess).
- Test cards (sdk examples): `5571135571135575` 12/26 CVC 000 (3D sample), `4546711234567894` 12/2026 000 (FX sample),
  `5200190006338608` 01/30 (storage sample); `5456165456165454` 12/26 000 (community). 3D SMS code: unknown.

---

## 5. Craftgate

Hosts: live `https://api.craftgate.io`, sandbox `https://sandbox-api.craftgate.io`. Auth headers as in `payment-providers.ts`
(`x-api-key`, `x-rnd-key`, `x-auth-version: 1`, `x-signature = base64(SHA256(decodeURIComponent(fullUrl) + apiKey + secretKey + rnd + body))`).
Docs are behind a sandbox login, so everything here is **sdk** (`craftgate/craftgate-node-client`) unless noted.
Optional header `x-idempotency-key` on mutating calls: the server returns the first result for a repeated key (sdk README).

### 5.1 Hosted checkout (Ortak Ödeme Formu)
- `POST /payment/v1/checkout-payments/init` `{price, paidPrice, currency ("TRY"|"USD"|"EUR"|...), paymentGroup
  ("LISTING_OR_SUBSCRIPTION"), conversationId, externalId?, orderId?, callbackUrl, items:[{name, price, externalId}], enabledInstallments?
  ([1]), forceThreeDS? (true), cardUserKey?, alwaysStoreCardAfterPayment?, allowOnlyStoredCards?, clientIp?, ttl?}`.
  Buyer identity is **not** required (unlike iyzico); `buyerMemberId` is optional.
- Response `{token, pageUrl, tokenExpireDate}` - redirect to `pageUrl`.
- Return: browser is sent to `callbackUrl` (form POST, contents not visible in SDK; community/search says the callback must be verified
  per "Hash Value Generation and Control"). Do not depend on it: `GET /payment/v1/checkout-payments/{token}` returns the full
  `PaymentResponse` (`id, paymentStatus ("SUCCESS"), price, paidPrice, currency, conversationId, cardUserKey, cardToken, paymentTransactions[]...`).
- Card verify without charge (stores a card through the hosted page): `POST /payment/v1/checkout-card-verify/init`, then
  `GET /payment/v1/checkout-card-verify/{token}` (sdk) - the cleanest PCI-free "add card" flow of all five providers.
- Own-form 3DS (not needed if using the hosted form): `/payment/v1/card-payments/3ds-init` -> `htmlContent`; bank callback POSTs
  `status, completeStatus, paymentId, conversationData, conversationId, callbackStatus, hash`; verify
  `hash == hex(SHA256([threeDSecureCallbackKey, status, completeStatus, paymentId, conversationData, conversationId, callbackStatus].join("###")))`
  where `threeDSecureCallbackKey` is a merchant-panel value (sdk `is3DSecureCallbackVerified`) - **a third secret we do not store yet**;
  then `/payment/v1/card-payments/3ds-complete {paymentId}`.

### 5.2 Stored cards and merchant-initiated charge
- During checkout: `alwaysStoreCardAfterPayment: true` (+ `cardUserKey` for an existing customer); read `cardUserKey`/`cardToken` from
  the retrieve. Own form: `card.storeCardAfterSuccessPayment: true`. Direct: `POST /payment/v1/cards` (PAN on our server - avoid).
  Search `GET /payment/v1/cards?cardUserKey=...`, delete `POST /payment/v1/cards/delete {cardUserKey, cardToken}`.
- Non-3D charge: `POST /payment/v1/card-payments {price, paidPrice, walletPrice: 0, installment: 1, currency, paymentGroup,
  conversationId, card: {cardUserKey, cardToken}, items:[...]}` -> synchronous `PaymentResponse` (sdk sample CreatePaymentUsingStoredCard.js).
  Send `x-idempotency-key` = our attempt id.
- Rules: Craftgate routes to the merchant's own bank POSes; a non-3D charge needs a POS defined/allowed for non-3D in the Craftgate panel
  (guess). If refused, use `init3DSPayment` with the stored card and a customer link.

### 5.3 Refund
- Whole payment: `POST /payment/v1/refunds {paymentId, conversationId?, refundDestinationType ("PROVIDER")}`.
- Partial: `POST /payment/v1/refund-transactions {paymentTransactionId, refundPrice, refundDestinationType}` (one item per invoice ->
  one transaction id). Both sdk.

### 5.4 Webhooks
- Configured in merchant panel; JSON POST; with the checkout form only `CHECKOUTFORM_AUTH` is sent (community: search snippet of
  https://developer.craftgate.io/en/webhook/transaction-webhook). Events: `API_AUTH, API_VERIFY_AND_AUTH, CHECKOUTFORM_AUTH,
  THREEDS_VERIFY, REFUND, REFUND_TX, ...` (sdk enum).
- Payload `{eventType, eventTime, eventTimestamp, status ("SUCCESS"|"FAILURE"), payloadId}` (sdk `WebhookData`); for checkout,
  `payloadId` is presumably the token, otherwise the payment id (guess). Retrieve the payment by it.
- Signature: `base64(HMAC_SHA256(merchantHookKey, eventType + eventTimestamp + status + payloadId))` (sdk `HookAdapter`). Header name
  not in the SDK (unknown; read it from the first real delivery). `merchantHookKey` is another panel secret.
- Retry policy: unknown (docs behind login).

### 5.5 Test data
- No public keys; sandbox panel account needed. Test cards seen in SDK tests: `5258640000000001` (most used), `5406670000000009`,
  `5400010000000004`, `4043080000000003` (sdk tests; outcomes not documented). 3DS sandbox password unknown.

---

## 6. Cross-provider implementation notes

- **Amount formats differ:** iyzico decimal (`"99.9"`), PayTR iFrame integer kuruş but PayTR Direct/refund decimal with dot,
  Stripe integer minor units, Param comma decimal (`"99,90"`) for payments, Craftgate number. Keep one `amountMinor: bigint` in the DB and
  format at the edge with a per-provider function (each one gets a unit test with the samples above).
- **Order id constraints:** PayTR alphanumeric <= 64; use a UUID without dashes or a numeric attempt id everywhere.
- **Secrets we will need in addition to today's fields:** Stripe `webhookSecret` (already a field), Craftgate `merchantHookKey` and
  `threeDSecureCallbackKey` (new, only if webhooks/own-form 3DS are used). PayTR/iyzico/Param reuse existing secrets.
- **Callback URLs:** PayTR's notification URL is a single panel setting per store (docs) - document it in the admin UI. iyzico webhook
  URL is also a panel setting. iyzico/Craftgate/Stripe/Param browser return URLs are per request.
- **Buyer data we must collect for iyzico:** TCKN (or the `11111111111` placeholder for foreigners - community), phone, address, city,
  country, IP. PayTR needs name, address, phone, IP, e-mail. Craftgate and Stripe need none beyond e-mail.
- **Recurring state machine (suggested):** `due -> charging -> paid | needs_action (3DS/CVV/no permission) | failed (decline) -> retry
  after N days -> suspended`. `needs_action` sends the hosted-checkout link via the notify.ts catalog.

## 7. Sources
- iyzico: https://docs.iyzico.com/en/payment-methods/checkoutform/cf-implementation/cf-initialize,
  https://docs.iyzico.com/en/payment-methods/checkoutform/cf-implementation/cf-retrieve, https://docs.iyzico.com/en/advanced/webhook,
  https://docs.iyzico.com/en/add-ons/test-cards, SDK https://github.com/iyzico/iyzipay-php (samples/, src/Iyzipay/Model, Request).
- PayTR: https://dev.paytr.com/en/iframe-api/iframe-api-1-adim, https://dev.paytr.com/en/iframe-api/iframe-api-2-adim,
  https://dev.paytr.com/en/direkt-api/direkt-api-1-adim, https://dev.paytr.com/en/direkt-api/kart-saklama-api/yeni-kart-ekleme,
  https://dev.paytr.com/en/direkt-api/kart-saklama-api/kayitli-kart-listesi,
  https://dev.paytr.com/en/direkt-api/kart-saklama-api/kayitli-kart-tekrarlayan-odeme,
  https://dev.paytr.com/en/direkt-api/kart-saklama-api/kayitli-karttan-odeme, https://dev.paytr.com/en/iade-api.
- Stripe: https://docs.stripe.com/api/checkout/sessions/create, https://docs.stripe.com/payments/save-and-reuse,
  https://docs.stripe.com/payments/save-during-payment, https://docs.stripe.com/webhooks, https://docs.stripe.com/api/idempotent_requests,
  https://docs.stripe.com/api/refunds/create, https://docs.stripe.com/testing. (Written from these docs' known content; not re-fetched today.)
- Param: https://github.com/PARAMPOS/nodejs-client (src/services, src/types, example_code), https://github.com/PARAMPOS/php-client,
  https://github.com/mewebstudio/pos (src/Crypt/ParamPosCrypt.php, config/pos_test.php). dev.param.com.tr pages exist
  (https://dev.param.com.tr/en/api/kart-saklama, .../kart-saklamali-odeme) but block scripted access.
- Craftgate: https://github.com/craftgate/craftgate-node-client (src/adapter/PaymentAdapter.ts, HookAdapter.ts, src/lib/utils.ts,
  src/request/*, samples/payment/*, README idempotency section), https://developer.craftgate.io (login required).
