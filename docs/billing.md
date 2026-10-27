# Faturalandırma, ödeme ve e-Fatura

Kod: `apps/api/src/billing.ts` (akış ve uç noktalar), `billing-rules.ts` (para, KDV, numara, TCKN/VKN, dönem, tahsilat adımları),
`billing-gateways.ts` + `billing-providers.ts` (ödeme kuruluşları), `einvoice.ts` + `einvoice-providers.ts` (e-Fatura/e-Arşiv),
`ubl.ts` + `ubl-xslt.ts` (UBL-TR 1.2), `zip.ts`. Araştırma notları: `research-payment-flows.md`, `research-einvoice.md`.

## Model

- **Abonelik**: her sunucu ve sanal veri merkezi için bir tane. Durumlar: `pending` (ilk ödeme bekleniyor), `active`, `past_due`
  (gecikmiş), `suspended` (askıda), `cancelled`, `ended`. Faturalandırma açılınca mevcut sunuculara aylık yıl dönümlerinde abonelik açılır.
- **Fatura**: ödenene kadar `unpaid` (ekranda "Ödeme bekliyor"; yasal numarası olmayan proforma). Ödenince numarası verilir
  (GİB biçimi: 3 karakter + yıl + 9 hane, her seri her yıl baştan) ve e-Fatura entegratörü seçiliyse oraya gider.
  Durumlar: `paid`, `cancelled`, `refunded`, `partially_refunded`. Alıcı ve satıcı bilgisi düzenlendiği anki haliyle saklanır.
- **Bakiye yükleme** satış değildir: ayrı faturası olmaz ve KDV içermez. Bakiyeden ödenen faturalar düzenlenir.
- **Ödeme**: sağlayıcı (`sandbox`, `iyzico`, `paytr`, `stripe`, `craftgate`, `param`, `balance`, `manual`), yöntem ve durum.
  Ödeme, her zaman sağlayıcıya sunucu tarafında sorularak (ya da imzası kontrol edilerek) onaylanır; sahte ya da başka bir ödemeye ait
  bildirim hiçbir şeyi değiştirmez.
- **Kayıtlı kart**: yalnızca sağlayıcının belirteci (şifreli) ve son dört hane tutulur.

## Akışlar

1. **Sipariş**: "Kurulumdan önce ödeme" açıksa sunucu kaydı ve adresleri ayrılır, kurulum işlemi `awaiting_payment` adımında bekler,
   müşteri faturaya yönlenir. Bakiye yetiyorsa hemen ödenir. Ödeme gelince kurulum başlar. Süresinde ödenmeyen sipariş geri çekilir ve
   kurulum iptal edilerek adresler serbest kalır.
2. **Yenileme**: dönem bitiminden N gün önce fatura kesilir. Otomatik tahsilat açıksa önce bakiyeden, sonra varsayılan kayıtlı karttan
   çekilir (günde bir, en fazla ayarlanan sayıda deneme).
3. **Ödenmeyen yenileme**: son ödeme gününden önce hatırlatma; ertesi gün gecikme bildirimi (`past_due`); X gün sonra askıya alma
   (sunucu kapatılır ve müşteriye kilitlenir; kapatma ve silme dışında işlem, konsol yok); ayarlanmışsa Y gün sonra silme.
   Ödeme yapılınca askı kalkar ve sunucu yeniden açılır.
4. **İptal**: müşteri "dönem sonunda iptal" seçer; sunucu dönem sonuna kadar çalışır, sonra silinir.
5. **İade**: karta (sağlayıcı üzerinden) ya da bakiyeye; kısmi olabilir. e-Arşiv faturası teslimden itibaren 8 gün içinde tamamen
   iade edilirse entegratörde iptal edilir; aksi halde ekibe iade faturası gerektiği bildirilir (e-Fatura alıcısında iadeyi alıcı keser).

