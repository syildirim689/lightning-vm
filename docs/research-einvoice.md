# e-Fatura / e-Arşiv: legal essentials and integrator APIs

Date: 2026-10-27. Scope: issuing Turkish e-Fatura and e-Arşiv invoices for hosting/VM subscriptions through a GİB-authorized
private integrator (özel entegratör). Companion to [research-payments.md](research-payments.md) and
[research-payment-flows.md](research-payment-flows.md).

Confidence tags:
- **official**: read in a GİB document (ebelge.gib.gov.tr) or in the integrator's own docs / live WSDL / OpenAPI (URL given).
- **sdk**: the integrator's own sample repo on GitHub.
- **community**: third-party library, blog or search result.
- **guess**: my inference; verify with a sandbox call before shipping.

"Live WSDL" means I downloaded the WSDL/XSD from the URL on 2026-10-27 and read the operation and type names from it, so the
names are exact. The *behaviour* behind an operation is a separate question and is tagged on its own.

---

## 0. Decisions this research supports (read first)

1. **Integrators don't make us write UBL.** Nilvera (JSON model), Uyumsoft (`InvoiceScenarioChoosen=Automated`), BirFatura
   (`SendBasicInvoiceFromModel`) and Paraşüt (JSON:API sales invoice) all build the UBL-TR XML for us. EDM, QNB eFinans and
   İzibiz expect **UBL-TR XML that we build**, sent as base64/zip inside SOAP. If we want to support more than one integrator,
   the cheapest shared core is our own `Invoice` model plus **one UBL-TR 1.2 serializer** (section 1.1). JSON-model providers then
   get the model and XML providers get the serialized XML.
2. **Routing rule per invoice:** buyer VKN/TCKN → integrator "is e-Fatura user?" call → if yes, e-Fatura (`TEMELFATURA` or
   `TICARIFATURA`) to its `urn:mail:...pk` alias; if no, `EARSIVFATURA`. Cache the answer briefly but **re-check at issue time**,
   because users join the list every day (official, GİB UserList guide).
3. **Use TEMELFATURA for B2B by default.** TICARIFATURA gives the buyer 8 days to reject through the system (`RED` application
   response), which turns a paid invoice into "cancelled" without our involvement. Hosting does not need that (official,
   e-Fatura iptal guide).
4. **Hosting is sold over the internet, so every e-Arşiv invoice is an "internet satışı" invoice:** delivery type ELEKTRONIK,
   web address, payment method (`KREDIKARTI/BANKAKARTI`, `EFT/HAVALE`, `ODEMEARACISI`...), payment date, payment intermediary
   (iyzico/PayTR...) and the note "Bu satış internet üzerinden yapılmıştır." (official, 509 Tebliğ IV.2.4.5 and e-Arşiv Teknik Kılavuz V1.19 §3.3.2.17).
5. **Cancellation is time-boxed (8 days) and never deletes.** e-Arşiv: we cancel through the integrator within 8 days of delivery
   to the buyer. e-Fatura: no seller-side cancel after delivery. Use an IADE (return) invoice, or the GİB İptal/İtiraz portal within 8 days.
   The panel must model `cancelled` and `refunded-by-IADE` as states, not deletes.
6. **Recommended first integrator: Nilvera** (only one with a public, machine-readable REST/OpenAPI spec, Bearer API key, separate
   test host, JSON model including `InternetInfo`). Second choice for a SOAP shop with a public sandbox: **Uyumsoft** or **İzibiz**
   (public test users exist, see sections 2.3 and 2.7).

---

## 1. Legal and format essentials

Primary sources (all official, downloaded 2026-10-27):
- e-Fatura mevzuat page with all guides: https://ebelge.gib.gov.tr/efaturamevzuat.html
- UBL-TR guides zip: https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/Ek-4UBL-TRKilavuzlari_V-1.2.zip
- e-Fatura package (XSD, **schematron**, sample XMLs incl. `1_TEMEL_FATURA.xml`, `7_TEMEL_FATURA_IADE.xml`, `6_TEMEL_FATURA_KDV_SIFIR.xml`):
  https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/e-FaturaPaketi%20(29).zip. The schematron (`UBL-TR_Common_Schematron.xml`,
  `UBL-TR_Codelist.xml`) is the real validator. Run it in CI against our serializer.
- e-Arşiv mevzuat page: https://ebelge.gib.gov.tr/earsivmevzuat.html
- e-Arşiv Teknik Kılavuzu V1.19 (Oct 2026): https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/e-Arsiv_Teknik_Kilavuzu_V.1.19.pdf
- 509 Sıra No.lu VUK Genel Tebliği (annotated current text): https://ebelge.gib.gov.tr/dosyalar/tebligler/Dipnotlu_Guncel_Sekli_ile_509_Sira_No'lu_VUK_Genel_Tebligi.pdf
- e-Fatura İptal/İhtar/İtiraz guide V1.2: https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/e-Fatura_Iptal_Ihtar_Itiraz_Bildirim_Kilavuzu_V_1.2.pdf
- e-Arşiv İptal/İhtar/İtiraz guide V1.1: https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/e-Arsiv_Uygulamalari_Iptal_Ihtar_Itiraz_Bildirim_Kilavuzu_V.1.1.pdf
- İnternet Satış Rehberi: https://ebelge.gib.gov.tr/dosyalar/Internet_Satis_Rehberi.pdf
- UserList guide: https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/UserList_(Kullanici_Listeleri)_Kilavuzu_V.1.1.pdf

