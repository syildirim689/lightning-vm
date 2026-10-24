# Türkiye ödeme sağlayıcıları ve banka sanal POS'ları: entegrasyon araştırması

Tarih: 2026-10-24. Amaç: admin "Ödeme yöntemleri" sayfası için (1) sağlayıcı başına kimlik bilgisi form alanları, (2) para çekmeyen, güvenli bir "Test" (credential check) çağrısı.

Güven etiketleri:
- **docs**: resmi dokümanda okundu.
- **partial**: resmi dokümanda kısmen var, kalanı kütüphanelerden.
- **community**: yalnızca açık kaynak kütüphanelerden (mewebstudio/pos, evrenonur/sanalpos, cempehlivan/CP.VPOS, iyzipay-node, craftgate-node-client, ActiveMerchant, omnipay-*). Canlıya çıkmadan önce sağlayıcının güncel dokümanıyla doğrulanmalı.

Ana kaynak haritası (Temmuz 2026 commit'i): [mewebstudio/pos](https://github.com/mewebstudio/pos) `config/pos_production.php`, `config/pos_test.php`, `src/Crypt/*`, `src/DataMapper/*`. İkinci harita: [evrenonur/sanalpos](https://github.com/evrenonur/sanalpos) ve [cempehlivan/CP.VPOS](https://github.com/cempehlivan/CP.VPOS) (README'deki alan eşleme tablosu).

---

## 0. Uygulama için çıkarımlar (önce bunu okuyun)

1. **3D storeKey / "3D anahtarı" sunucu tarafında doğrulanamaz.** Nestpay `storeKey`, Garanti `storeKey`, PayFor `MerchantPass`, InterVPOS `MerchantPass`, PosNet `ENCKEY` yalnızca 3D form hash'inde kullanılır. Sunucudan bunu kanıtlayan bir API yok. Tek yol: test modunda gerçek bir 3D akışı (banka sayfasına yönlendirme + callback hash kontrolü). "Test" butonu bunları **"doğrulanamadı, 3D ile test edin"** olarak göstermeli.
2. **API kullanıcısı/şifresi genelde doğrulanabilir**: sahte bir sipariş numarasıyla **durum sorgusu** (status/inquiry) gönderin. Kimlik hatası ile "sipariş bulunamadı" hatası farklı döner. "Bulunamadı" = kimlik doğru. Bu çağrı para çekmez.
3. **Aggregator'larda en ucuz çağrı BIN/taksit sorgusu** (iyzico, PayTR, Craftgate, Param, Moka, Paynet, Sipay/Vepara, Esnekpos, Tosla, Paycell). Hepsi imzalı, para çekmez.
4. **Test ve canlı ayrı host'lardır**, istisnalar: **PayTR** (tek host `www.paytr.com`, `test_mode=1` parametresi ve mağaza panelindeki test modu), **Vakıf Katılım** (mewebstudio test config'inde canlı host'la aynı). Formda "LIVE" ve "TEST" iki ayrı kimlik seti tutulmalı; PayTR'de çoğu üye aynı anahtarı ikisine de girer.
5. **IP kısıtı**: Paynet sabit IP ister (docs). Sipay'da IP kısıtı sayfası var. Bankaların çoğu canlıda sunucu IP'sinin tanımlanmasını ister. Test butonu "403 / IP not allowed" durumunu ayrıca göstermeli.
6. **Stripe ve PayPal kullanılamaz** (bkz. §3). Listeye koymayın veya "TR şirketleri için yok" diye işaretleyin.
7. Gizli alanlar (şifre, secret, storeKey, GUID, merchant_key/salt, ENCKEY) şifreli saklanmalı, formda maskeli gösterilmeli; geri okunmamalı.

### Özet tablo

