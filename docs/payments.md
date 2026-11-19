# Ödeme yöntemleri

Ayarlar → **Ödeme**: Türkiye'deki ödeme kuruluşları, banka sanal POS'ları ve uluslararası kart işlemcileri. Ayrıntılı
araştırma (alanlar, adresler, imza yöntemleri, kaynaklar): [research-payments.md](research-payments.md).

> [!IMPORTANT]
> Bu sayfadaki 46 sağlayıcıdan **yalnızca beşiyle ödeme alınabilir: iyzico, PayTR, Craftgate, Param ve Stripe**
> (bir de panelin kendi test sağlayıcısı, Sandbox). Bunlardan **Param'da ödeme kendiliğinden işlenmez**: müşteri
> Param'ın sayfasında öder, ama faturayı personel elle kapatır ([aşağıda](#param-elle-onay)). Diğer 41 sağlayıcı için panel yalnızca hesap bilgilerini saklar ve
> çoğunu para hareketi olmayan bir sorguyla sınar; onlarla tahsilat, 3D yönlendirme ve iade **yazılmadı**. Etkinleştirilen
> ama tahsilatı yazılmamış bir sağlayıcı müşteriye ödeme yöntemi olarak sunulmaz. Tahsilat akışları:
> [billing.md](billing.md).

## Kapsam (46 sağlayıcı)
- **Ödeme kuruluşları:** iyzico, PayTR, Param, Sipay, Vepara, Moka United, Craftgate, Paynet, Esnekpos,
  Tosla, Ödeal, Paycell, Hepsipay, Shopier.
- **Cüzdan:** Papara.
- **Bankalar:** her banka kendi adıyla listelenir; aynı altyapıyı kullananlar aynı kodu paylaşır.
  - Payten Nestpay: İş Bankası, Akbank (eski), Halkbank, TEB, Şekerbank, Ziraat, QNB, ING, Türkiye Finans,
    Anadolubank, Alternatif Bank, Cardplus.
  - Akbank yeni API.
  - Garanti BBVA (GVP).
  - Yapı Kredi (Posnet).
  - Albaraka (PosNet V1).
  - QNB ve Ziraat Katılım (PayFor).
  - DenizBank (InterVPOS).
  - VakıfBank ve Ziraat (PayFlex).
  - Kuveyt Türk ve Vakıf Katılım (BOA).
- **Uluslararası:** Stripe, PayPal, Mollie, Adyen, Checkout.com, Razorpay, Square, Paddle. (Stripe ve PayPal Türkiye'de
  kurulu şirketlere hizmet vermez; yurt dışında şirketi olanlar içindir.)
- **Eklenmeyenler:**
  - PayU TR, Paytrek, Ozan, Lidio: herkese açık API dokümanı yok.
  - Odeabank, Fibabanka, Emlak Katılım: altyapıları bilinmiyor.
  - Aynı altyapıyı kullanan küçük kuruluşlar (QNBpay, PayBull vb.): adresleri doğrulanamadı.

## Canlı ve test bilgileri
- Her sağlayıcının **canlı** ve **test** bilgi seti ayrı sekmelerde girilir ve ikisi de saklanır.
  "Kullanılan mod" ödemelerde hangisinin kullanılacağını seçer.
- Bilgiler mod başına ayrı ayrı AES-256-GCM ile şifrelenir (bağlam `payments:<sağlayıcı>:<mod>`).
- Gizli alanlar geri okunmaz. Boş bırakılan gizli alan kayıtlı değeri korur; **API adresi değiştirildiyse korumaz**:
  o modun kayıtlı gizli alanları yeniden yazılmalıdır (boş bırakılan alan `REQUIRED` hatası verir). Böylece yalnızca
  ayar izni olan biri, okuyamadığı kayıtlı bir anahtarı başka bir adrese gönderemez. Test düğmesi de aynı kurala uyar.
- Herkese açık test hesabı yayımlanmış sağlayıcılarda "test hesabını doldur" düğmesi vardır: Param,
  Esnekpos, İş Bankası, Garanti, Paycell. Test kartları Gelişmiş bölümünde görünür.