### 1.1 UBL-TR 1.2 `Invoice`: elements we must produce

Order matters (XSD sequence). Values from the GİB schematron unless tagged otherwise.

| Element | Rule | Conf. |
|---|---|---|
| `cbc:UBLVersionID` | `2.1` | official |
| `cbc:CustomizationID` | `TR1.2` | official |
| `cbc:ProfileID` | e-Fatura: `TEMELFATURA`, `TICARIFATURA`, `IHRACAT`, `YOLCUBERABERFATURA`, `OZELFATURA`, `KAMU`, `HKS`, `ENERJI`, `ILAC_TIBBICIHAZ`, `YATIRIMTESVIK`, `IDIS`. e-Arşiv: only `EARSIVFATURA` (schematron `ProfileIDType` / `ProfileIDTypeEarchive`). We need TEMELFATURA, TICARIFATURA (if a customer insists), EARSIVFATURA. `KAMU` only if we invoice public bodies. | official |
| `cbc:ID` | 16 chars, regex `^[A-Z0-9]{3}20[0-9]{2}[0-9]{9}$` = 3-char series + 4-digit year + 9-digit sequence, e.g. `LVM2026000000001`. Integrators can assign it (Nilvera `InvoiceSerieOrNumber`, BirFatura `IsDocumentNoAuto`, QNB `faturaNoUret`, EDM/İzibiz serial on the portal). Sequence restarts each year; numbers must be consecutive per series without gaps (community; VUK sıra no rule). Use **separate series for e-Fatura and e-Arşiv** (common practice; integrators enforce per-series counters). | official (regex) / community (gaps) |
| `cbc:CopyIndicator` | must be `false` | official |
| `cbc:UUID` | ETTN, a UUID v4 that we generate. It is our idempotency key with every integrator. | official |
| `cbc:IssueDate` / `cbc:IssueTime` | date `YYYY-MM-DD`; time `HH:mm:ss` (IssueTime optional in XSD; integrators/e-Arşiv expect it) | official / community |
| `cbc:InvoiceTypeCode` | `SATIS`, `IADE`, `TEVKIFAT`, `TEVKIFATIADE`, `ISTISNA`, `OZELMATRAH`, `IHRACKAYITLI`, `SGK`, `KOMISYONCU`, `KONAKLAMAVERGISI`, `TEKNOLOJIDESTEK`, YTB*/HKS*/SARJ* (schematron `InvoiceTypeCodeList`). We need `SATIS`, `IADE`, `ISTISNA` (export of services). | official |
| `cbc:Note` | 0..n free text. Put "Bu satış internet üzerinden yapılmıştır." here for e-Arşiv internet sales; amount in words is also customary. | official (509) / community |
| `cbc:DocumentCurrencyCode` | ISO 4217 (`TRY`, `USD`, `EUR`). Non-TRY needs `cac:PricingExchangeRate` and the TRY equivalent per integrator rules. | official |
| `cbc:LineCountNumeric` | number of `InvoiceLine`s | official |
| `cac:BillingReference/cac:InvoiceDocumentReference` | **required on IADE**: `cbc:ID` of the original 16-char invoice + `cbc:IssueDate` (schematron counts 16-char IDs) | official |
| `cac:AdditionalDocumentReference` | carries the XSLT (`DocumentTypeCode=XSLT`, base64 attachment) and, for e-Arşiv, the send type (`ELEKTRONIK`/`KAGIT`). Integrators inject their own XSLT if absent. | community |
| `cac:Signature` | integrator signs with its mali mühür. We still emit a `cac:Signature` with `cbc:ID schemeID="VKN_TCKN"` = our VKN (schematron: 10 or 11 digits). | official |
| `cac:AccountingSupplierParty/cac:Party` | `cac:PartyIdentification/cbc:ID schemeID="VKN"` (10 digits) **or** `schemeID="TCKN"` (11 digits), never both. With TCKN a `cac:Person` with `cbc:FirstName` + `cbc:FamilyName` is mandatory. Plus `cac:PartyName/cbc:Name`, `cac:PostalAddress` (`cbc:StreetName`, `cbc:BuildingNumber`, `cbc:CitySubdivisionName` = ilçe, `cbc:CityName` = il, `cbc:PostalZone`, `cac:Country/cbc:Name`), `cac:PartyTaxScheme/cac:TaxScheme/cbc:Name` = **vergi dairesi**, `cac:Contact` (phone, e-mail), `cbc:WebsiteURI` (our site; needed for internet sales). Other IDs (`MERSISNO`, `TICARETSICILNO`) optional. | official |
| `cac:AccountingCustomerParty/cac:Party` | same structure. Company: VKN (10) + `PartyName` + tax office. Individual: TCKN (11) + `Person` first/family name. | official |
| `cac:PaymentMeans` | optional in UBL; `cbc:PaymentMeansCode` (UN/ECE 4461, e.g. `48` card, `42` bank transfer, `ZZZ` other), `cbc:PaymentDueDate`. For e-Arşiv internet sales the integrator maps its own fields into the e-Arşiv report (see 1.2). | community |
| `cac:TaxTotal` | `cbc:TaxAmount` + one `cac:TaxSubtotal` per rate: `cbc:TaxableAmount`, `cbc:TaxAmount`, `cbc:Percent`, `cac:TaxCategory/cac:TaxScheme/cbc:Name` = `KDV`, `cbc:TaxTypeCode` = **`0015`** (KDV). If percent is 0, `cac:TaxCategory/cbc:TaxExemptionReasonCode` + `cbc:TaxExemptionReason` are mandatory (schematron rule on 0015). | official |
| `cac:LegalMonetaryTotal` | `cbc:LineExtensionAmount` (sum of lines excl. tax), `cbc:TaxExclusiveAmount`, `cbc:TaxInclusiveAmount`, `cbc:AllowanceTotalAmount` (opt.), `cbc:PayableAmount`. All with `currencyID`. Round to 2 decimals per line, then sum (integrators reject 0.01 mismatches). | official / community (rounding) |
| `cac:InvoiceLine` | `cbc:ID` (1..n), `cbc:InvoicedQuantity unitCode="C62"` (piece; `MON` month is also in the code list; verify per integrator), `cbc:LineExtensionAmount`, optional `cac:AllowanceCharge`, `cac:TaxTotal` (same 0015 subtotal per line), `cac:Item/cbc:Name`, `cac:Price/cbc:PriceAmount`. | official / guess (unit code choice) |