| Sağlayıcı / platform | Form alanları (gizli = *) | Canlı host | Test host | Sunucu tarafı kimlik testi | 3D modeli | Güven |
|---|---|---|---|---|---|---|
| iyzico | apiKey, secretKey* | api.iyzipay.com | sandbox-api.iyzipay.com | Var: `POST /payment/bin/check` | Checkout Form (hosted/iframe), 3DS API | docs |
| PayTR | merchant_id, merchant_key*, merchant_salt* | www.paytr.com | aynı host + `test_mode=1` | Var: `POST /odeme/api/bin-detail` | iFrame API (hosted), Direkt API (3D_PAY) | docs |
| Param (TurkPos) | CLIENT_CODE, CLIENT_USERNAME, CLIENT_PASSWORD*, GUID* | posws.param.com.tr | test-dmz.param.com.tr veya testposws.param.com.tr | Var: SOAP `TP_Ozel_Oran_SK_Liste` / `BIN_SanalPos` | 3D (TP_WMD_UCD), 3D_PAY, 3D_HOST | community |
| Sipay | merchant_id, app_id (app key), app_secret*, merchant_key* | app.sipay.com.tr/ccpayment | provisioning.sipay.com.tr/ccpayment | Var: `POST /api/token` (+ `/api/getpos` merchant_key için) | paySmart3D (3D_PAY), hosted (branded) | partial |
| Vepara | Sipay ile aynı (CCPayment) | app.vepara.com.tr/ccpayment | test.vepara.com.tr/ccpayment | Var: Sipay ile aynı | Sipay ile aynı | community |
| Papara | ApiKey* | merchant-api.papara.com | merchant.test.api.papara.com | Var: `GET /account` | Papara cüzdan yönlendirme (kart değil) | community |
| Moka United | DealerCode, Username, Password* | service.moka.com | service.refmoka.com | Var: `POST /PaymentDealer/GetBankCardInformation` | DoDirectPaymentThreeD (3D_PAY) | community |
| Craftgate | apiKey, secretKey* | api.craftgate.io | sandbox-api.craftgate.io | Var: `GET /installment/v1/bins/{bin}` | 3DS init + hosted checkout | community (docs giriş gerektiriyor) |
| Paynet | secret_key* (+ publishable key istemci için) | api.paynet.com.tr | pts-api.paynet.com.tr | Var: `POST /v1/ratio/Get` | Paynet.js form / 3D API | docs |
| Esnekpos | MERCHANT, MERCHANT_KEY* | posservice.esnekpos.com | posservicetest.esnekpos.com (teyit gerekli) | Var: `POST /api/services/GetDealerBalance` | 3D, Ortak Ödeme Sayfası | docs |
| Tosla (eski AKÖde) | clientId, apiUser, apiPass* | entegrasyon.tosla.com/api/Payment | prepentegrasyon.tosla.com/api/Payment | Var: `POST .../inquiry` veya `GetCommissionAndInstallmentInfo` | 3D_PAY, 3D_HOST | community |
| Ödeal | clientId, clientSecret* | auth.odeal.com/api/v1, api.odeal.com/vpos | auth-sandbox.odeal.com/api/v1, api-stg.odeal.com/vpos | Var: `POST {token}/token` | 3D (returnUrl callback) | community |
| Paycell | applicationName, applicationPwd*, secureCode*, merchantCode, (eulaId) | tpay.turkcell.com.tr | tpay-test.turkcell.com.tr | Var: `getCardBinInformation` | Paycell 3D session + kart token | community |
| Hepsipay | MerchantNo, TerminalNo, StoreKey* | merchantpfpayment-gateway.hepsipay.com | merchantpfpayment-gateway-qa.hepsipay.com | Kısmen: imzalı `checkavailability` (401 = kötü imza) | Iframe SDK (hosted) | partial |
| Lidio | bilinmiyor | bilinmiyor | bilinmiyor | bilinmiyor | Hosted Pages / Pay-with-link | - |
| Shopier | API key, API secret* (eski ödeme formu); PAT (yeni REST API) | www.shopier.com/ShowProduct/api_pay4.php | yok | **Yok** (yalnızca hosted form imzası) | Hosted form | community |
| Paytrek, Ozan, BKM Express, PayU TR | bkz. §3 | - | - | - | - | - |
| Stripe | - | - | - | TR işletmesini kabul etmiyor | - | docs |
| PayPal | - | - | - | 2016'dan beri TR'de hizmet yok | - | community (haber) |
| **Nestpay / EST (Payten-Asseco)** | clientId (Mağaza kodu), API kullanıcı adı, API şifresi*, storeKey* | banka başına (bkz. §2.1) | entegrasyon.asseco-see.com.tr | Var: CC5Request `ORDERSTATUS` | 3D, 3D_PAY, 3D_PAY_HOSTING, 3D_HOST | community |
| **Akbank yeni API** | merchantSafeId, terminalSafeId, secretKey* | api.akbank.com | apipre.akbank.com | Var: txnCode 1010 (sipariş tarihçesi) | 3D, 3D_PAY, 3D_HOST (payhosting) | community |
| **Garanti GVP** | merchantId, terminalId, provUserId (PROVAUT), provisionPassword*, storeKey*, (refund user PROVRFN + şifresi*) | sanalposprov.garanti.com.tr | sanalposprovtest.garantibbva.com.tr | Var: `orderinq` veya `bininq` | 3D, 3D_PAY, 3D_HOST | community |
| **Posnet (Yapı Kredi)** | mid, tid, posnetId, ENCKEY* | posnet.yapikredi.com.tr | setmpos.ykb.com | Var: `agreement` (durum) | 3D (OOS/YKBPaymentService) | community |
| **PosNet V1 JSON (Albaraka)** | MerchantNo, TerminalNo, PosNetId, ENCKEY* | epos.albarakaturk.com.tr | epostest.albarakaturk.com.tr | Var: `TransactionInquiry` | 3D | community |
| **PayFor (QNB, Ziraat Katılım)** | MerchantId (MbrId 5/12), UserCode, UserPass*, MerchantPass* | vpos.qnb.com.tr | vpostest.qnb.com.tr | Var: `OrderInquiry` | 3D, 3D_PAY, 3D_HOST | community |
| **InterVPOS (DenizBank)** | ShopCode, UserCode, UserPass*, MerchantPass* | inter-vpos.com.tr | test.inter-vpos.com.tr | Var: `StatusHistory` | 3D, 3D_PAY, 3D_HOST | community |
| **PayFlex VPOS 7/24 (VakıfBank, Ziraat)** | MerchantId (HostMerchantId), Password*, TerminalNo | onlineodeme.vakifbank.com.tr:4443 | onlineodemetest.vakifbank.com.tr:4443 | Var: Search.aspx durum sorgusu | MPI 3D (enrollment) + Common Payment (3D_PAY/3D_HOST) | community |
| **Kuveyt Türk TDV2** | MerchantId, CustomerId, UserName, Password* | sanalpos.kuveytturk.com.tr | boatest.kuveytturk.com.tr | Var: SOAP `GetMerchantOrderDetail` | 3D | community |
| **Vakıf Katılım (Boa)** | MerchantId, CustomerId, UserName, Password* | boa.vakifkatilim.com.tr | ayrı test host bulunamadı | Var: durum/tarihçe sorgusu | 3D, 3D_HOST | community |

---

## 1. Ödeme kuruluşları / aggregator'lar

### 1.1 iyzico
- Site: https://www.iyzico.com, docs: https://docs.iyzico.com
- Alanlar: `apiKey`, `secretKey`* (opsiyonel pazaryeri `subMerchantKey`). (docs, mewebstudio `createIyzicoPosAccount`)
- Host: canlı `https://api.iyzipay.com`, sandbox `https://sandbox-api.iyzipay.com`. (docs)
- Kimlik testi: `POST /payment/bin/check`, gövde `{"locale":"tr","conversationId":"<rnd>","binNumber":"55287900"}` (8 hane). Alternatif: `POST /payment/iyzipos/installment` (`price`, `binNumber`). `/payment/test` kimlik gerektirmez, kimlik testi olarak **kullanmayın**. Hatalı kimlikte HTTP 400 + `status:"failure"`, `errorCode`, `errorMessage` döner. Kimlik hatasının kesin errorCode'u dokümanda yok (unknown).
- Auth (IYZWSv2, docs):
  - `x-iyzi-rnd: <randomKey>`
  - `encryptedData = hex(HMAC_SHA256(key=secretKey, randomKey + uriPath + requestBody))` (uriPath ör. `/payment/bin/check`, query yok)
  - `Authorization: IYZWSv2 base64("apiKey:" + apiKey + "&randomKey:" + randomKey + "&signature:" + encryptedData)`
  - `Content-Type: application/json`
- Test kartları (docs, add-ons/test-cards): `5890040000000016`, `5526080000000006`, `4766620000000001`, `4603450000000000`; SKT gelecekte, CVC herhangi.
- 3D: Checkout Form (hosted/iframe, en kolay), 3DS API (`/payment/3dsecure/initialize` + `auth`). Callback imzası (mewebstudio): `hex(HMAC_SHA256(secretKey, conversationData:conversationId:mdStatus:paymentId:status))`.
- Güven: docs.