Tahsilat çalışması 5 dakikada bir (tek kopya), e-Fatura gönderimi 2 dakikada bir çalışır. Yönetici "Tahsilatı şimdi çalıştır" ile
elle de tetikleyebilir.

## Ödeme kuruluşları

| Kuruluş | Ödeme | Kayıtlı kartla yenileme | İade | Not |
|---|---|---|---|---|
| Sandbox (panelin kendi test sağlayıcısı) | Test kartı sayfası | Var | Var | Gerçek müşteri varken kapalı olmalı |
| iyzico | Checkout Form (3D) | Var (hesap 3D'siz çekime izinliyse) | `/v2/payment/refund` | Sonuç `checkoutform/auth/ecom/detail` ile doğrulanır, imza kontrol edilir |
| PayTR | iFrame (3D) | Yok (kart saklama Direkt API ister) | `/odeme/iade` | Bildirim URL'si PayTR panelinde girilir: `https://<panel>/api/billing/callback/paytr` |
| Stripe | Checkout (3D) | Var (off-session) | `/v1/refunds` | Türkiye'de kurulu şirketleri kabul etmiyor |
| Craftgate | Ortak Ödeme Formu (3D) | Var (3D'siz POS gerekir) | `/payment/v1/refunds` | Sonuç `checkout-payments/{token}` ile doğrulanır |
| Param | Ortak Ödeme Sayfası (3D) | Yok | `TP_Islem_Iptal_Iade_Kismi2` | IP izni gerekir; TMSF kayyımı haberi var |

Diğer 21 kuruluşun bilgileri kaydedilip kontrol edilebilir; tahsilatları henüz yazılmadı. **Gerçek bir üye işyeri hesabıyla hiçbir
kuruluş denenmedi**: canlıya almadan önce her biriyle test modunda bir ödeme ve bir iade yapın.

## e-Fatura / e-Arşiv

- Alıcı e-Fatura mükellefiyse (her faturada entegratöre yeniden sorulur) PK etiketine e-Fatura (`TEMELFATURA` ya da `TICARIFATURA`),
  değilse e-postayla e-Arşiv (`EARSIVFATURA`, internet satışı) gider. Seriler ayrıdır (varsayılan `LVF`, `LVA`).
- UBL-TR 1.2: 16 karakterli numara, ETTN, KDV 0015 oran başına, %0'da istisna kodu (302 hizmet ihracı), TCKN'li tarafta ad/soyad,
  görünüm XSLT'si, e-Arşiv için gönderim şekli (ELEKTRONİK), ödeme şekli/tarihi/aracısı ve satıcının kendisinin taşıyıcı olduğu teslim bilgisi.
  Döviz faturalarında TCMB döviz satış kuru eklenir. Not olarak tutar yazıyla ve "Bu satış internet üzerinden yapılmıştır." yazılır.
- Entegratörler: İzibiz, Uyumsoft, Nilvera, EDM, QNB eFinans, BirFatura, Paraşüt ve Sandbox.
  **İzibiz ve Uyumsoft'a, yayımladıkları test kullanıcılarıyla gerçek e-Arşiv faturası gönderildi ve kabul edildi** (2026-10-27).
  Diğerleri yayımlanmış WSDL/OpenAPI belgelerine göre yazıldı; ilk kullanımda test ortamında bir fatura deneyin.
- Gönderilemeyen fatura artan aralıklarla (en fazla 8 kez) yeniden denenir; ilk ve beşinci hatada ekip bilgilendirilir. Yönetici fatura
  sayfasından "e-Faturayı yeniden gönder" diyebilir. Resmî PDF entegratörden alınıp gösterilir.

## Mali müşavirinizle doğrulayın

- Yurt dışı müşterilere KDV'siz (istisna 302) fatura: varsayılan kapalı.
- 11111111111 (TCKN'siz birey) ve 2222222222 (yabancı) yer tutucuları entegratörünüzün kabul ettiği biçimde mi?
- Barındırma hizmetinin "abonelik esaslı" sayılıp sayılmadığı (tesisat numarası alanı).