KDV rates in force: 0, 1, 10, **20** (general rate raised from 18% to 20% on 10 July 2023 by Presidential Decree 7346). **Hosting /
cloud / VPS services are not in any reduced-rate list, so they are 20%** (community; no reduced-rate list mentions them). Nilvera's
model still carries legacy `GeneralKDV8Total`/`GeneralKDV18Total` fields. Ignore them.

### 1.2 e-Arşiv specifics

- **Who gets e-Arşiv:** once we're an e-Fatura user, every invoice to a buyer who is *not* on the GİB e-Fatura user list
  (individuals, non-registered companies, foreigners) must be e-Arşiv; paper is not allowed (official, 509 Tebliğ IV/V).
  Since 2026-01-01, even businesses outside e-Belge must issue e-Arşiv for all invoices regardless of amount (official, 509 footnotes via 573/589 Tebliğ).
- **Internet sales (our case)** must be *delivered electronically* and must carry (official, 509 IV.2.4.5; Teknik Kılavuz §3.3.2.17):
  web address (`webAdresi`), payment method (`odemeSekli`: `KREDIKARTI/BANKAKARTI`, `EFT/HAVALE`, `KAPIDAODEME`, `ODEMEARACISI`,
  `DIGER-<açıklama>`), payment date (`odemeTarihi`), payment intermediary name (`odemeAracisiAdi`, e.g. "iyzico"), and for goods
  only the carrier's name and VKN/TCKN (not applicable to hosting). Plus the note "Bu satış internet üzerinden yapılmıştır."
  These live in the **e-Arşiv report** (`internetSatisBilgi`) the integrator sends to GİB. We pass them through the integrator's
  fields (Nilvera `InternetInfo`, Uyumsoft `InternetSalesInfo`, EDM `INTERNETSALESDETAILS`, İzibiz `EARSIV_PROPERTIES`,
  Paraşüt `internet_sale`), not as raw UBL.
- **Delivery type:** `ELEKTRONIK` (e-mail/portal link) vs `KAGIT`. Ours is always `ELEKTRONIK` (official, Teknik Kılavuz `gonderimSekli`).
- **Unknown TCKN:** individuals who don't give a TCKN are invoiced with `11111111111`; foreign buyers without a Turkish tax ID
  commonly with VKN `2222222222` (community; widely used by integrators and accounting software, but the strings do not appear in the
  V1.19 Teknik Kılavuz or the 509 text I searched). Confirm with the chosen integrator's validation.
- **Reporting:** the integrator signs and reports e-Arşiv invoices and cancellations to GİB. The e-Arşiv report runs daily, by the end of
  the day after creation (community; GİB announcement 30/10/2018; EDM exposes `EARCHIVE_REPORT_STATUS`, Nilvera `ReportStatus`,
  QNB `raporDurumSorgula`). We don't build reports. We poll status and alert if an invoice stays `NotReported` > 2 days.
- **`tesisatNumarasi`:** subscription-based sellers (telecom, internet subscriptions...) must fill the subscriber/line number
  (official, Teknik Kılavuz §3.3.2.16.3). Hosting is arguably not "abonelik esaslı fatura" in that sense (guess). Putting the
  service/VM id there is harmless if the integrator exposes the field.

### 1.3 e-Fatura vs e-Arşiv decision (mükellef sorgusu)

- GİB publishes the **registered user list** (VKN/TCKN, title, aliases `urn:mail:...` for PK = posta kutusu (receiver) and GB =
  gönderici birim (sender), document type, first-registration time). Integrators mirror it and expose a lookup (official, UserList guide).
- A buyer can have several PK aliases. Default to the first/`defaultpk` alias, and let the customer pick in billing settings.
- Being registered is per VKN *and* per document type (`Invoice` vs `DespatchAdvice`). Query for invoices (Nilvera `globalUserType=Invoice`).

### 1.4 Cancellation and objection

| Case | Rule | Conf. |
|---|---|---|
| e-Arşiv, seller cancels | Allowed through the integrator; the cancellation goes into the e-Arşiv report. GİB: cancel/objection only within **8 days from delivery to the buyer** (TTK 21/2). The 8-day count always starts at delivery. | official (e-Arşiv iptal guide V1.1, §2) |
| e-Arşiv, buyer objects | Noter, taahhütlü mektup, telgraf or KEP within 8 days, then reported to GİB via the İptal/İtiraz portal. | official |
| e-Fatura TEMELFATURA | No in-system response. After delivery, the seller can't cancel through the integrator. Options: (a) **IADE invoice** (for a refund; with an e-Fatura buyer, the buyer issues the IADE to us), (b) **e-Fatura İptal/İtiraz Portalı** (ebelge.gib.gov.tr): seller or buyer opens a cancel request with mali mühür/e-imza within 8 days, and the other party approves. The system refuses after 8 days. | official (e-Fatura iptal guide V1.2) |
| e-Fatura TICARIFATURA | Buyer sends KABUL or RED application response within 8 days. A RED means the invoice is void. After 8 days there's no in-system rejection; only external objection (KEP/noter) plus portal notification. | official |
| Since 2021-05-01 | All cancellations and external objections must also be notified to GİB electronically (509 V.10). | official |