- Sağlayıcı farklı bir adres verdiyse API adresi her mod için değiştirilebilir. Yalnızca herkese açık
  https adreslerine izin verilir (SSRF koruması).

## Test ve etkinleştirme
- **Test** düğmesi para hareketi olmayan bir istek gönderir:
  - BIN veya taksit sorgusu;
  - erişim anahtarı (token) isteği;
  - bankalarda var olmayan bir sipariş için durum sorgusu. "Sipariş bulunamadı" yanıtı kimlik bilgilerinin
    doğru olduğunu gösterir.
- Sonuçlar:

| Sonuç | Anlamı |
|---|---|
| Kabul edildi | Sağlayıcı bilgileri doğruladı. |
| Reddedildi | Kimlik veya imza hatası; ayrıca "kullanıcı/üye işyeri bulunamadı". |
| Belirsiz | Yanıt geldi ama doğrulamıyor. |
| Ulaşılamadı | Ağ, TLS veya IP kısıtı (HTTP 403 dahil). |
| Test edilemez | Shopier, Hepsipay, Paycell, Kuveyt Türk, Vakıf Katılım ve Ziraat PayFlex için güvenli bir sorgu yok. |

- Sonuç yalnızca bu sınıfı ve sabit bir iletiyi gösterir; **sağlayıcının yanıt metni panelde gösterilmez**, API
  günlüğüne yazılır (`docker compose logs api`).
- 3D anahtarları (storeKey, ENCKEY, MerchantPass) hiçbir API ile doğrulanamaz ve sonuçta ayrıca belirtilir.
- **Etkinleştirme** için seçilen modun kayıtlı bilgileriyle yapılmış bir test gerekir. Kabul edilen,
  belirsiz ve test edilemez sonuçlar etkinleştirmeye izin verir; reddedilen ve ulaşılamayan sonuçlar izin vermez.
- Etkin bir sağlayıcının o moddaki bilgileri ya da modu değişirse sağlayıcı devre dışı kalır; yeniden test gerekir.
- Etkin sağlayıcılar müşteriye sunulacak sırayla dizilir.
- Her kayıt, test ve açma/kapama denetim kaydına (audit) yazılır.

## Sınırlar
- **Tahsilat yalnızca beş sağlayıcıda var:** iyzico, PayTR, Craftgate, Param ve Stripe
  (`apps/api/src/billing-providers.ts`). Geri kalan 41 sağlayıcıda bu sayfa yalnızca bilgileri saklar ve sınar.
- **Stripe'ta webhook yok:** ödeme, müşterinin tarayıcısı Stripe'ın ödeme sayfasından panele döndüğünde Stripe'a
  sorularak işlenir. Müşteri ödedikten sonra panele dönmezse (sekmeyi kapatır, bağlantısı kopar) ödemeyi tahsilat
  çalıştırması Stripe'a yeniden sorarak işler: ödeme başladıktan beş dakika sonra başlar, bir gün sürer; o süre
  içinde fatura ödenmemiş görünür. iyzico ve Craftgate'te de böyledir.
- **Param'da ödeme elle onaylanır** ([aşağıda](#param-elle-onay)): dönüş, ödemenin kanıtı sayılmaz. Param'ın sorgu
  servisi (`TP_Islem_Sorgulama4`) bir üye işyeri hesabıyla denenemediği için kullanılmıyor.