### 1.2 PayTR
- Site: https://www.paytr.com, docs: https://dev.paytr.com
- Alanlar: `merchant_id`, `merchant_key`*, `merchant_salt`*. (docs)
- Host: `https://www.paytr.com` (canlı ve test aynı; test için istekte `test_mode=1` ve mağaza panelinde test modu). Ayrı sandbox host yok.
- Kimlik testi (docs): `POST https://www.paytr.com/odeme/api/bin-detail`, form alanları `merchant_id`, `bin_number`, `paytr_token`.
  - `paytr_token = base64(HMAC_SHA256(key=merchant_key, bin_number + merchant_id + merchant_salt))`
  - Yanıt `status`: `success` | `failed` (BIN tanımsız ama kimlik doğru) | `error` (`err_msg`; kimlik hatası buraya düşer).
  - Alternatif (community, mewebstudio): `POST /odeme/taksit-oranlari`, alanlar `merchant_id`, `request_id`, `paytr_token = base64(HMAC_SHA256(merchant_key, merchant_id + request_id + merchant_salt))`.
- Diğer uçlar (mewebstudio): `/odeme/api/get-token` (iFrame token), `/odeme` (Direkt API), `/odeme/durum-sorgu`, `/odeme/iade`.
- 3D: iFrame API (hosted iframe, 3D'yi PayTR yönetir) veya Direkt API (kart formu sizde, 3D_PAY). Callback hash: `base64(HMAC_SHA256(merchant_key, merchant_oid + merchant_salt + status + total_amount))`.
- Test kartları (mewebstudio örneği): `4355084355084358`, `5406675406675403` (12/30, CVV 000).
- Güven: docs (BIN), community (diğerleri).

### 1.3 Param (TurkPos)
- Site: https://param.com.tr, docs: https://dev.param.com.tr (WebFetch 403 verdi, içerik doğrudan okunamadı)
- Alanlar: `CLIENT_CODE` (terminal no), `CLIENT_USERNAME`, `CLIENT_PASSWORD`*, `GUID`* (üye işyeri anahtarı). (mewebstudio, CP.VPOS)
- Host (SOAP, `xmlns="https://turkpos.com.tr/"`):
  - Canlı: `https://posws.param.com.tr/turkpos.ws/service_turkpos_prod.asmx`
  - Test: mewebstudio `https://test-dmz.param.com.tr/turkpos.ws/service_turkpos_test.asmx`; evrenonur `https://testposws.param.com.tr/turkpos.ws/service_turkpos_prod.asmx`. **Çelişkili, Param'dan teyit edin.**
  - 3D Host modeli: canlı `https://pos.param.com.tr/Tahsilat/to.ws/Service_Odeme.asmx`, test `https://test-pos.param.com.tr/to.ws/Service_Odeme.asmx`.
- Herkese açık test kimliği (mewebstudio unit testlerinde): CLIENT_CODE `10738`, USERNAME `Test`, PASSWORD `Test`, GUID `0c13d406-873b-403b-9c09-a5766840d98c`. Test kartı `5456165456165454` 12/26 000. (community)
- Kimlik testi: SOAP `TP_Ozel_Oran_SK_Liste` (SOAPAction `https://turkpos.com.tr/TP_Ozel_Oran_SK_Liste`), gövde `<G><CLIENT_CODE/><CLIENT_USERNAME/><CLIENT_PASSWORD/></G><GUID/>`. Hash gerekmez. Alternatif `BIN_SanalPos` (`BIN` opsiyonel). Kullanıcı istediği "SHA2B64" yalnızca ödeme çağrılarında gerekir.
- Ödeme hash'i (mewebstudio `ParamPosCrypt`): `base64(SHA1(ISO-8859-9(CLIENT_CODE + GUID + Taksit + Islem_Tutar + Toplam_Tutar + Siparis_ID)))`. 3D_PAY'de sona `Hata_URL + Basarili_URL` eklenir. Param'ın `SHA2B64` servis metodu da aynı hash'i sunucuda hesaplar.
- 3D: `TP_WMD_UCD` (3D, UCD_URL'e yönlendirme), `Pos_Odeme` (3D_PAY), 3D Host.
- Güven: community.

### 1.4 Sipay
- Site: https://sipay.com.tr, docs: https://apidocs.sipay.com.tr
- Alanlar (CP.VPOS): Üye İşyeri ID (`merchant_id`), Uygulama Anahtarı (`app_id`), Uygulama Parolası (`app_secret`*), Üye İşyeri Anahtarı (`merchant_key`*). Panel: Settings > Integration & API. (docs)
- Host (docs): canlı `https://app.sipay.com.tr/ccpayment/`, test `https://provisioning.sipay.com.tr/ccpayment/`. Test hesabı için `pos.support@sipay.com.tr` (docs; herkese açık test kimliği artık sayfada yok).
- Kimlik testi (docs): `POST /ccpayment/api/token`, JSON `{"app_id":"...","app_secret":"...","app_lang":"tr"}`. Başarı `status_code:100`, hatalı kimlik `status_code:30` "Invalid credentials". Token 2 saat geçerli, `data.is_3d` entegrasyon tipini verir.
- `merchant_key` doğrulaması (community, evrenonur): `POST /ccpayment/api/getpos`, `Authorization: Bearer <token>`, gövde `{"credit_card":"<6-8 hane BIN>","amount":"100.00","currency_code":"TRY","merchant_key":"..."}`.
- Ödeme hash_key (community, evrenonur `generateHashKey`): `data = total|installment|currency_code|merchant_key|invoice_id`; `iv = sha1(rnd)[0:16]`; `password = sha1(app_secret)`; `salt = sha1(rnd)[0:4]`; `key = sha256(password + salt)[0:32]`; `enc = AES-256-CBC(data, key, iv)` (base64); `hash_key = iv + ":" + salt + ":" + enc`, sonra `/` -> `__`.
- 3D: `/api/paySmart3D` (3D_PAY, form post), `/api/paySmart2D` (non-3D), `/payment/complete`; `is_3d=4` ise branded hosted ödeme.
- Güven: partial.

### 1.5 Vepara (ve diğer CCPayment / Sipay altyapılı kurumlar)
- Vepara, Sipay'ın "CCPayment" altyapısını kullanıyor (evrenonur `VeparaGateway extends AbstractCCPaymentGateway`). Alanlar, imza ve uçlar Sipay ile aynı.
- Host: canlı `https://app.vepara.com.tr/ccpayment`, test `https://test.vepara.com.tr/ccpayment`.
- Aynı altyapı (evrenonur/CP.VPOS): QNBpay, PayBull, Parolapara, IQmoney, HalkÖde. CP.VPOS testlerinde QNBpay için yayımlanmış bir test seti var (community).
- Güven: community.

### 1.6 Papara (merchant API)
- Site: https://www.papara.com, test portal: https://merchant.test.papara.com (API key `APIInfo` sayfasında)
- Alan: `ApiKey`*.
- Host (resmi `@papara/papara` npm SDK kaynağı): canlı `https://merchant-api.papara.com`, test `https://merchant.test.api.papara.com`.
- Kimlik testi: `GET /account`, header `ApiKey: <key>`, `Accept: application/json`. Marka adı ve unvanı döner, para hareketi yok.
- Ödeme: `POST /payments` (Papara cüzdanına yönlendirme, kullanıcı Papara bakiyesi/kartıyla öder), `GET /payments?id=`. Bu bir **kart sanal POS'u değildir**, ayrı bir "Papara ile öde" seçeneği olarak düşünülmeli.
- Güven: community (resmi SDK).

### 1.7 Moka United
- Site: https://mokaunited.com, eski docs: http://developer.moka.com (erişilemedi)
- Alanlar: `DealerCode` (bayi kodu), `Username`, `Password`*. (ActiveMerchant, CP.VPOS)
- Host: canlı `https://service.moka.com`, test `https://service.refmoka.com`.
- Auth (her istekte gövdede):
  ```json
  "PaymentDealerAuthentication": {"DealerCode":"...","Username":"...","Password":"...","CheckKey":"<hex>"}
  ```
  `CheckKey = hex(SHA256(DealerCode + "MK" + Username + "PD" + Password))`.
- Kimlik testi: `POST /PaymentDealer/GetBankCardInformation` gövde `{"PaymentDealerAuthentication":{...},"BankCardInformationRequest":{"BinNumber":"526911"}}`. Kimlik hatası kodları: `PaymentDealer.CheckPaymentDealerAuthentication.InvalidAccount`, `...InvalidRequest` (CheckKey hatası), `...VirtualPosNotFound`.
- Diğer: `DoDirectPayment`, `DoDirectPaymentThreeD`, `GetDealerPaymentTrxDetailList`, `DoVoid`, `DoCreateRefundRequest`, `DoCalcPaymentAmount`.
- 3D: `DoDirectPaymentThreeD` -> yönlendirme URL'i (3D_PAY).
- Güven: community.

### 1.8 Craftgate
- Site: https://craftgate.io, docs: https://developer.craftgate.io (sandbox panel girişi gerekiyor)
- Alanlar: `apiKey`, `secretKey`*.
- Host: canlı `https://api.craftgate.io`, sandbox `https://sandbox-api.craftgate.io`. (resmi SDK README)
- Auth (resmi craftgate-node-client `HttpClient.ts`, `utils.ts`):
  - `x-api-key: apiKey`, `x-rnd-key: <random>`, `x-auth-version: 1`, `x-signature: <sig>`
  - `sig = base64(SHA256(decodeURIComponent(fullUrl) + apiKey + secretKey + randomStr + body))`. Boş body eklenmez. `fullUrl` host ve query dahil.
- Kimlik testi: `GET /installment/v1/bins/{binNumber}` (veya `GET /installment/v1/installments?binNumber=..&price=..`).
- 3D: `/payment/v1/card-payments/3ds-init` + `3ds-complete`; Ortak Ödeme Formu (hosted checkout). BKM Express, Masterpass, Juzdan gibi APM'leri de sarar.
- Güven: community (resmi SDK; docs giriş arkasında).

### 1.9 Paynet
- Site: https://paynet.com.tr, docs: https://doc.paynet.com.tr (index: `/llms.txt`)
- Alanlar: `secret_key`* (sunucu), publishable key (istemci tarafı Paynet.js için). Örnek format `sck_...`. (docs)
- Host (docs): canlı `https://api.paynet.com.tr`, test `https://pts-api.paynet.com.tr`. Sabit IP gerekli. TLS 1.1/1.2.
- Auth (docs): `Authorization: Basic <secret_key>`. Resmi örnekte base64 yok. Bir omnipay paketi base64 diyor; resmi örnek ve CP.VPOS ham key kullanıyor.
- Kimlik testi (docs): `POST /v1/ratio/Get`, JSON `{"bin":"435508"}` (tüm alanlar opsiyonel). Yanıt `code` 0 = başarı.
- 3D: Paynet.js hazır/özel form, 3D API, PayLink (`v1/mailorder/create`), onay `v1/transaction/charge`.
- Güven: docs.

### 1.10 Esnekpos
- Site: https://esnekpos.com, docs: https://developer.esnekpos.com (EN: developer-eng.esnekpos.com)
- Alanlar: `MERCHANT`, `MERCHANT_KEY`*; taksit sorgusu için ayrıca `MERCHANT_PUBLIC_TOKEN`. (docs)
- Host: canlı `https://posservice.esnekpos.com`. Test: başlangıç sayfasında `https://posservicetest.esnekpos.com`, test sayfası "bizimle iletişime geçin" diyor (çelişkili). Test paneli `https://postest.esnekpos.com`.
- Herkese açık test üye işyeri (docs): MERCHANT `TEST1234`, MERCHANT_KEY `4oK26hK8MOXrIV1bzTRVPA==`. Test kartları: `9792100000000001`, `6587619825149656` (SKT/CVV serbest).
- Kimlik testi (docs): `POST /api/services/GetDealerBalance`, JSON `{"MERCHANT":"..","MERCHANT_KEY":"..","CURRENCY":"TRY","DEALER_SUB_EXTERNAL_ID":null}`. Başarıda `RETURN_CODE:"0"`. Alternatif `POST /api/services/GetInstallments`.
- 3D: 3D ödeme servisi, Ortak Ödeme Sayfası (hosted), BKM Express.
- Güven: docs.

### 1.11 Tosla (eski AKÖde, Akbank grubu)
- Site: https://tosla.com (İşim). Herkese açık doküman bulunamadı.
- Alanlar: `clientId`, `apiUser`, `apiPass`*. (mewebstudio `createToslaPosAccount`)
- Host: canlı `https://entegrasyon.tosla.com/api/Payment`, test `https://prepentegrasyon.tosla.com/api/Payment`.
- İmza: `hash = base64(SHA512(apiPass + clientId + apiUser + rnd + timeSpan))`, `timeSpan` formatı `YmdHis`, `rnd` rastgele 24 hex karakter.
- Kimlik testi: `POST /api/Payment/inquiry` JSON `{"clientId","apiUser","orderId":"<sahte>","rnd","timeSpan","hash"}` veya `POST /api/Payment/GetCommissionAndInstallmentInfo` (`bin` ile).
- Diğer uçlar: `Payment`, `threeDPayment`, `threeDPreAuth`, `postAuth`, `void`, `refund`, `history`, `GetInstallmentOptions`; 3D form `ProcessCardForm`, 3D host `threeDSecure`.
- 3D: 3D_PAY, 3D_HOST. Test kartları (mewebstudio): `4546711234567894`, `5406675406675403`.
- Güven: community.

### 1.12 Ödeal
- Site: https://odeal.com, docs: https://docs.odeal.com/sanalpos/tr/ (fetch sırasında iç host'a yönlendirdi, okunamadı)
- Alanlar: `clientId`, `clientSecret`*. (omnipay-odeal)
- Host: token `https://auth.odeal.com/api/v1/` (test `https://auth-sandbox.odeal.com/api/v1/`), gateway `https://api.odeal.com/vpos/` (test `https://api-stg.odeal.com/vpos/`).
- Kimlik testi: `POST {token}/token` `{clientId, clientSecret}` -> `accessToken` (~30 dk). **Dikkat:** yeni token öncekini geçersiz kılıyor. Canlı trafik varken "Test" butonu canlı token'ı düşürebilir. Token'ı cache'leyin ve test butonunda yeniden kullanın.
- 3D: `/vpos` 3D ve non-3D, pay-by-link. Callback `returnUrl`.
- Güven: community.

### 1.13 Paycell (Turkcell)
- Site: https://www.paycell.com.tr. Destek `paycelldev@paycell.com.tr`.
- Alanlar: `applicationName`, `applicationPwd`*, `secureCode`*, `merchantCode`, `eulaId`. (omnipay-paycell)
- Host: provision canlı `https://tpay.turkcell.com.tr/tpay/provision/services/restful/`, test `https://tpay-test.turkcell.com.tr:443/tpay/provision/services/restful/`. Kart token (payment management) canlı `https://epayment.turkcell.com.tr/paymentmanagement/rest/`, test `https://omccstb.turkcell.com.tr/paymentmanagement/rest/`.
- Herkese açık test değerleri (community README): applicationName `PAYCELLTEST`, applicationPwd `PaycellTestPassword`, secureCode `PAYCELL12345`, eulaId `17`, merchantCode `9998`.
- Her istekte `requestHeader {applicationName, applicationPwd, clientIPAddress, transactionDateTime, transactionId}`. hashData: `securityData = b64(SHA256(UPPER(applicationPwd + applicationName)))`, `hashData = b64(SHA256(UPPER(applicationName + transactionId + dateTime + [responseCode] + [cardToken] + secureCode + securityData)))`.
- Kimlik testi: `POST getCardToken/getCardBinInformation/` (veya `summaryReconciliation`).
- 3D: `getThreeDSession` + 3D sayfası + `getThreeDSessionResult`, kart bilgileri önce Paycell kart-token servisine gider.
- Güven: community.

### 1.14 Hepsipay
- Site: https://hepsipay.com, docs: https://dev.hepsipay.com/docs/
- Alanlar (docs): `MerchantNo`, `TerminalNo`, `StoreKey`*. Live ve QA kimlikleri tamamen ayrı.
- Host (docs): canlı `https://merchantpfpayment-gateway.hepsipay.com`, QA `https://merchantpfpayment-gateway-qa.hepsipay.com`. QA'da `/health-check` var (kimlik doğrulamaz).
- İmza: Ön hazırlık sayfası "URL (protokol + host + query) + MerchantNo + TerminalNo + body, StoreKey ile SHA-512 HMAC" diyor. APIPay imza sayfası ise düz SHA-512 diyor ve key kullanımını açıklamıyor. Örnek çıktı 128 karakter küçük harf hex. Header adları da tutarsız: `merchant-no`, `terminal-no` ve `signature` ya da `signature-no`. **Hepsipay'den teyit gerekli.**
- Kimlik testi: Saf okuma ucu yok. `POST /v2/hepsipayframe/checkavailability` imzalı çağrıda 401 kimlik/imza hatası demek, ama bu çağrı ödeme akışını başlatan adım.
- 3D: Iframe Web SDK (hosted, 3D Hepsipay'de).
- Güven: partial.

### 1.15 Lidio
- Site: https://www.lidio.com (TCMB lisanslı ödeme kuruluşu). Hosted Pages, Pay with Link, WooCommerce/OpenCart eklentileri var.
- Kimlik alanları, host'lar ve imza: **unknown**. Herkese açık API dokümanı bulunamadı, bilgiler Lidio'dan talep ediliyor.
- Güven: -.

### 1.16 Shopier
- Site: https://www.shopier.com, yeni REST API: https://developer.shopier.com (PAT ve OAuth 2.0; ürün, sipariş, bakiye, iade). **Kart ödemesi/checkout API'si yok.**
- Harici siteden ödeme (eski modül yolu, community `shopier-api` npm): `API key`, `API secret`*. Hosted form `https://www.shopier.com/ShowProduct/api_pay4.php`'ye POST edilir. `signature = base64(HMAC_SHA256(secret, random_nr + platform_order_id + total_order_value + currency))`. Callback imzası `random_nr + platform_order_id` üzerinden.
- Kimlik testi: **yok** (yalnızca form imzası, sunucu tarafı doğrulama ucu yok).
- Güven: community.

---

## 2. Banka sanal POS'ları (platforma göre)

### 2.1 Nestpay / EST (Payten, eski Asseco SEE) "CC5" API
Bankalar ve canlı host'lar (`/fim/api` = XML API, `/fim/est3Dgate` = 3D gate):

| Banka | Canlı API host | Not |
|---|---|---|
| İş Bankası | sanalpos.isbank.com.tr | test: istest.asseco-see.com.tr (evrenonur). İşbank ayrıca PayFlex kullanıyor (mewebstudio) |
| Akbank (eski) | www.sanalakpos.com | Akbank üyeleri yeni API'ye taşınıyor (§2.2) |
| Halkbank | sanalpos.halkbank.com.tr | |
| TEB | sanalpos.teb.com.tr | |
| Şekerbank | sanalpos.sekerbank.com.tr | |
| Ziraat (Asseco) | sanalpos2.ziraatbank.com.tr | test: torus-stage-ziraat.asseco-see.com.tr (evrenonur) |
| QNB Finansbank (Nestpay) | www.fbwebpos.com | QNB'nin asıl altyapısı PayFor (§2.6) |
| ING | sanalpos.ingbank.com.tr | |
| Türkiye Finans | sanalpos.turkiyefinans.com.tr | |
| Anadolubank | anadolusanalpos.est.com.tr | |
| Alternatif Bank | sanalpos.abank.com.tr | |
| Cardplus | sanalpos.card-plus.net | |

- Genel test host'u: `https://entegrasyon.asseco-see.com.tr/fim/api` ve `/fim/est3Dgate`.
- Alanlar: `clientId` (Mağaza kodu), API kullanıcı adı (`Name`), API şifresi (`Password`*), `storeKey`* (3D üye işyeri anahtarı). Kullanıcı yönetim panelinde "API" rolüyle açılmalı.
- Yayımlanmış İşbank test seti (CP.VPOS unit test, community): clientId `700655000200`, user `ISBANKAPI`, pass `ISBANK07`, storeKey `TRPS0200`. Test kartları (mewebstudio): `4355084355084358` 12/30 000, `5406675406675403`.
- **Kimlik testi** (community): `POST https://<host>/fim/api`, ham XML gövde (ISO-8859-9):
  ```xml
  <CC5Request><Name>..</Name><Password>..</Password><ClientId>..</ClientId>
    <OrderId>credcheck-123</OrderId><Extra><ORDERSTATUS>QUERY</ORDERSTATUS></Extra></CC5Request>
  ```
  Kimlik hatası ile "kayıt bulunamadı" farklı `ErrMsg` döner. Kesin metinler: unknown, ilk testte loglayın. Hash gerekmez. **storeKey doğrulanamaz.**
- 3D hash (ver3, mewebstudio `AssecoPosCrypt`): tüm form alanları anahtara göre doğal + büyük/küçük harf duyarsız sıralanır, `hash` ve `encoding` çıkarılır, değerlerde `\` -> `\\` ve `|` -> `\|` kaçışı yapılır, `|` ile birleştirilir, sona `|storeKey` eklenir, `base64(SHA512(..))`. Callback'te aynı yöntem (`HASHPARAMS` yerine tüm alanlar) ile `HASH` kontrolü.
- 3D modelleri: `3d`, `3d_pay`, `3d_pay_hosting`, `3d_host` (storetype alanı).
- Güven: community.

### 2.2 Akbank yeni sanal POS API (JSON)
- Alanlar: `merchantSafeId` (Güvenli İşyeri No), `terminalSafeId`, `secretKey`* (Güvenlik Anahtarı); opsiyonel `subMerchantId`. Panel yolları (WiseCP): Yönetim > Üye İşyeri Bilgileri / Terminal İşlemleri / Güvenlik Anahtarları.
- Host: canlı `https://api.akbank.com/api/v1/payment/virtualpos`, 3D `https://virtualpospaymentgateway.akbank.com/securepay`, host `/payhosting`. Test: `https://apipre.akbank.com/api/v1/payment/virtualpos`, `https://virtualpospaymentgatewaypre.akbank.com/securepay` ve `/payhosting`.
- İmza: header `auth-hash: base64(HMAC_SHA512(key=secretKey, rawJsonBody))`, `Content-Type: application/json`.
- Kimlik testi: `POST {api}/transaction/process`
  ```json
  {"version":"1.00","txnCode":"1010","requestDateTime":"2026-10-24T12:00:00.000",
   "randomNumber":"<128 hex>","terminal":{"merchantSafeId":"..","terminalSafeId":".."},
   "order":{"orderId":"credcheck-123"}}
  ```
  (1010 = sipariş tarihçesi). HTTP ≥400 + `code`/`message` hata demek. Alternatif `portal/report/transaction` (txnCode 1009).
- 3D form hash: `paymentModel + txnCode + merchantSafeId + terminalSafeId + orderId + lang + amount + ccbRewardAmount + pcbRewardAmount + xcbRewardAmount + currencyCode + installCount + okUrl + failUrl + emailAddress + subMerchantId + creditCard + expiredDate + cvv + randomNumber + requestDateTime + b2bIdentityNumber`, `base64(HMAC_SHA512(secretKey))`.
- Test kartı (mewebstudio): `4355093000315232` 01/28 264.
- Güven: community.

### 2.3 Garanti BBVA (GVP)
- Docs: https://dev.garantibbva.com.tr (Sanal POS bölümü)
- Alanlar: `merchantId` (Firma/İşyeri no), `terminalId`, `provUserId` (genelde `PROVAUT`), `provisionPassword`* (PROVAUT şifresi), `storeKey`* (3D secure anahtarı); iade/iptal için `PROVRFN` kullanıcısı + şifresi*.
- Host: canlı `https://sanalposprov.garanti.com.tr/VPServlet` ve `/servlet/gt3dengine`; test `https://sanalposprovtest.garantibbva.com.tr/VPServlet` ve `/servlet/gt3dengine`. İstekte `Mode` = `TEST` | `PROD`.
- Yayımlanmış test seti (CP.VPOS unit test, community): merchantId `7000679`, terminalId `30691297`, PROVAUT şifresi `123qweASD/`, storeKey `12345678`. Test kartı (mewebstudio): `4282209004348015` 08/30 123.
- **Kimlik testi**: `POST VPServlet`, ham XML `<GVPSRequest>`:
  - `Mode`, `Version=512`, `Terminal{ProvUserID, UserID, HashData, ID, MerchantID}`, `Customer{IPAddress}`, `Order{OrderID=<sahte>}`, `Transaction{Type=orderinq, InstallmentCnt="", Amount=100, CurrencyCode=949, CardholderPresentCode=0, MotoInd=N}`
  - `SecurityData = UPPER(hex(SHA1(provisionPassword + terminalId.padStart(9,'0'))))`
  - `HashData = UPPER(hex(SHA512(OrderID + TerminalID + CardNumber("") + Amount + CurrencyCode + SecurityData)))`
  - Alternatif: `Type=bininq`, `Version=v0.1`, `BINInq{Group=A, CardType=A, BINNum}`.
- 3D hash: `UPPER(SHA512(terminalid + orderid + txnamount + txncurrencycode + successurl + errorurl + txntype + txninstallmentcount + storeKey + SecurityData))`. Callback: `hashparams` (':' ayrımlı) + storeKey.
- 3D modelleri: 3D, 3D_PAY, 3D_OOS_PAY (3D_HOST).
- Güven: community.

### 2.4 Posnet (Yapı Kredi)
- Alanlar: `mid` (üye işyeri no), `tid` (terminal no), `posnetId`, `ENCKEY`* (3D anahtarı; ör. `10,10,10,10,10,10,10,10`).
- Host: canlı `https://posnet.yapikredi.com.tr/PosnetWebService/XML` ve 3D `/3DSWebService/YKBPaymentService`; test `https://setmpos.ykb.com/PosnetWebService/XML` ve `/3DSWebService/YKBPaymentService`.
- İstek: `application/x-www-form-urlencoded`, gövde `xmldata=<posnetRequest>…` (ISO-8859-9).
- Kimlik testi: `<posnetRequest><mid/><tid/><agreement><orderID>…</orderID></agreement></posnetRequest>` (durum sorgusu, mid/tid doğrular). ENCKEY yalnızca 3D'de (`firstHash = b64(SHA256(ENCKEY;tid))`, MAC = `b64(SHA256(xid;amount;currency;mid;firstHash))`) doğrulanır.
- Test kartı (mewebstudio): `4048095010857528` 05/28 454.
- 3D: 3D (OOS: `oosRequestData` + `oosResolveMerchantData` + `oosTranData`).
- Güven: community.

### 2.5 PosNet V1 JSON (Albaraka Türk)
- Alanlar: MerchantNo (10 hane), TerminalNo (8 hane), PosNet/EPOS no (16 hane), ENCKEY*.
- Host: canlı `https://epos.albarakaturk.com.tr/ALBMerchantService/MerchantJSONAPI.svc`, test `https://epostest.albarakaturk.com.tr/...`; 3D `.../ALBSecurePaymentUI/SecureProcess/SecureVerification.aspx`.
- Kimlik testi: `TransactionInquiry` JSON `{ApiType:"JSON", ApiVersion:"V100", MerchantNo, TerminalNo, MACParams:"MerchantNo:TerminalNo", OrderId, ..., MAC}`. `MAC = b64(SHA256(MerchantNo + TerminalNo + ENCKEY))`. Bu yöntem ENCKEY'i de doğrular.
- Güven: community.

### 2.6 PayFor (QNB, Enpara, Ziraat Katılım)
- Alanlar: `MerchantId`, `UserCode`, `UserPass`*, `MerchantPass`* (3D storeKey), `MbrId` (QNB `5`, Ziraat Katılım `12`).
- Host: QNB canlı `https://vpos.qnb.com.tr/Gateway/XMLGate.aspx`, 3D `/Gateway/Default.aspx`, host `/Gateway/3DHost.aspx`; test `https://vpostest.qnb.com.tr/...`. Ziraat Katılım canlı `https://vpos.ziraatkatilim.com.tr/Mpi/XMLGate.aspx`, test `https://payfortestziraatkatilim.cordisnetwork.com/Mpi/XMLGate.aspx`. Ziraat Katılım'da 3D hash kontrolü çalışmıyor (mewebstudio devre dışı bırakıyor).
- Kimlik testi: `POST XMLGate.aspx` `text/xml`, `<PayforRequest><MerchantId/><UserCode/><UserPass/><MbrId/><OrgOrderId>sahte</OrgOrderId><SecureType>Inquiry</SecureType><TxnType>OrderInquiry</TxnType><Lang>TR</Lang></PayforRequest>`.
- 3D hash: `b64(SHA1(MbrId + OrderId + PurchAmount + OkUrl + FailUrl + TxnType + InstallmentCount + Rnd + MerchantPass))`.
- Test kartı (mewebstudio): `4155650100416111` 01/28 123.
- Güven: community.

### 2.7 InterVPOS (DenizBank)
- Alanlar: `ShopCode`, `UserCode`, `UserPass`*, `MerchantPass`* (3D).
- Host: canlı `https://inter-vpos.com.tr/mpi/Default.aspx` (API ve 3D aynı), 3D host `/mpi/3DHost.aspx`; test `https://test.inter-vpos.com.tr/mpi/...`.
- Kimlik testi: form-urlencoded `UserCode, UserPass, ShopCode, orgOrderId=<sahte>, TxnType=StatusHistory, SecureType=NonSecure, Lang=TR`.
- 3D hash: `b64(SHA1(ShopCode + OrderId + PurchAmount + OkUrl + FailUrl + TxnType + InstallmentCount + Rnd + MerchantPass))`.
- Güven: community.

### 2.8 PayFlex / VPOS 7/24 (VakıfBank, Ziraat PayFlex, İşbank PayFlex)
- Alanlar: `MerchantId` (HostMerchantId / Üye İşyeri No), `Password`* (API şifresi), `TerminalNo` (POS no). Ayrı 3D storeKey yok.
- Host: VakıfBank canlı `https://onlineodeme.vakifbank.com.tr:4443/VposService/v3/Vposreq.aspx`, MPI `https://3dsecure.vakifbank.com.tr:4443/MPIAPI/MPI_Enrollment.aspx`, sorgu `https://onlineodeme.vakifbank.com.tr:4443/UIService/Search.aspx`; test aynı yollar `onlineodemetest.` ve `3dsecuretest.` ile. Ziraat canlı `https://sanalpos.ziraatbank.com.tr/v4/v3/Vposreq.aspx`, test `https://preprod.payflex.com.tr/Ziraatbank/VposWeb/v3/Vposreq.aspx`. Common Payment (ortak ödeme): canlı `https://cpweb.vakifbank.com.tr/CommonPayment/api`, test `https://cptest.vakifbank.com.tr/CommonPayment/api`.
- Ödeme istekleri `prmstr=<VposRequest>` form-urlencoded.
- Kimlik testi: Search.aspx'e `<SearchRequest><MerchantCriteria><HostMerchantId/><MerchantPassword/></MerchantCriteria><TransactionCriteria><TransactionId/><OrderId>sahte</OrderId><AuthCode/></TransactionCriteria></SearchRequest>`.
- 3D: MPI enrollment (3D, ardından Vposreq ile provizyon) veya Common Payment (3D_PAY/3D_HOST).
- Test kartı (mewebstudio): `4938410157705591` 12/29 453.
- Güven: community.

### 2.9 Kuveyt Türk (TDV2.0.0) ve Vakıf Katılım (Boa)
- Alanlar: `MerchantId` (mağaza no), `CustomerId` (müşteri no), `UserName` (API kullanıcı), `Password`*.
- Kuveyt Türk: canlı ödeme `https://sanalpos.kuveytturk.com.tr/ServiceGateWay/Home`, test `https://boatest.kuveytturk.com.tr/boa.virtualpos.services/Home`. Sorgu SOAP canlı `https://boa.kuveytturk.com.tr/BOA.Integration.WCFService/BOA.Integration.VirtualPos/VirtualPosService.svc/Basic`, test aynı yol `boatest.`. SOAPAction `http://boa.net/BOA.Integration.VirtualPos/Service/IVirtualPosService/<Method>`.
- Herkese açık test seti (community, **çelişkili**): MerchantId `496`, CustomerId `400235`, kullanıcı `apitest` / şifre `api123` veya `apiuser1` / `Api123`. Test kartı `5188961939192544` 06/29 588.
- İmza: `HashedPassword = b64(SHA1(Password))`; `HashData = b64(SHA1(MerchantId + MerchantOrderId + Amount + OkUrl + FailUrl + UserName + HashedPassword))` (boş alanlar "" olarak).
- Kimlik testi: SOAP `GetMerchantOrderDetail` (sahte MerchantOrderId, tarih aralığı). Ödeme dışı tek sorgu yolu bu.
- Vakıf Katılım: canlı `https://boa.vakifkatilim.com.tr/VirtualPOS.Gateway/Home`, ortak ödeme `/CommonPaymentPage/CommonPaymentPage`. Ayrı test host'u bulunamadı (mewebstudio test config'i canlı host'u kullanıyor).
- 3D: 3D (kart bilgisi bankaya POST, sonra `ThreeDModelProvisionGate` ile provizyon); Vakıf Katılım'da 3D_HOST.
- Güven: community.

### 2.10 Diğer bankalar / doğrulanamayanlar
- **Türkiye Finans, ING, Anadolubank, Alternatif, Şekerbank, TEB, Halkbank**: Nestpay (§2.1).
- **Ziraat Bankası**: hem Nestpay (sanalpos2) hem PayFlex (§2.8). Üye hangisini aldıysa onu seçmeli.
- **Ziraat Katılım**: PayFor (§2.6).
- **Odeabank, Fibabanka, Emlak Katılım**: altyapı **unknown**. Açık kaynak kütüphanelerin hiçbirinde yok, resmi doküman bulunamadı. Bankaya sorulmalı.
- Ek olarak kütüphanelerde gördüğüm ödeme kuruluşları (istenmediği için detaylandırmadım): Paratika ve Payten MSU (`entegrasyon.paratika.com.tr/paratika/api/v2`, `merchantsafeunipay.com/msu/api/v2`), ZiraatPay, VakıfPayS, Tami (`sandbox-paymentapi.tami.com.tr`), Ahlpay (`testahlsanalpos.ahlpay.com.tr`), PayNKolay (`paynkolaytest.nkolayislem.com.tr`).

---

## 3. Durum notları (aktif olmayan veya kart API'si olmayanlar)
- **Stripe**: stripe.com/global listesinde Türkiye yok (preview/extended dahil). TR'de kurulu şirketleri onboard etmiyor. (docs)
- **PayPal**: BDDK lisans reddi sonrası 6 Haziran 2016'da TR faaliyetini durdurdu. 2022 itibarıyla değişiklik yok. Daha yeni bir resmi kaynak bulunamadı. (community, haber)
- **PayU Türkiye**: PayU 2019'da iyzico'yu satın aldı. Ayrı bir PayU TR merchant API'sinin hâlâ aktif olduğuna dair kaynak bulunamadı. iyzico'yu kullanın, PayU TR'yi listeye koymayın (unknown).
- **BKM Express**: Herkese açık merchant API dokümanı yok. Aggregator'lar (Craftgate, Esnekpos, iyzico) üzerinden APM olarak sunuluyor.
- **Ozan (Ozan Elektronik Para)**: Sanal POS ürünü var (Payfull ortaklığı), herkese açık API dokümanı bulunamadı (unknown).
- **Paytrek**: Güncel doküman veya faaliyet bilgisi bulunamadı (unknown). Eklenmemeli.
- **Papara**: Kart sanal POS'u değil, cüzdan ile ödeme (§1.6).
- **Shopier**: Ödeme yalnızca hosted form (§1.16).

---

## 4. "Test" butonu için önerilen davranış
| Sonuç | Anlamı |
|---|---|
| `ok` | Kimlik testi çağrısı başarılı (veya "sipariş bulunamadı" döndü) |
| `auth_failed` | Sağlayıcı kimlik/imza hatası döndü |
| `network` | DNS/TLS/timeout/IP kısıtı (403) |
| `unverifiable` | storeKey/ENCKEY/MerchantPass gibi yalnız 3D'de kullanılan alanlar, ya da sunucu testi olmayan sağlayıcı (Shopier, Lidio, Hepsipay kısmi) |

Her platform için ilk gerçek testte ham yanıtı loglayın (gizli alanlar maskeli). Kimlik hatası mesajlarının birçoğu (Nestpay `ErrMsg`, PosNet `respText`, Garanti `ErrorMsg`, iyzico `errorCode`) burada **unknown** olarak bırakıldı.

---

## 5. Kaynaklar
- mewebstudio/pos (Temmuz 2026): https://github.com/mewebstudio/pos (config/pos_production.php, config/pos_test.php, src/Crypt, src/DataMapper, examples/.env.dist, examples/*/_payment_config.php)
- evrenonur/sanalpos: https://github.com/evrenonur/sanalpos (Gateways/Banks/Nestpay/*, Providers/CCPayment/*)
- cempehlivan/CP.VPOS: https://github.com/cempehlivan/CP.VPOS (README alan tablosu, Integrations/*, CP.VPOS.Test/UnitTest.cs)
- iyzico docs: https://docs.iyzico.com/en/getting-started/preliminaries/authentication/hmacsha256-auth, https://docs.iyzico.com/en/advanced/installment-and-bin-service, https://docs.iyzico.com/en/add-ons/test-cards.md; SDK https://github.com/iyzico/iyzipay-node
- PayTR BIN: https://dev.paytr.com/en/direkt-api/bin-sorgulama-servisi; iFrame: https://dev.paytr.com/en/iframe-api/iframe-api-1-adim
- Sipay: https://apidocs.sipay.com.tr/, https://apidocs.sipay.com.tr/generating-token-23283730e0, https://apidocs.sipay.com.tr/hash-creation-2106879m0
- Craftgate SDK: https://github.com/craftgate/craftgate-node-client (src/lib/HttpClient.ts, utils.ts, adapter/InstallmentAdapter.ts)
- Paynet: https://doc.paynet.com.tr/authentication, https://doc.paynet.com.tr/servisler/oran/oran-tablosu-sunucu-tabanli.md, https://doc.paynet.com.tr/llms.txt
- Esnekpos: https://developer.esnekpos.com/hoppa-gelistirici-ortami/entegrasyon/test-ortami.md, https://developer-eng.esnekpos.com/esnekpos-developer-environment/merchant-balance-inquiry-service.md, .../installment-and-rate-listing.md
- Papara SDK: https://www.npmjs.com/package/@papara/papara (dist/client/paparaRequest.js, httpClient.js)
- Moka: https://github.com/activemerchant/active_merchant/blob/master/lib/active_merchant/billing/gateways/moka.rb; CP.VPOS Moka.cs
- Hepsipay: https://dev.hepsipay.com/docs/on-hazirliklar/, https://dev.hepsipay.com/docs/backend-entegrasyonu/checkavailability/, https://dev.hepsipay.com/docs/apipay/imza-hesaplama-algoritmasi/
- Ödeal: https://github.com/tcgunel/omnipay-odeal; Paycell: https://github.com/yasinkuyu/omnipay-paycell
- Shopier: https://developer.shopier.com/, https://www.npmjs.com/package/shopier-api
- Stripe: https://stripe.com/global; PayPal TR: https://t24.com.tr/haber/paypal-turkiyeden-cekildi,342896, https://www.birgun.net/haber/paypal-altinci-kez-meclis-gundeminde-lisans-verilmemesinin-sebebi-nedir-375094
- Garanti dev portal: https://dev.garantibbva.com.tr; Kuveyt test değerleri: https://packagist.org/packages/elsayed85/bank3; Akbank/Kuveyt alan açıklamaları: https://docs.wisecp.com/en/turkish-bank-virtual-pos-modules.md