Practical rule for the panel: **refund before day 8 → e-Arşiv cancel (via API) or e-Fatura portal cancel (manual); after day 8 → IADE**
(for an e-Fatura buyer, the IADE comes *from the buyer*; we can only record it). Guess, but follows from the rules above.

### 1.5 Timing (7-day rule)

VUK md. 231/5: the invoice must be issued **within 7 days** of the delivery of goods or the performance of the service, at most;
otherwise it's treated as not issued (law text, Law 213; https://www.mevzuat.gov.tr/mevzuatmetin/1.4.213.pdf, which did not respond
from here, so the rule is cited from memory and widely restated). For prepaid monthly
hosting, issue on payment (the service period starts then). For postpaid usage, issue within 7 days of period end. **Integrators also
reject IssueDate too far in the past/future.** e-Arşiv tolerates a backdate only within the 7-day window. Leave clocks alone and
always send "today".

### 1.6 Foreign customers (hizmet ihracı)

- KDV Kanunu 11/1-a: services rendered to a customer abroad **and used abroad** are exempt (hizmet ihracı). The invoice is in the
  foreign customer's name, and the payment normally comes in foreign currency. The KDV Genel Uygulama Tebliği lets you declare the
  exemption in the period of service without waiting for the money (community: https://www.muhasebetr.com/yazarlarimiz/ismail/028/ ;
  GİB özelge examples https://www.lexpera.com.tr/mevzuat/ozelgeler/45404237-130-i-21-410-72973-sayili-ozelge-1).
- Encoding: foreign buyers aren't on the e-Fatura list → **e-Arşiv, `InvoiceTypeCode=ISTISNA`, KDV 0015 at 0% with
  `TaxExemptionReasonCode=302`** ("11/1-a Hizmet İhracatı"; 301 is mal ihracatı) + reason text "3065 sayılı KDV Kanunu 11/1-a
  maddesi gereğince KDV'den istisnadır" (code list membership official from schematron; 301/302 meanings community). `IHRACAT`
  profile is for goods with customs (GTB) declarations, so don't use it for services (community).
- Whether a hosted VM used by a foreign customer is "used abroad" is a tax judgement (the özelges are mixed for servers located in
  Turkey). **Have the accountant confirm before enabling 0% for foreign customers.** Until then, invoice foreigners at 20%.

---

## 2. Integrator APIs

Common pattern: the integrator assigns or validates the 16-char number, signs, delivers (e-Fatura via GİB to buyer alias; e-Arşiv
via e-mail/portal), reports e-Arşiv, and returns status. Every call below is keyed by our ETTN (UUID).

### 2.1 Nilvera (REST, OpenAPI) — recommended

Docs index: https://developer.nilvera.com/llms.txt (each page embeds the OpenAPI JSON). All endpoint lines below were read from
those OpenAPI blocks (official).

- **Base URLs:** live `https://api.nilvera.com`, test `https://apitest.nilvera.com` (official, developer.nilvera.com). Both answered
  401 to unauthenticated calls on 2026-10-27.
- **Auth:** `Authorization: Bearer <API key>`. The key is a persisted access token created in the Nilvera portal, with chosen scopes and
  expiry. Test and live keys/companies are separate (official).
- **Sandbox:** a separate test environment exists. Credentials come from a Nilvera account; no public shared test user is published (official).

| Need | Call | Notes |
|---|---|---|
| (a) is e-Fatura user + alias | `GET /general/GlobalCompany/Check/TaxNumber/{TaxNumber}?globalUserType=Invoice` → array of `{TaxNumber, Title, Name (=alias), Type, DocumentType, FirstCreatedTime, CreationTime}` | empty array ⇒ not registered ⇒ e-Arşiv. Also `GET /general/GlobalCompany/GetGlobalCustomerInfo/{TaxNumber}` returns title, tax office, address (useful to prefill billing). |
| (b) send e-Fatura | `POST /einvoice/Send/Model` body `{ "EInvoice": EInvoiceDto, "CustomerAlias": "urn:mail:...pk" }` or `POST /einvoice/Send/Xml?Alias=...&TemplateUUID=...` multipart `file` (UBL XML or zip) | returns `{UUID, InvoiceNumber}`. `EInvoiceDto = {InvoiceInfo{UUID, InvoiceType, InvoiceSerieOrNumber, IssueDate, CurrencyCode, ExchangeRate, InvoiceProfile, ...}, CompanyInfo, CustomerInfo, InvoiceLines[{Name, Quantity, UnitType, Price, KDVPercent, KDVTotal, Taxes[]...}], Notes[]}`. Preview endpoints exist (`.../Send/Model` preview + PDF of preview). |
| (c) send e-Arşiv | `POST /earchive/Send/Model` body `{ "ArchiveInvoice": {InvoiceInfo, CompanyInfo, CustomerInfo, InvoiceLines, Notes} }` or `POST /earchive/Send/Xml` multipart | `ArchiveInvoiceInfoDto` has `SalesPlatform` (`NORMAL`/`INTERNET`), `SendType` (`KAGIT`/`ELEKTRONIK`), `InternetInfo{WebSite, PaymentMethod, PaymentMethodName, PaymentAgentName, PaymentDate, Transporter*}`, `TaxExemptionReasonInfo`, `ReturnInvoiceInfo[]` (for IADE). |
| (d) status | e-Fatura `GET /einvoice/Sale/{UUID}/Status` → `{InvoiceProfile, Answer, InvoiceStatus{Code: unknown/waiting/succeed/error, Description, DetailDescription}, EnvelopeInfo}`; e-Arşiv `GET /earchive/Invoices/{UUID}/Status` → `{StatusCode, StatusDetail, ReportStatus: NotReported/Reported, CancelStatus}` | |
| (e) cancel e-Arşiv | `PUT /earchive/Invoices/{UUID}/Cancel` (undo: "faturanın iptal işlemini geri alır" page) | |
| (f) PDF/HTML | `GET /einvoice/Sale/{UUID}/pdf`, `.../html`; `GET /earchive/Invoices/{UUID}/pdf`, `.../html` | binary/HTML body |

Enums (official): `InvoiceProfile` = TEMELFATURA, TICARIFATURA, IHRACAT, YOLCUBERABERFATURA, EARSIVFATURA, KAMU, HKS, ENERJI,
ILAC_TIBBICIHAZ, OZELFATURA, YATIRIMTESVIK, IDIS. `InvoiceType` = SATIS, IADE, ISTISNA, TEVKIFAT, IHRACKAYITLI, IPTAL, OZELMATRAH, SGK, ...

### 2.2 BirFatura (REST "OutEBelgeV2")

No public docs page was reachable. BirFatura's own API page only covers the *reverse* integration, where BirFatura pulls orders from your shop
(https://birfatura.com/birfatura-api-entegrasyonu/). Everything below is from two independent community clients
(https://github.com/burakayax/NB_PDF_PLATFORM `web/backend/app/billing/birfatura.py`, https://github.com/bera65/frisay
`modules/bifatura/lib/BifaturaApi.php`). Treat it all as **community** and ask BirFatura for the spec + test account.

- **Base URL:** `https://uygulama.edonustur.com/api/OutEBelgeV2/` (live; the host redirects `/` to a login page). No test host found.
- **Auth:** headers `X-Api-Key`, `X-Secret-Key`, `X-Integration-Key` (from the BirFatura panel). All calls `POST` JSON; the response
  wrapper is `{Success, Message, Result}`.
- (a) `POST GibUserList` `{PkGbTypeCode: "<vkn>", PageNumber: 1, PageSize: 10}` → registered aliases (empty ⇒ e-Arşiv).
- (b)+(c) `POST SendBasicInvoiceFromModel` `{invoice: {Ettn, InvoiceDate, IsDocumentNoAuto: true, BillingName, BillingAddress,
  BillingCity, Email, PaymentType, Currency, CurrencyRate, ProductsTotalTaxExcluding/Including, ..., Products[{ProductCode,
  ProductName, ProductQuantity, ProductQuantityType, VatRate, ProductUnitPriceTaxExcluding/Including, Discount*}]}}`. It picks
  e-Fatura/e-Arşiv itself. **SATIS only.** For IADE or full control: `POST SendDocument` `{DocumentBytes: <zipped UBL base64>,
  SystemTypeCodes: "EFATURA"|"EARSIV", IsDocumentNoAuto: true, ReceiverTag: "urn:mail:...pk"}`.
- (d) `POST GetOutBoxDocumentStatusesWithUUIDs` `{Uuids: [...]}` (poll until `SUCCEED`).
- (e) `POST SendDocumentAnswer` `{DocumentUUID, AcceptOrRejectCode: "IPTAL", AcceptOrRejectReason, SystemTypeCodes: "EARSIV"}`.
- (f) `POST GetPDFLinkByUUID` `{Uuids: [...], SystemType: "EFATURA"|"EARSIV"}` → `[{pdfLink}]`.
- Sandbox: none published.

### 2.3 Uyumsoft (SOAP, WCF)

Live WSDL read: https://efatura-test.uyumsoft.com.tr/Services/Integration?wsdl (+ `?xsd=xsd0..9`). 64 operations on `IIntegration`.

- **Endpoints:** test `https://efatura-test.uyumsoft.com.tr/Services/Integration`, live `https://efatura.uyumsoft.com.tr/Services/Integration`
  (both WSDLs answer 200; official). SOAP 1.1, `BasicHttpBinding_IIntegration`, document/literal.
- **Auth:** WS-Security `UsernameToken` in the SOAP header over HTTPS (WSDL policy; official). Node: `new soap.WSSecurity(user, pass)`.
- **Public test user:** `Uyumsoft` / `Uyumsoft` on the test endpoint (community: https://github.com/osman-turan/uyumsoft-einvoice-nodejs
  `index.js`; long-standing shared demo account).
- (a) `IsEInvoiceUser(vknTckn, alias?)` → `FlagResponse`; `GetUserAliasses(vknTckn)` → `SystemUserWithAlias` (aliases). Also
  `GetEInvoiceUsers` / `FilterEInvoiceUsers` for bulk sync.
- (b)+(c) `SendInvoice(invoices: InvoiceInfo[])`, where `InvoiceInfo = { Invoice: UBL InvoiceType (typed object, not a string),
  TargetCustomer {@VknTckn, @Alias, @Title}, EArchiveInvoiceInfo {@DeliveryType Paper|Electronic, InternetSalesInfo {WebAddress,
  PaymentMidierName, ...}}, Scenario: Automated|eInvoice|eArchive, Notification {Mailing}, @LocalDocumentId }`. **`Scenario=Automated`
  lets Uyumsoft choose e-Fatura vs e-Arşiv** (official enum; behaviour guess). Returns `InvoiceIdentity{@Id (ETTN), @Number, @InvoiceScenario}`.
  `SaveAsDraft` / `SendDraft` and `ValidateInvoice` exist. `CompressedSendInvoice` takes zipped data.
- (d) `QueryOutboxInvoiceStatus(invoiceIds: string[])` → `InvoiceStatusInfo[]`; `GetOutboxInvoiceStatusWithLogs`.
- (e) `CancelEArchiveInvoice(request: EArchiveCancelInvoiceContext{@InvoiceId, @CancelDate})`; undo `RecoverEArchiveCancel`.
- (f) `GetOutboxInvoicePdf(invoiceId)` → `InvoiceDataResponse` (base64 PDF); `GetOutboxInvoiceView(invoiceId)` (HTML);
  `GenerateDocumentUrl` (public link).
- Also `BasicIntegration` service exists (`/Services/BasicIntegration?wsdl`, 200) — not examined.

### 2.4 EDM Bilişim (SOAP, WCF)

Live WSDL read: https://test.edmbilisim.com.tr/EFaturaEDM21ea/EFaturaEDM.svc?wsdl (+ `?xsd=xsd0..6`). Developer guide V4.2.1
mirrored at https://github.com/engtuncay/engtuncay.github.io/blob/master/diger/edm/edm-web-api.md (source links to
https://docs.edmbilisim.com.tr/api/api-documentation/introduction.html; that page answers 200).

- **Endpoints:** test `https://test.edmbilisim.com.tr/EFaturaEDM21ea/EFaturaEDM.svc` (official guide). Live: `https://portal2.edmbilisim.com.tr/EFaturaEDM/EFaturaEDM.svc`
  (WSDL answers 200; host name community). Test credentials: request from `isgelistirme@edmbilisim.com.tr` (official guide). No public test user.
- **Auth:** session. `Login(REQUEST_HEADER, USER_NAME, PASSWORD)` → `SESSION_ID`; every later call sends `REQUEST_HEADER{SESSION_ID,
  CLIENT_TXN_ID, ACTION_DATE, REASON, APPLICATION_NAME, HOSTNAME, CHANNEL_NAME, COMPRESSED}`; `Logout` at the end (official).
- (a) `CheckUser(USER: GIBUSER{IDENTIFIER: vkn})` → `GIBUSER[]{IDENTIFIER, ALIAS, TITLE, TYPE, DOCUMENTTYPE, ...}` (empty ⇒ e-Arşiv).
  `GetUserList` / `GetUserListBinary` for bulk.
- (b)+(c) `SendInvoice(SENDER{@vkn,@alias}, RECEIVER{@vkn,@alias}, INVOICE[]{HEADER, CONTENT: base64 UBL})`. The same call sends e-Arşiv: the
  `INVOICE` carries `EARCHIVE=true` (official guide: "E-arşiv veya Internet satış faturası ise True"), plus `INTERNETSALES=true`
  and `INTERNETSALESDETAILS{webAdresi, odemeSekli, odemeAracisiAdi, odemeTarihi}`. `LoadInvoice` saves as draft; `LoadInvoiceModel`
  exists (model-based, not examined).
- (d) `GetInvoiceStatus(INVOICE{@UUID})` → `INVOICE_STATUS{STATUS, STATUS_DESCRIPTION, GIB_STATUS_CODE, GIB_STATUS_DESCRIPTION,
  EARCHIVE_REPORT_STATUS, EARCHIVE_CANCEL_REPORT_STATUS, ...}`.
- (e) `CancelInvoice(INVOICE[])`. The guide says successfully sent **e-Fatura cannot be cancelled**, while e-Arşiv can be cancelled in
  Load-Succeed, failed or Send-Succeed states (official guide §5.12).
- (f) `GetInvoice(INVOICE_SEARCH_KEY{UUID, DIRECTION: OUT, ...}, INVOICE_CONTENT_TYPE: PDF|HTML|XML)`; content comes back in `INVOICE.CONTENT`.

### 2.5 QNB eFinans (SOAP, JAX-WS; two separate services)

Live WSDLs read (official): e-Fatura `https://erpefaturatest1.qnbesolutions.com.tr/efatura/ws/connectorService?wsdl`, login
`https://erpefaturatest1.qnbesolutions.com.tr/efatura/ws/userService?wsdl`, e-Arşiv `https://earsivtest.efinans.com.tr/earsiv/ws/EarsivWebService?wsdl`.

- **Endpoints:** test as above. Live candidates: `https://connector.qnbesolutions.com.tr/connector/ws/connectorService` (or older
  `https://connector.efinans.com.tr/connector/ws/connectorService`) and `https://earsiv.efinans.com.tr/earsiv/ws/EarsivWebService`.
  All answered 200 for `?wsdl`. Which live host is current: **guess**, so ask QNB. QNB supplies test URLs + users per customer (community, packagist `muhittingulap/qnbfinansbank`).
- **Auth (community):** e-Fatura connector: `userService.wsLogin(userId, password, lang)` sets a session cookie used on
  `connectorService` calls (`logout` at the end). e-Arşiv: WS-Security `UsernameToken` header. `wsLogin` signature is official (XSD).
  The cookie/UsernameToken split comes from community libraries.
- (a) `efaturaKullanicisi(vergiTcKimlikNo)` → boolean; `getMukellefAktifEtiketList(VKN)` → active aliases; also
  `efaturaKullanicisiKontrol(input)` on the e-Arşiv service.
- (b) `belgeGonderExt(parametreler: gidenBelgeParametreleri{vergiTcKimlikNo, belgeTuru: "FATURA_UBL", belgeNo, veri: base64 zipped UBL,
  belgeHash: MD5 of veri, mimeType: "application/xml", belgeVersiyon: "1.0", alanEtiket: receiver PK, gonderenEtiket, erpKodu, ...})`
  (field names official; values community). Number: `faturaNoUret`.
- (c) e-Arşiv `faturaOlustur(input: JSON string, fatura: belge{belgeFormati: UBL, belgeIcerigi: base64})`. `input` is a JSON string
  like `{"islemId": "<uuid>", "vkn": "<our vkn>", "sube": "DFLT", "kasa": "DFLT", "numaraVerilsinMi": 1, "faturaSeri": "ABC",
  "sablonAdi": "..."}` (community; param shape not in XSD since it's a string).
- (d) e-Fatura `gidenBelgeDurumSorgulaEttn(vergiTcKimlikNo, ettn)`; e-Arşiv `faturaSorgula(input)`; report `raporDurumSorgula`.
- (e) e-Arşiv `faturaIptalEt(input)` (undo `faturaIptaliKaldir`).
- (f) e-Fatura `gidenBelgeleriIndirEttn(vergiTcKimlikNo, belgeEttnListesi[], belgeTuru, belgeFormati: PDF|HTML|UBL)`; e-Arşiv
  `faturaSorgula` returns content per `input` options (community).

### 2.6 Paraşüt (REST JSON:API; accounting software that issues via its integrator)

Official docs at https://apidocs.parasut.com/ (Cloudflare blocked both fetch tools on 2026-10-27). Paths below are from several
independent community SDKs that agree (https://github.com/halledilirya/parasut-ts, https://github.com/yamanhacioglu/parasut-laravel,
https://github.com/MarlonJD/parasut-python, https://github.com/lab2023/parasut-ruby-sdk): **community, high agreement**.

- **Base URLs:** live `https://api.parasut.com/v4/{company_id}/...`, token `https://api.parasut.com/oauth/token`. Sandbox
  `https://api.heroku-staging.parasut.com/v4/` + `/oauth/token` (community, MarlonJD). Sandbox access needs a request to Paraşüt.
- **Auth:** OAuth2 `grant_type=password` (client_id, client_secret, username, password, `redirect_uri=urn:ietf:wg:oauth:2.0:oob`)
  → Bearer access token (~2 h) + `refresh_token` grant.
- **Flow** (everything async):
  1. Contact: `POST /contacts` (`tax_number`, `tax_office`, `contact_type: person|company`, address fields). Reuse by `filter[tax_number]`.
  2. `POST /sales_invoices` `{data:{type:"sales_invoices", attributes:{item_type:"invoice", issue_date, currency, description, ...},
     relationships:{contact:{data:{type:"contacts",id}}, details:{data:[{type:"sales_invoice_details", attributes:{quantity,
     unit_price, vat_rate: 20, description}, relationships:{product:{data:{type:"products",id}}}}]}}}}`.
  3. (a) `GET /e_invoice_inboxes?filter[vkn]=<vkn>` → `[{attributes:{vkn, e_invoice_address (alias), name, inbox_type}}]`; empty ⇒ e-Arşiv.
  4. (b) `POST /e_invoices` `{data:{type:"e_invoices", attributes:{scenario:"basic"|"commercial", to:"<e_invoice_address>", note?,
     vat_exemption_reason_code?}, relationships:{invoice:{data:{type:"sales_invoices", id}}}}}`. (One SDK names the relationship
     `sales_invoice`; check official docs.)
     (c) `POST /e_archives` `{data:{type:"e_archives", attributes:{note?, vat_exemption_reason_code?, internet_sale:{url,
     payment_type: KREDIKARTI/BANKAKARTI|EFT/HAVALE|KAPIDAODEME|ODEMEARACISI, payment_platform, payment_date}}, relationships:
     {sales_invoice:{data:{type:"sales_invoices", id}}}}}`.
  5. Both return a **trackable job**. Poll `GET /trackable_jobs/{id}` until `status` = `done` (or `error` with `errors[]`).
  6. (d) `GET /sales_invoices/{id}?include=active_e_document` → the `e_invoices`/`e_archives` id and status. `GET /e_archives/{id}`, `GET /e_invoices/{id}`.
  7. (f) `GET /e_archives/{id}/pdf`, `GET /e_invoices/{id}/pdf` → JSON with a temporary PDF `url` (may 404 briefly while rendering; retry).
  8. (e) `DELETE /sales_invoices/{id}/cancel` cancels the invoice in Paraşüt (community). Whether this also cancels the e-Arşiv at
     GİB through API: **guess, unverified**. Treat as manual in the Paraşüt UI until tested.
- Caveat: Paraşüt is a full accounting ledger. Using it means our invoices (and contacts/products) live there too. That is good if the
  accountant already uses Paraşüt, and heavy if not.

### 2.7 İzibiz (SOAP; seventh, well documented with a public test user)

Live WSDLs read (official): `https://efaturatest.izibiz.com.tr/AuthenticationWS?wsdl`, `https://efaturatest.izibiz.com.tr/EInvoiceWS?wsdl`,
`https://efaturatest.izibiz.com.tr/EIArchiveWS/EFaturaArchive?wsdl`. Docs portal: https://dev.izibiz.com.tr/ (category
`/category/efatura-earsiv`). Sample clients (sdk): https://github.com/izibiz/ws-client-dotnet, https://github.com/izibiz/izibiz-dotnet-rest-client
(İzibiz also has a REST API; not examined).

- **Test user (sdk, published by İzibiz):** `izibiz-test2` / `izi321` on the test hosts.
- **Live:** `https://efaturaws.izibiz.com.tr/EInvoiceWS` (WSDL 200). Live auth/archive hosts unknown (the same paths 404 there), so ask İzibiz.
- **Auth:** `AuthenticationWS.Login(USER_NAME, PASSWORD)` → `SESSION_ID` in `REQUEST_HEADER` of every call (same family as EDM; official).
- (a) `AuthenticationWS.CheckUser(USER: GIBUSER{IDENTIFIER}, DOCUMENT_TYPE?)` → `USER[]{IDENTIFIER, ALIAS, TITLE, TYPE, DOCUMENT_TYPE, DELETED...}`.
- (b) `EInvoiceWS.SendInvoice(SENDER{@vkn,@alias}, RECEIVER{@vkn,@alias}, INVOICE[]{CONTENT base64 UBL}, SERI_PREFIX?)`.
- (c) `EFaturaArchive.WriteToArchiveExtended(ArchiveInvoiceExtendedContent{INVOICE_PROPERTIES[]{EARSIV_FLAG, EARSIV_PROPERTIES
  (e-mail, send type, internet sale info), PDF_PROPERTIES, INVOICE_CONTENT base64 UBL}})` (types official; op↔type mapping guess).
- (d) `EInvoiceWS.GetInvoiceStatus(INVOICE{@UUID})`; `EFaturaArchive.GetEArchiveInvoiceStatus(UUID)`.
- (e) `EFaturaArchive.CancelEArchiveInvoice(CancelEArsivInvoiceContent{FATURA_UUID, IPTAL_TARIHI, TOPLAM_TUTAR, IPTAL_NOTU?})`.
- (f) `EInvoiceWS.GetInvoiceWithType(INVOICE_SEARCH_KEY{UUID, TYPE: PDF|HTML|XML, DIRECTION: OUT})`; `EFaturaArchive.ReadFromArchive(INVOICEID, PROFILE: PDF|HTML|XML)`.

Others not documented here: Sovos/Foriba (SOAP `GetUserList` etc., docs behind customer login: https://docs.sovos.com/en/indirect-tax/indirect-tax-products/einvoicing/compliance-network/country-setup-guides/turkey/issue-invoices-in-e-fatura),
Logo, Kolaysoft, Digital Planet, Turkcell e-Şirket: no public machine-readable spec found in the time spent.

---

## 3. Comparison

| | Style | Public spec | Public sandbox user | Builds UBL for us | e-Arşiv cancel | Auto e-Fatura/e-Arşiv choice |
|---|---|---|---|---|---|---|
| Nilvera | REST, Bearer | yes (OpenAPI) | own account | yes (Model) or XML | `PUT .../Cancel` | no (we check) |
| BirFatura | REST, 3 header keys | no | no | yes (basic model, SATIS only) | `SendDocumentAnswer IPTAL` | yes (basic model) |
| Uyumsoft | SOAP, WS-Security | WSDL | `Uyumsoft/Uyumsoft` (community) | typed UBL object | `CancelEArchiveInvoice` | yes (`Automated`) |
| EDM | SOAP, session | WSDL + guide | on request | no (UBL base64) | `CancelInvoice` | no |
| QNB eFinans | SOAP ×2, cookie + WS-Sec | WSDL | on request | no (UBL base64) | `faturaIptalEt` | no |
| Paraşüt | REST JSON:API, OAuth2 | docs (blocked here) | staging on request | yes (from sales invoice) | unverified | no (we check inboxes) |
| İzibiz | SOAP, session (+REST) | WSDL + portal | `izibiz-test2/izi321` | no (UBL base64) | `CancelEArchiveInvoice` | no |

## 4. Shape for our code (guess, minimal)

- `EInvoiceProvider` interface with exactly: `lookup(taxId) → {registered, aliases[]}`, `send(invoice, {kind: 'efatura'|'earsiv',
  alias?}) → {uuid, number}`, `status(uuid, kind)`, `cancelArchive(uuid, date)`, `pdf(uuid, kind) → Buffer|url`. One implementation first
  (Nilvera), selected in settings like payment providers are.
- Our invoice row stores: ETTN (generated by us before the call, so retries are idempotent), kind, profile, type, integrator
  number, status, report status, `delivered_at` (starts the 8-day window), `cancelled_at`, `return_of` (for IADE).
- A worker polls status until final, and alerts on `error` or on e-Arşiv `NotReported` after 2 days.

---

Not verified: Paraşüt endpoints against the official page (Cloudflare blocked fetches), BirFatura (no official spec or sandbox
anywhere public), QNB live host and auth mechanics, exemption code meanings 301/302 and the `11111111111`/`2222222222`
placeholders against a GİB text. No integrator call was actually executed. Every "behaviour" claim needs one sandbox round trip.