- **Tutarı ya da para birimi tutmayan ödeme:** sağlayıcının farklı bir tutar ya da para birimiyle bildirdiği veya
  dolandırıcılık incelemesine aldığı ödeme başarısız sayılmaz; gerekçesi görünerek bekliyor kalır ve personel karar
  verir ([İncelemedeki ödemeler](#incelemedeki-ödemeler)). PayTR bildiriminde karşılaştırılan tutar, bildirimin
  imzasının kapsadığı toplamdır (`total_amount`); imzasız gelen `payment_amount` yalnızca daha küçükse dikkate alınır,
  imzalı tutarın yerine geçemez.
- **Fatura tutarı ödeme anında değişebilir:** dönemi başlamamış bir yenileme faturası, ödeme başlatılırken ya da
  alınırken sunucunun güncel fiyatına göre yeniden fiyatlanır ([billing.md](billing.md)).
- **Test ve canlı:** Sandbox kapatıldığında bekleyen sandbox ödemeleri, bir sağlayıcı canlı moda alındığında test
  modunda başlamış bekleyen ödemeleri başarısız olur (`TEST_MODE_OFF`).
- Hiçbir sağlayıcı gerçek bir üye işyeri hesabıyla denenmedi. İmzalar ve istekler dokümanlara ve açık kaynak
  entegrasyonlara göre yazıldı; birim testleri bunları doğrular. Hata mesajlarının biçimi sağlayıcıdan
  sağlayıcıya değişir; ilk gerçek testte sağlayıcının yanıtını API günlüğünden okuyun.

## Param: elle onay
Param'ın tarayıcı dönüşü, üye işyerine özgü bir sırla imzalı değildir ve panel sonucu Param'a ayrıca soramaz. Bu
yüzden dönüş **ödemenin kanıtı sayılmaz**:

- Başarılı görünen bir dönüşte ödeme **bekliyor** durumunda kalır ve "onay bekliyor" gerekçesini taşır
  (`NEEDS_CONFIRMATION`); Param'ın sipariş ve dekont numarası ile tutar ödemenin üzerinde yazar. Fatura ödenmemiş
  kalır; müşteriye ödemenin onay beklediği söylenir.
- Personel tahsilatı **Param panelinde** (ya da hesap ekstresinde) bu numaralarla bulur, tutarı karşılaştırır ve
  faturayı Yönetim → Faturalar'dan "Ödeme kaydet" ile kapatır. Sipariş kurulumu, askının kalkması ve bakiye
  yüklemesi bu adımdan sonra gerçekleşir; faturanın onay bekleyen ödemesi de aynı işlemde kapanır. Param panelinde
  tahsilat yoksa ödemenin incelemesi "İncelemeyi kapat" ile kapatılır ([aşağıda](#incelemedeki-ödemeler)).
- Henüz incelemeye girmemiş bir ödemede reddedilen dönüş ödemeyi kapatır; müşteri yeniden deneyebilir.
- **İncelemeye giren ödemeye sonraki dönüşler işlenmez.** Ödeme bir kez "onay bekliyor" olduktan sonra gelen her
  dönüş, **"reddedildi" dahil**, yok sayılır: dönüş imzasız olduğu için ödeme kimliğini bilen biri, gerçekten ödenmiş
  bir ödemeyi listeden düşüremez ya da personelin onaylarken baktığı notu değiştiremez.
- **Personel notunu panel yazar.** Not, **ödemenin panel kimliğiyle ve yapılacak işle** ("Param panelinde
  doğrulayın") başlar; Param'ın bildirdiği sipariş ve dekont numaraları ardından, kısaltılmış olarak gelir.
  Onaylarken Param panelindeki kaydı bu ödeme kimliği ve tutarla eşleştirin; yalnızca nottaki numaralara
  güvenmeyin.
- **Yalnızca TRY:** Param'ın ortak ödeme sayfası tutarı lira olarak alır. TRY dışındaki bir fatura ya da bakiye
  yüklemesi için Param sunulmaz ve seçilirse reddedilir (`PAYMENT_METHOD_UNAVAILABLE`).

Bu akış da gerçek bir Param üye işyeri hesabıyla denenmedi.

## İncelemedeki ödemeler
Personelin kararını bekleyen ödemeler **bekliyor** durumunda ve bir gerekçe koduyla durur: `NEEDS_CONFIRMATION`
(Param), `AMOUNT_MISMATCH` (tutar ya da para birimi tutmuyor), `FRAUD_REVIEW` (sağlayıcı incelemeye aldı).

- **Panelde:** Yönetim → Faturalandırma → Ödemeler'de "İnceleme bekleyen" süzgeci bunları en eskiden başlayarak
  listeler. Her satırda durum "İnceleme bekliyor" olarak, gerekçesi ve ne kadardır beklediğiyle görünür; "Faturayı
  aç" faturanın sayfasına götürür. Arama fatura numarasında, müşterinin e-postasında ve sağlayıcı referansında yapılır.
  Süzgeç ve arama adreste tutulur (`/admin/billing?tab=payments&status=review&q=…`), yani liste bağlantı olarak
  paylaşılabilir. Bekleyen ödeme varken faturalandırma özetinin üstünde sayıyı ve en eskisini söyleyen bir uyarı,
  yönetim menüsünde Faturalandırma'nın yanında bir sayaç (`GET /api/admin/attention`) ve Genel bakış'ta "ödeme
  inceleme bekliyor" içgörüsü (`PAYMENTS_IN_REVIEW`, `billing.view` izni olanlara) durur.
- **Karar elledir:** sağlayıcının panelinde kontrol edin. Hiçbir ödeme incelemeden kendiliğinden çıkmaz; iki yolu
  vardır:
  - **Para geldiyse** faturayı açıp "Ödeme kaydet" ile kapatın. Aynı işlemde o faturanın inceleme bekleyen bütün
    ödemeleri kapanır: durumları `cancelled` olur, gerekçeleri üzerlerinde kalır ve referanslarına hangi elle ödeme
    kaydıyla kapandıkları yazılır. Para **bir kez**, elle kaydedilen ödemeyle sayılır. Yanıt ve denetim kaydı kapanan
    ödemeleri verir (`closedReviews`); panel kaç ödemenin kapandığını söyler. Önceden böyle bir ödeme listede süresiz
    kalıyor ve sağlayıcının sonradan gelen "ödendi" yanıtı (biten bir dolandırıcılık incelemesi, tahsilat
    çalıştırmasının yeniden sorması ya da dönüş adresinin açılması) ödenmiş faturanın üstüne ikinci kez bakiye
    yazabiliyordu.
  - **Para gelmediyse** ya da fatura bu arada başka yolla ödendi ya da iptal edildiyse ödemenin satırındaki
    "İncelemeyi kapat" düğmesini kullanın (`billing.manage`; API: `POST
    /api/admin/billing/payments/:id/close-review`, isteğe bağlı `note`, en çok 150 karakter). Hiçbir şey ödenmiş
    sayılmaz, bakiyeye bir şey yazılmaz, fatura olduğu gibi kalır; ödeme `cancelled` olur, gerekçesi ve notunuz
    üzerinde kalır, olay `billing.review_closed` olarak denetim kaydına yazılır. İnceleme beklemeyen bir ödemede
    `409 PAYMENT_NOT_IN_REVIEW` döner. Sağlayıcı parayı gerçekten tahsil ettiyse iade sağlayıcının panelinden yapılır
    ya da tutar bakiye düzeltmesiyle verilir; panel bunu kendiliğinden yapmaz.
  - Kapatılan bir ödemeyi sonradan gelen hiçbir dönüş, bildirim ya da yeniden sorma değiştirmez (bunlar yalnızca
    bekleyen ödemeye işler). Kapatılan ödemeler listede `cancelled` durum süzgeciyle bulunur.
- **Otomatik tahsilat bekler.** İnceleme bekleyen ödemesi olan bir faturadan otomatik tahsilat (bakiye ve kayıtlı
  kart) **çekmez**: sağlayıcı müşterinin parasını o fatura için tutuyor olabilir. Personel karar verdikten sonra
  fatura yeniden tahsilata girer.
- **İnceleme süresi: fatura bekler ve ikinci kez ödenemez (`reviewHoldDays`).** Ayarlar → Faturalandırma'daki
  "İncelemedeki ödemenin faturasını beklettiği gün sayısı" (`reviewHoldDays`; 0-90, varsayılan 7) bir süre tanımlar.
  Süre incelemenin başladığı andan sayılır (`payments.review_since`; yoksa ödemenin başladığı an). Bu süre içinde,
  o fatura için:
  - sunucu **askıya alınmaz ve silinmez** (zaten askıda olan abonelikte gün sayımı sürer; silme, süre dolana kadar
    bekler);
  - ödenmemiş **sipariş, süresi dolduğu için geri çekilmez** (kurulum ve ayrılan adres o kadar bekler);
  - **hatırlatma gönderilmez.** Gecikme bildirimi (`billing.overdue`) yine bir kez gider ve abonelik `past_due`
    olur, ama bildirim ödemenin incelendiğini ve yeniden ödemek gerekmediğini söyler; böylece süre dolduktan sonraki
    bir askı habersiz gelmez;
  - **müşteri faturayı ikinci kez ödeyemez:** `POST /api/billing/invoices/:id/pay` her yöntemde (bakiye, kayıtlı
    kart, kart) `409 PAYMENT_IN_REVIEW` döner; denetim kart ödemesinin başladığı yerde ve bakiye ödemesinin içinde
    yeniden yapılır. İkinci bir ödeme parayı iki kez alabilirdi ve her biri personele ayrı bir bildirim
    gönderirdi.
  - Saatlik kullanımda, kullanım faturalarından birinin ödemesi incelemedeyken hesabın sunucuları **silinmez.**
    Bakiyesi eksiye düşen hesabın sunucularının saat başı **kapatılması bu beklemenin dışındadır.**
- **Süre dolduğunda koruma biter.** İnceleme hâlâ açıksa fatura her ödenmemiş fatura gibi yeniden tahsilata girer
  (hatırlatma, askı, ayarlıysa silme) ve yeniden ödenebilir. Kimsenin karar vermediği bir inceleme ödenmemiş bir
  sunucuyu o kadar korur, daha fazla değil, ve müşteriyi süresiz kilitlemez: askıya alınmış ya da silinecek bir
  sunucunun personeli beklemeyen bir çıkış yolu olmalıdır. **İncelemeleri bu süre içinde kapatın.** `0`, hem
  beklemeyi hem ikinci ödemenin reddini kapatır.
- **Saatte 20 kart ödemesi.** Bir hesap, bütün faturaları için toplam, saatte en çok 20 kart ödemesi başlatabilir
  (`429 RATE_LIMITED`).
- **Müşteri ne görür:** inceleme bekleyen ödemesi olan ödenmemiş faturanın sayfasında "Ödemeniz inceleniyor" notu
  durur ve sayfa sonucu beklemeyi bırakır. Ödeme düğmeleri inceleme süresi boyunca kapalıdır ve gerekçesini söyler
  ("Bu faturanın bir ödemesi incelemede; şimdilik yeniden ödenemez"); gönderilen bir isteği API yine reddeder.
- **`payBlockedUntil`:** fatura yanıtı (`GET /api/billing/invoices/:id` ve personelin fatura yanıtı)
  `invoice.payBlockedUntil` alanını taşır: incelemedeki bir ödemenin faturanın yeniden ödenmesini ne zamana kadar
  engellediği (ISO tarih); engel yoksa ve fatura ödeme beklemiyorsa `null`. Değer, `409 PAYMENT_IN_REVIEW` reddini
  veren aynı işlevle hesaplanır (süre içindeki en geç incelemenin başlangıcı artı `reviewHoldDays` gün), yani alan
  ile ret birbirinden ayrılmaz. Fatura sayfası ödeme düğmelerini bu ana kadar kapalı tutar; alanı göndermeyen eski
  bir API'ye karşı düğmeler açık kalır ve reddi ödeme rotası verir.
- **Sandbox'ta denemek:** panelin test sağlayıcısında `4000 0000 0000 4954` numaralı kart ödemeyi `FRAUD_REVIEW`
  gerekçesiyle incelemede bırakır; gerçek bir sağlayıcının bekletilen ödemesiyle aynı yolu izler ve kart
  kaydedilmez. Diğer test kartları: `4242 4242 4242 4242` onaylanır, `4000 0000 0000 0002` reddedilir,
  `4000 0000 0000 9995` yetersiz bakiye yanıtı verir. Dördü de yalnızca Sandbox sağlayıcısı açıkken çalışır; gerçek
  bir sağlayıcıda bu numaraların özel bir anlamı yoktur.
- **Bildirim:** bir ödeme incelemeye girdiğinde `billing.manage` izni olan personele `billing.payment_review`
  bildirimi gider (varsayılan kanallar panel ve e-posta; Ayarlar → Bildirim kuralları'ndan değiştirilir). Ödeme
  başına bir kez gönderilir; aynı ödeme için sonradan gelen yanıtlar yeniden bildirmez. Olay günlüğe de yazılır
  (`payment_needs_review`). Müşteri gerçekten ödemişse faturası inceleme süresi dolduktan sonra yeniden tahsilata
  girer; bekletmeyin. İnceleme süresince ikinci ödeme reddedildiği için bir müşteri aynı faturayı yeniden ödeyerek
  bu bildirimi çoğaltamaz.
- **Bekleme süresi** `payments.review_since` alanından okunur (migration `081`). Yükseltmeden önce incelemeye girmiş
  ödemelerde süre ödemenin başladığı andan sayılır. Gerekçe sonradan değişse de süre baştan başlamaz.
- Yönetici API'si: `GET /api/admin/billing/payments?status=review` (isteğe bağlı `q`) aynı listeyi verir; her
  satırda `review`, `reviewSince` ve gerekçe olarak `errorCode` bulunur. Faturalama özeti sayıyı ve en eski bekleyeni
  `paymentsInReview` alanında verir.
- İnceleme görünümü tarayıcıda elle gözden geçirilmedi. Uçtan uca testler süzgecin sunulduğunu, bekleyen ödeme
  yokken boş liste metnini ve süzgeç ile aramanın adreste kalıp yenilemeden sonra geri geldiğini kapsar. Bildirim ve
  liste `security-billing` entegrasyon testlerindedir.
- Bekleyen bir ödemeyle ilgili ekranlar için bir uçtan uca adım vardır ve `eaa0a4e` commit'indeki çalıştırmada geçti: Sandbox'taki inceleme kartıyla ödeme, müşterinin faturasındaki "Ödemeniz inceleniyor" notu, menüdeki sayaç (1) ve özetteki uyarı, listedeki satır (durum, gerekçe, "Faturayı aç"), "İncelemeyi kapat" ile kapatma, sayacın kalkması ve kapatılan ödemenin `cancelled` süzgecinde bulunması.
  "Ödeme kaydet"in bekleyen ödemeyi kapatması, bekletilen faturada ödeme düğmelerinin kapalı olması, API'nin ikinci
  ödemeyi reddetmesi ve ayardaki varsayılan 2026-11-19'dan beri uçtan uca adımdır (gerçek duruma karşı; `a2f2ff2`
  commit'indeki çalıştırmada geçti). Satırdaki bekleme süresi uçtan uca sınanmaz.
- İnceleme süresi kuralı `billing-rules` birim testlerinde ve dört `security-leftovers-2` entegrasyon testindedir
  (süre içinde askı ve silme yok, süre dolunca var; siparişin süresi dolmaz; hiçbir yöntemle ikinci ödeme yok, süre
  dolunca var, saatlik kart ödemesi sınırı; `payBlockedUntil` tam olarak ödemenin reddedildiği sürece doludur ve
  personel aynı değeri okur); testler 2026-11-19 tarihli tam çalıştırmada geçti. Sayfanın düğmeleri alana göre
  kapatması bir web birim testindedir. Gerçek bir sağlayıcı hesabıyla denenmedi.
- "Ödeme kaydet"in incelemeyi kapatması, sonradan gelen "ödendi" yanıtının bir şey yazmaması, elle kapatma ve otomatik tahsilatın beklemesi bir `security-billing` entegrasyon testindedir; test 2026-11-18 tarihli tam çalıştırmada geçti.
  İnceleme kartı ve PayTR tutar denetimi birim testlidir (`billing-providers`).
- Ödeme listesinde "Görünümler" düğmesiyle süzgeç ve arama kayıtlı görünüm olarak saklanabilir; görünümler hesapla
  birlikte saklanır ([operations-modules.md](operations-modules.md)).
