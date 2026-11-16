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
| Stripe | Checkout (3D) | Var (off-session) | `/v1/refunds` | Türkiye'de kurulu şirketleri kabul etmiyor. Webhook yok: ödeme, müşterinin tarayıcısı panele döndüğünde ya da tahsilat çalıştırması Stripe'a yeniden sorduğunda işlenir |
| Craftgate | Ortak Ödeme Formu (3D) | Var (3D'siz POS gerekir) | `/payment/v1/refunds` | Sonuç `checkout-payments/{token}` ile doğrulanır |
| Param | Ortak Ödeme Sayfası (3D) | Yok | `TP_Islem_Iptal_Iade_Kismi2` | IP izni gerekir; TMSF kayyımı haberi var. Dönüş Param'a ayrıca sorulmaz: özet (hash), GUID ve işlem numarası denetlenir |

Ayarlar → Ödeme'deki diğer 41 sağlayıcının (bankalar, diğer ödeme kuruluşları, Papara, PayPal, Mollie, Adyen ve
benzerleri) yalnızca bilgileri kaydedilip sınanabilir; tahsilatları yazılmadı ve müşteriye ödeme yöntemi olarak
sunulmazlar ([payments.md](payments.md)). **Gerçek bir üye işyeri hesabıyla hiçbir kuruluş denenmedi**: canlıya
almadan önce her biriyle test modunda bir ödeme ve bir iade yapın.

Bilinen iki açık:

- **Stripe:** Stripe'tan bildirim alan bir webhook yok. Müşteri ödemeyi yapıp panele dönmeden sekmeyi kapatırsa
  ödeme hemen işlenmez; tahsilat çalıştırması (beş dakikada bir) açık kalan ödemeyi başladıktan beş dakika sonra
  Stripe'a sormaya başlar ve sonucu işler, bir gün içinde ödenmeyen ödemeyi "süresi doldu" olarak kapatır. Aynı
  yeniden sorma iyzico ve Craftgate'te de vardır; PayTR ve Param'da yoktur.
- **Param:** dönüşün doğruluğu yalnızca özet, GUID ve işlem numarasına dayanır; bunlar aynı üye işyerinin bir dönüşünü
  görmüş biri tarafından üretilebilir. Param'dan gelen ödemeleri hesap ekstresiyle karşılaştırın.

## Saatlik kullanım, bütçe ve boyut değişikliği

- **Saatlik (kullandıkça öde):** faturalandırma ayarlarında saatlik satış ve bakiye açıksa ve pakete saatlik fiyat
  verilmişse müşteri sunucuyu saatlik sipariş edebilir. Ücret
  bakiyeden düşülür; harcanabilir tutar bakiyeden henüz faturalanmamış kullanım ve ödenmemiş kullanım faturaları
  çıkarılarak bulunur. Bakiye bitince sunucu bekletilir (kapatılır ve müşteriye kilitlenir), bakiye yüklenince
  açılır. Ay sonunda kullanım faturası kesilir.
- **Aylık bütçe:** müşteri bir tutar ve para birimi belirler. Panel, o para birimindeki sunucularının ve sanal veri
  merkezlerinin aylık toplamını bu tutarla karşılaştırır: sipariş sayfası bütçeyi aşacak siparişte önceden uyarır,
  toplam bütçeyi geçince takvim ayında bir kez `billing.budget_exceeded` bildirimi gider. Bütçe hiçbir şeyi
  durdurmaz, yalnızca haber verir.
- **Boyut büyütme (gün hesabı):** faturalandırma açıkken bir sunucu büyütüldüğünde, yeni ve eski aylık fiyat
  arasındaki farkın dönemin kalan günlerine düşen kısmı faturalanır. Disk yalnızca büyür.
- **WHMCS / WISECP:** satışı bu sistemlerden biri yapıyorsa `integrations/` altındaki modüller sunucuyu panelde
  oluşturur, askıya alır, boyutunu değiştirir ve siler. Bu sunuculara panel fatura kesmez. WHMCS modülü sunucu modülü
  yapısına göre yazıldı; WISECP modülü bir WISECP kurulumunda denenmedi ([integrations/README.md](../integrations/README.md)).

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
