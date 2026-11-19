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
   kurulum iptal edilerek adresler serbest kalır (ödemesi inceleme bekleyen sipariş, inceleme süresi boyunca geri çekilmez).
2. **Yenileme**: dönem bitiminden N gün önce fatura kesilir. Otomatik tahsilat açıksa önce bakiyeden, sonra varsayılan kayıtlı karttan
   çekilir (günde bir, en fazla ayarlanan sayıda deneme). Dönemi başlamamış, ödenmemiş yenileme faturası **sunucunun güncel fiyatını
   izler** ([aşağıda](#yenileme-faturası-sunucunun-fiyatını-izler)). İnceleme bekleyen bir ödemesi olan fatura otomatik tahsilata
   **girmez**: sağlayıcı o fatura için müşterinin parasını tutuyor olabilir; personel karar verdikten sonra yeniden girer
   ([payments.md](payments.md#incelemedeki-ödemeler)).
3. **Ödenmeyen yenileme**: son ödeme gününden önce hatırlatma; ertesi gün gecikme bildirimi (`past_due`); X gün sonra askıya alma
   (sunucu kapatılır ve müşteriye kilitlenir; kapatma ve silme dışında işlem, konsol yok); ayarlanmışsa Y gün sonra silme.
   Ödeme yapılınca askı kalkar ve sunucu yeniden açılır. Faturanın inceleme bekleyen bir ödemesi varsa hatırlatma, askıya alma ve
   silme, incelemenin başladığı andan itibaren en çok `reviewHoldDays` gün **bekler** (Ayarlar → Faturalandırma; varsayılan 7, `0`
   kapatır) ve müşteri o faturayı ikinci kez ödeyemez (`409 PAYMENT_IN_REVIEW`); gecikme bildirimi bir kez gider ve ödemenin
   incelendiğini söyler. Süre dolduğunda, inceleme hâlâ açıksa, adımlar kaldığı yerden işler
   ([payments.md](payments.md#incelemedeki-ödemeler)).
4. **İptal**: müşteri "dönem sonunda iptal" seçer; sunucu dönem sonuna kadar çalışır, sonra silinir.
5. **İade**: karta (sağlayıcı üzerinden) ya da bakiyeye; kısmi olabilir. e-Arşiv faturası teslimden itibaren 8 gün içinde tamamen
   iade edilirse entegratörde iptal edilir; aksi halde ekibe iade faturası gerektiği bildirilir (e-Fatura alıcısında iadeyi alıcı keser).

Tahsilat çalışması 5 dakikada bir (tek kopya), e-Fatura gönderimi 2 dakikada bir çalışır. Yönetici "Tahsilatı şimdi çalıştır" ile
elle de tetikleyebilir; düğme yalnızca o anda gerçekten bir çalıştırma sürüyorsa `409 BILLING_RUNNING` döner. Panel bir geri
yüklemeden sonra **beklemedeyken** tahsilat çalışmaz ([operations.md](operations.md#geri-yüklemeden-sonra-bekletme)).

### Yenileme faturası sunucunun fiyatını izler

Dönemi henüz başlamamış, ödenmemiş bir yenileme faturası sunucunun boyutu ya da diskleri değiştikçe güncel fiyata çekilir:

- fiyat değiştiğinde hemen (ücreti sıfır çıkan bir değişiklikte de), olmazsa bir sonraki tahsilat çalıştırmasında;
- fatura **itirazlıyken de**: itiraz neyin borçlu olunduğunu tartışır, fiyatı dondurmaz;
- **ödendiği anda bir kez daha**: ödeme sayfası açılırken, bakiyeden ya da kayıtlı karttan çekilirken ve personel faturayı elle
  kapatırken. Müşterinin gördüğü tutar ile ödediği tutar arasında fark olabilir.

Personelin "Ödeme kaydet" isteği, tutar o anda değiştiyse **bir kez** `409 INVOICE_AMOUNT_CHANGED` döner: yeni tutara bakın ve
işlemi yineleyin. Kısmen ödenmiş bir yenileme faturasının yeni tutarı ödenen tutara eşit ya da ondan azsa fatura **ödendi** olur ve
fazlası müşterinin bakiyesine yazılır. Kabul edilen bir itiraz bakiyeye en çok faturanın o andaki **kalan** tutarını yazar.

## Ödeme kuruluşları

| Kuruluş | Ödeme | Kayıtlı kartla yenileme | İade | Not |
|---|---|---|---|---|
| Sandbox (panelin kendi test sağlayıcısı) | Test kartı sayfası | Var | Var | Gerçek müşteri varken kapalı olmalı. Test kartları: `4242 4242 4242 4242` onay, `4000 0000 0000 0002` ret, `4000 0000 0000 9995` yetersiz bakiye, `4000 0000 0000 4954` incelemede bekler (`FRAUD_REVIEW`; kaydedilmez) |
| iyzico | Checkout Form (3D) | Var (hesap 3D'siz çekime izinliyse) | `/v2/payment/refund` | Sonuç `checkoutform/auth/ecom/detail` ile doğrulanır, imza kontrol edilir |
| PayTR | iFrame (3D) | Yok (kart saklama Direkt API ister) | `/odeme/iade` | Bildirim URL'si PayTR panelinde girilir: `https://<panel>/api/billing/callback/paytr`. Tutar, bildirimin imzasının kapsadığı `total_amount` ile denetlenir |
| Stripe | Checkout (3D) | Var (off-session) | `/v1/refunds` | Türkiye'de kurulu şirketleri kabul etmiyor. Webhook yok: ödeme, müşterinin tarayıcısı panele döndüğünde ya da tahsilat çalıştırması Stripe'a yeniden sorduğunda işlenir |
| Craftgate | Ortak Ödeme Formu (3D) | Var (3D'siz POS gerekir) | `/payment/v1/refunds` | Sonuç `checkout-payments/{token}` ile doğrulanır |
| Param | Ortak Ödeme Sayfası (3D) | Yok | `TP_Islem_Iptal_Iade_Kismi2` | IP izni gerekir; TMSF kayyımı haberi var. Yalnızca TRY. Dönüş ödemeyi işlemez: ödeme "onay bekliyor" kalır, personel Param panelinde doğrulayıp faturayı elle kapatır ([payments.md](payments.md#param-elle-onay)) |

Ayarlar → Ödeme'deki diğer 41 sağlayıcının (bankalar, diğer ödeme kuruluşları, Papara, PayPal, Mollie, Adyen ve
benzerleri) yalnızca bilgileri kaydedilip sınanabilir; tahsilatları yazılmadı ve müşteriye ödeme yöntemi olarak
sunulmazlar ([payments.md](payments.md)). **Gerçek bir üye işyeri hesabıyla hiçbir kuruluş denenmedi**: canlıya
almadan önce her biriyle test modunda bir ödeme ve bir iade yapın.

Bilinen iki açık:

- **Stripe:** Stripe'tan bildirim alan bir webhook yok. Müşteri ödemeyi yapıp panele dönmeden sekmeyi kapatırsa
  ödeme hemen işlenmez; tahsilat çalıştırması (beş dakikada bir) açık kalan ödemeyi başladıktan beş dakika sonra
  Stripe'a sormaya başlar ve sonucu işler, bir gün içinde ödenmeyen ödemeyi "süresi doldu" olarak kapatır. Aynı
  yeniden sorma iyzico ve Craftgate'te de vardır; PayTR ve Param'da yoktur.
- **Param:** dönüş Param'a sorularak doğrulanamadığı için ödemenin kanıtı sayılmaz. Başarılı bir dönüş ödemeyi
  "onay bekliyor" (`NEEDS_CONFIRMATION`) olarak bırakır; personel tahsilatı Param panelinde görüp faturayı elle
  kapatır. Ödeme incelemeye girdikten sonraki dönüşler ("reddedildi" dahil) yok sayılır. Kendiliğinden işleyen bir
  Param tahsilatı yoktur ([payments.md](payments.md#param-elle-onay)).

İncelemede bekleyen ödemeler (Param'ın onay bekleyenleri, tutarı tutmayanlar, sağlayıcının incelemeye aldıkları)
Yönetim → Faturalandırma → Ödemeler'de "İnceleme bekleyen" süzgeciyle (API: `GET /api/admin/billing/payments?status=review`)
listelenir ve özetin `paymentsInReview` alanında sayılır. Bir ödeme incelemeye girdiğinde `billing.manage` izni olan
personele `billing.payment_review` bildirimi gider; karar yine elle verilir. Para geldiyse personel faturayı "Ödeme
kaydet" ile kapatır ve faturanın inceleme bekleyen ödemeleri aynı işlemde kapanır (`cancelled`; para bir kez, elle
kaydedilen ödemeyle sayılır). Para gelmediyse ödemenin incelemesi hiçbir şey ödenmiş sayılmadan kapatılır (`POST
/api/admin/billing/payments/:id/close-review`, panelde "İncelemeyi kapat")
([payments.md](payments.md#incelemedeki-ödemeler)).

Müşterinin Genel bakış sayfasındaki **Yaklaşan ödemeler** bloğu faturalama özetinden ve fatura listesinden okur:
vadesi geçmiş ya da 7 gün içinde dolacak ödenmemiş faturalar (bakiye yükleme faturaları hariç, en çok üçü "Öde"
bağlantısıyla), sıradaki yenileme ve saatlik kullanımda bakiyenin bugünkü hızla ne zaman biteceği (üç günden az
kaldıysa uyarı rengiyle ve, bakiye yükleme açıksa, "Bakiye yükle" bağlantısıyla). Gösterecek bir şey yoksa blok hiç çizilmez.

Sıradaki yenilemeyi API hesaplar: faturalama özeti (`GET /api/billing/summary`) `nextRenewal` alanında en yakın
yenilemeyi `{ at, amount, currency, gross, servers, invoiced }` olarak, yenilenecek abonelik yoksa `null` verir.

- **Tutar** tahsilat çalıştırmasının keseceği faturanın tutarıdır: sunucunun şimdiki fiyatı (yoksa aboneliğin kendi
  tutarı), hâlâ geçerliyse kupon, dönemin tamamı ve alıcının vergisi. `gross: true` vergi dahil demektir; blok tutarın
  altına "vergi dahil" yazar.
- **Sayılmayanlar:** dönem sonunda iptal edilecek abonelik, sunucusu silinmek üzere olan abonelik ve dönemi zaten
  ödenmiş olan.
- **İki kez gösterilmez:** yenilemenin faturası kesilmiş ve ödenmemişse `invoiced: true` gelir ve blok yenileme
  satırını çizmez; o ödeme fatura olarak listelenir.
- `servers` o gün yenilenen abonelik sayısıdır; blok adları abonelik listesinden alır, eşleştiremezse sayıyı yazar.

Kalan sınırlar:

- Alıcının vergi kuralı okunamazsa tutar **vergisizdir** (`gross: false`) ve "vergi dahil" notu çıkmaz.
- Aynı gün birden çok para biriminde yenileme varsa yalnızca biri (kodu alfabetik olarak ilk olan) gösterilir;
  diğerleri o satırda yoktur.
- O günün yenilemelerinin bir kısmı faturalanmışsa satır yalnızca henüz faturalanmamış olanları toplar;
  faturalananlar fatura olarak görünür.
- Faturası kesilmiş yenilemede `amount` fatura satırının tamamıdır; fatura kısmen ödenmişse kalan tutar değildir.
  Blok bu durumda yenileme satırını göstermez, kalan tutar fatura satırında yazar.
- Fatura listesi yalnızca vadesi geçmiş ya da 7 gün içinde dolacak faturaları gösterir. Faturalar dönem sonundan 7
  günden daha önce kesiliyorsa (ayar; varsayılan 7 gün) faturası kesilmiş bir yenileme, vadesine 7 gün kalana kadar
  blokta görünmez.
- Yenileme hesaplanamazsa (hata günlüğe `billing_next_renewal_failed` olarak yazılır) alan `null` gelir ve satır
  çizilmez; özetin geri kalanı etkilenmez. Alanı hiç göndermeyen eski bir API'ye karşı arayüz önceki hesabına
  (aboneliklerin vergisiz tutarı) döner.

Hesap `billing-rules` birim testleri ve bir `security-billing` entegrasyon testiyle sınanır. Blok için bir uçtan uca
adım vardır (üç gün içinde vadesi dolan fatura tutarı ve "Öde" bağlantısıyla listelenir; ödendikten sonra blok hiç
çizilmez); adım `eaa0a4e` commit'indeki çalıştırmada geçti.
Yenileme satırı ve saatlik bakiye satırı 2026-11-19'dan beri uçtan uca adımdır (simülatörün kapasitesinde gerçek
durumdan: küçük bir bakiyeyle saatlik bir sunucu ve aylık yenilenen bir sanal veri merkezi). Blok tarayıcıda elle
gözden geçirilmedi.

## Bayiler: kim öder
Bayi, müşterisi için sunucu sipariş eder: sunucu müşterinindir, aboneliği ise bayinindir ve bayi indirimiyle bayiye
faturalanır (`apps/api/src/reseller.ts`). Kural şudur: **sunucuyu kim yönetebiliyorsa ücretini o öder.** Bir müşteri
bayinin olmaktan çıktığında bayi artık o sunucularda işlem yapamaz; ödeme de aynı anda müşteriye geçer
(`directBilling`, `billing.ts`).

Bir müşteri üç yolla bayiden ayrılır:

| Yol | Kim | Nereden |
|---|---|---|
| Müşteri kendisi ayrılır | müşteri | Hesabım → Profil → "Bayiden ayrıl" (`POST /api/reseller/leave`; bayisi olmayan hesapta `409 NOT_MANAGED`; müşteri adına oturum açmış personele `403 NOT_WHILE_IMPERSONATING`: bu karar hesabın sahibinindir) |
| Personel tek bir müşteriyi ayırır | `users.manage` | Yönetim → Kullanıcılar → bayinin kullanıcı özeti penceresi → müşteri listesinde "Bayiden çıkar" (`DELETE /api/admin/resellers/:id/customers/:customerId`). Listeyi `GET /api/admin/resellers/:id` yanıtındaki `customers` alanı verir (e-posta, ad, sunucu sayısı; en çok 500 müşteri) |
| Bayilik kaldırılır | `users.manage` | `DELETE /api/admin/resellers/:id`; bütün müşterileri birlikte ayrılır |

Üçünde de aynı şeyler, tek bir veritabanı işleminde olur:

- **Çalışan abonelikler müşteriye geçer** (`active`, `past_due`, `suspended` olanlar). Temiz başlar: durum `active`
  olur, ödeme askısı kalkar, bayinin kaydettiği dönem sonu iptali silinir, otomatik yenileme açılır, tahsilatın o
  sunucular için koyduğu silme işareti geri alınır. Bayinin gecikmesi müşterinin borcu değildir. Silme işareti
  **yalnızca aboneliği geçen sunucular için** geri alınır: aboneliği daha önce bitmiş ya da iptal edilmiş bir
  sunucuda (müşterinin kendi ödediği bir sunucu ya da bayinin ayrılmadan önce iptal ettiği) tahsilatın silme kararı
  yerinde kalır. Önceden bu işaret müşterinin bütün sunucularından kalkıyor ve bir sonraki tahsilat çalıştırması o
  sunucuya yeni bir abonelik açıyordu.
- **Bayinin o sunucular için kesilmiş yenileme faturaları iptal edilir**, ama yalnızca hiç ödenmemiş ve yalnızca bu
  sunucuların satırlarını taşıyanlar. Dönemleri serbest kalır; bir sonraki tahsilat çalıştırması **ödenmemiş ilk
  dönemi** müşteriye, kendi vadesi ve hatırlatmalarıyla faturalar.
- **Bayinin henüz ödenmemiş, kurulumu başlamamış siparişi** faturasıyla birlikte geri çekilir (süresi dolan bir
  sipariş gibi: kurulum iptal olur).
- **Bayinin diğer açık faturaları bayide kalır:** kurulmuş bir sunucunun ilk faturası, boyut ya da disk farkı,
  kısmen ödenmiş olanlar ve başka sunucularla ortak olanlar. Bunlar bayiden tahsil edilir, denetim kaydına
  `leftInvoices` olarak yazılır ve açık kaldıkları sürece ilgili aboneliğe bağlı ödenmemiş fatura olarak sayılmaya
  devam eder. Personelin bu faturalara bakması gerekir (tahsil etmek ya da iptal etmek).
- **Bayinin indirimi kalkar, fiyat kesinse.** Aboneliği müşteriye geçen sunucular bir sonraki faturadan itibaren
  liste fiyatıyla faturalanır (`listPrices`, `reseller.ts`): sunucunun fiyatı, ek disklerinin fiyatı ve aboneliğin
  tutarı değişir. Süren dönem için bir şey istenmez (bayi ödedi); bir sonraki yenileme ya da kimsenin ödemediği ilk
  dönem liste fiyatıyla kesilir. Bayide kalan bir fatura kesildiği fiyatı korur.
  - Panel sunucu başına tek bir fiyat saklar; uygulanmış indirimi ve liste fiyatını saklamaz. Liste fiyatı bu yüzden
    **bugünkü katalogdan** hesaplanır (paket ya da özel yapılandırma, ek IPv4, uygulama ve her ek disk) ve yalnızca
    bundan **bayinin şimdiki indirimi** düşüldüğünde sunucunun fiyatı kuruşu kuruşuna çıkıyorsa kabul edilir. O zaman
    tahmin yoktur: sunucu bugünkü katalog fiyatından bu indirimle fiyatlanmıştır.
  - Tutmuyorsa (katalog ya da indirim o günden beri değişti, personel fiyatı elle belirledi, bayinin indirimi yok,
    sunucu bir sanal veri merkezinde, dışarıdan faturalanıyor ya da aylık değil) **fiyat olduğu gibi kalır** ve
    sunucu personele listelenir: personelin ayırma yanıtında ve `reseller.customer_released` denetim olayında
    `pricesKept` (sunucu kimlikleri); panelde, kullanıcı özeti penceresinde sunuculara bağlantı veren bir uyarı.
    Fiyatı düzeltmek personelin işidir.
  - Müşteri yeni tutarları önceden görür: `GET /api/reseller/summary` → `managedBy.afterLeave` (sunucu, para birimi,
    şimdiki ve sonraki aylık fiyat; boş liste: bir şey değişmez). "Bayiden ayrıl" sorusu bunları listeler; ayrılma
    yanıtı (`listPrices`) ve bildirim de söyler.
- **Erişim kapanır:** bayinin açık konsolları kapatılır; bayinin sipariş verirken hesaba eklediği SSH anahtarı
  (`reseller` adlı) hesaptan ve sunucuların kayıtlı anahtar listesinden silinir, yani yeni sunucuya ve yeniden
  kuruluma verilmez. Çalışan sunucuların **içindeki** anahtara dokunulmaz; müşteriye giden bildirim bunu söyler.
- İki tarafa `account.reseller` bildirimi gider ([notifications.md](notifications.md#bayi-bildirimi-accountreseller));
  bayilik kaldırılırken bayiye gönderilmez. Olay `reseller.customer_released` olarak, kimin yaptığı (`by`), geçen
  abonelik sayısı, iptal edilen ve bayide kalan faturalar, liste fiyatına geçen sunucular (`listPrices`) ve fiyatı
  korunanlarla (`pricesKept`) denetim kaydına yazılır ve müşterinin Hesabım → Etkinlik listesinde görünür.

**Bayiyi kapatmak ayırmak değildir.** `PUT /api/admin/resellers/:id` ile `active: false` yapılan bayi müşterilerinin
sunucularında işlem yapamaz, ama müşteriler onun müşterisi ve abonelikler onun aboneliği olarak kalır (yeniden
açılabilsin diye). Yanıt ve denetim kaydı bayinin kaç çalışan abonelik ödediğini söyler (`billedSubscriptions`). Bunu
bitirmek için bayiliği kaldırın ya da müşterileri tek tek ayırın.

**Müşteri ne görür:** `GET /api/reseller/summary` yanıtındaki `managedBy` alanı (bayinin adı, e-postası, markası,
açık olup olmadığı, `afterLeave`) Hesabım → Profil'de bir kart olarak gösterilir: bayinin neleri yapabildiği, neleri
yapamadığı, iletişim adresi ve ayrılma düğmesi. Ayrılma sorusu, fiyatı değişecek sunucuları ayrıldıktan sonraki aylık
tutarlarıyla listeler. Müşteri paneli ilk kullandığında bir kez bildirim alır.

Bilinen boşluklar:

- Ayrılma, bayinin tam o anda verdiği bir siparişle çakışırsa o sipariş ayrılmanın dışında kalabilir (bayiye
  faturalanmış ya da bayinin anahtarını taşıyor olabilir). Bu yarış kapatılmadı.
- Müşterinin etkinlik listesinde bayinin sunucu işlemleri, siparişleri, hesabı açması ve, 2026-11-19'dan beri,
  sunucuda işlem başlatmadan yaptıkları (konsol, zamanlama, etiket, disk, imaj, ad, kilit) vardır. Bayinin sunucuları
  yalnızca görüntülemesi yoktur ([operations-modules.md](operations-modules.md#denetim-kaydı-hesap-etkinliği-ve-duyuru)).
- Liste fiyatı kesin bulunamayan sunucu, bayinin indirimli fiyatını ayrıldıktan sonra da korur; personel
  `pricesKept` listesine bakıp düzeltene kadar müşteri o fiyattan faturalanır.
- Liste fiyatı bugünkü katalogdan ve bayinin şimdiki indiriminden çıkar. Katalog ve indirim birlikte, sunucunun
  fiyatını yine aynı kuruşa getirecek biçimde değiştiyse panel bunu ayırt edemez; fiyat bugünkü kataloğa çekilir.
- Bu akış iki `security-leftovers` entegrasyon testindedir (ayrılma; bayiliğin kaldırılması ve personelin tek
  müşteriyi ayırması) ve bir `security-leftovers-2` testindedir (liste fiyatı, fiyatı korunan sunucu, tahsilatın
  silme kararının kalması, personelin müşteri adına ayrılamaması); `billing-rules` birim testleri kuralı sınar.
  Hesap sayfasındaki kart, "Bayiden ayrıl" ve yönetimdeki "Bayiden çıkar" 2026-11-19'dan beri uçtan uca adımdır;
  ayrılma sorusundaki yeni tutarların ve personelin gördüğü fiyat uyarısının uçtan uca adımı yoktur.

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
  arasındaki farkın dönemin kalan günlerine düşen kısmı faturalanır. Disk yalnızca büyür. **3, 6 ve 12 aylık
  dönemlerde** fark, dönemin **kalan aylarının tamamı** için hesaplanır (aylık fark × dönemin ay sayısı × kalan gün
  oranı). Personelin başarısız bir boyut değişikliğini yeniden denemesi, sunucu o işlemden sonra değiştiyse
  `409 SERVER_CHANGED` döner; arada eklenmiş bir diskin ücreti yeniden denemeyle silinmez.
- **WHMCS / WISECP:** satışı bu sistemlerden biri yapıyorsa `integrations/` altındaki modüller sunucuyu panelde
  oluşturur, askıya alır, boyutunu değiştirir ve siler. Bu sunuculara panel fatura kesmez. WHMCS modülü sunucu modülü
  yapısına göre yazıldı; WISECP modülü bir WISECP kurulumunda denenmedi ([integrations/README.md](../integrations/README.md)).
  Entegrasyonun açtığı müşteriler, panelin faturalaması kapalıyken panelden sipariş veremez (`EXTERNALLY_BILLED`);
  faturalama açıksa panelden verdikleri sipariş panelde faturalanır.
- **Fatura e-postası:** müşteri adına oturum açmış personel fatura profilindeki e-posta adresini değiştiremez
  (`NOT_WHILE_IMPERSONATING`). Aynı oturum hesabı bayiden ayıramaz ve devredilen sunucuyu kabul edemez.

## e-Fatura / e-Arşiv

- Alıcı e-Fatura mükellefiyse (her faturada entegratöre yeniden sorulur) PK etiketine e-Fatura (`TEMELFATURA` ya da `TICARIFATURA`),
  değilse e-postayla e-Arşiv (`EARSIVFATURA`, internet satışı) gider. Seriler ayrıdır (varsayılan `LVF`, `LVA`).
- UBL-TR 1.2: 16 karakterli numara, ETTN, KDV 0015 oran başına, %0'da istisna kodu (302 hizmet ihracı), TCKN'li tarafta ad/soyad,
  görünüm XSLT'si, e-Arşiv için gönderim şekli (ELEKTRONİK), ödeme şekli/tarihi/aracısı ve satıcının kendisinin taşıyıcı olduğu teslim bilgisi.
  Döviz faturalarında TCMB döviz satış kuru eklenir. Not olarak tutar yazıyla ve "Bu satış internet üzerinden yapılmıştır." yazılır.
- Entegratörler: İzibiz, Uyumsoft, Nilvera, EDM, QNB eFinans, BirFatura, Paraşüt ve Sandbox.
  **İzibiz ve Uyumsoft'a, yayımladıkları test kullanıcılarıyla gerçek e-Arşiv faturası gönderildi ve kabul edildi** (2026-10-27).
  Diğerleri yayımlanmış WSDL/OpenAPI belgelerine göre yazıldı; ilk kullanımda test ortamında bir fatura deneyin.
- **Ayarlar:** entegratörün API adresi değiştirildiğinde kayıtlı gizli alanlar (API anahtarı, parola) yeniden yazılmalıdır
  (`REQUIRED`). Test sonucu yalnızca sabit bir ileti ve durum sınıfı gösterir; entegratörün yanıt metni API günlüğündedir.
- Gönderilemeyen fatura artan aralıklarla (en fazla 8 kez) yeniden denenir; ilk ve beşinci hatada ekip bilgilendirilir. Yönetici fatura
  sayfasından "e-Faturayı yeniden gönder" diyebilir. Resmî PDF entegratörden alınıp gösterilir.

## Mali müşavirinizle doğrulayın

- Yurt dışı müşterilere KDV'siz (istisna 302) fatura: varsayılan kapalı.
- 11111111111 (TCKN'siz birey) ve 2222222222 (yabancı) yer tutucuları entegratörünüzün kabul ettiği biçimde mi?
- Barındırma hizmetinin "abonelik esaslı" sayılıp sayılmadığı (tesisat numarası alanı).
