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
- Gizli alanlar geri okunmaz. Boş bırakılan gizli alan kayıtlı değeri korur.
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
| Belirsiz | Yanıt geldi ama doğrulamıyor; sağlayıcının mesajı gösterilir. |
| Ulaşılamadı | Ağ, TLS veya IP kısıtı (HTTP 403 dahil). |
| Test edilemez | Shopier, Hepsipay, Paycell, Kuveyt Türk, Vakıf Katılım ve Ziraat PayFlex için güvenli bir sorgu yok. |

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
  verir.
- **Test ve canlı:** Sandbox kapatıldığında bekleyen sandbox ödemeleri, bir sağlayıcı canlı moda alındığında test
  modunda başlamış bekleyen ödemeleri başarısız olur (`TEST_MODE_OFF`).
- Hiçbir sağlayıcı gerçek bir üye işyeri hesabıyla denenmedi. İmzalar ve istekler dokümanlara ve açık kaynak
  entegrasyonlara göre yazıldı; birim testleri bunları doğrular. Hata mesajlarının biçimi sağlayıcıdan
  sağlayıcıya değişir; ilk gerçek testte mesaj olduğu gibi gösterilir.

## Param: elle onay
Param'ın tarayıcı dönüşü, üye işyerine özgü bir sırla imzalı değildir ve panel sonucu Param'a ayrıca soramaz. Bu
yüzden dönüş **ödemenin kanıtı sayılmaz**:

- Başarılı görünen bir dönüşte ödeme **bekliyor** durumunda kalır ve "onay bekliyor" gerekçesini taşır
  (`NEEDS_CONFIRMATION`); Param'ın sipariş ve dekont numarası ile tutar ödemenin üzerinde yazar. Fatura ödenmemiş
  kalır; müşteriye ödemenin onay beklediği söylenir.
- Personel tahsilatı **Param panelinde** (ya da hesap ekstresinde) bu numaralarla bulur, tutarı karşılaştırır ve
  faturayı Yönetim → Faturalar'dan "Ödeme kaydet" ile kapatır. Sipariş kurulumu, askının kalkması ve bakiye
  yüklemesi bu adımdan sonra gerçekleşir.
- Reddedilen bir dönüş ödemeyi kapatır; müşteri yeniden deneyebilir.
- **Yalnızca TRY:** Param'ın ortak ödeme sayfası tutarı lira olarak alır. TRY dışındaki bir fatura ya da bakiye
  yüklemesi için Param sunulmaz ve seçilirse reddedilir (`PAYMENT_METHOD_UNAVAILABLE`).

Bu akış da gerçek bir Param üye işyeri hesabıyla denenmedi.
