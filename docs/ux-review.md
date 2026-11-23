# Kullanım incelemesi (UX) — 2026-11-23

Müşteri, bayi ve yönetici tarafı, gerçek işler yapan biri gibi kod ve ekran üzerinden yürünerek incelendi: ilk giriş,
sunucu siparişi, bir sunucuyu yönetmek (güç, konsol, boyut, anlık görüntü, yedek, güvenlik duvarı, ağ), fatura ödemek,
destek talebi açmak, yöneticinin günlük kontrolleri ve kurulumu. Aranan: çıkmaz sokaklar, geri bildirimsiz işlemler,
nedeni ve sonraki adımı söylemeyen hatalar, geri alınamayan ya da orantısız onay isteyen işlemler, araması / sıralaması
/ boş durumu olmayan listeler, girdiyi kaybeden formlar, ilerleme göstermeyen beklemeler, gereksiz tıklamalar, benzer
ekranlar arasındaki tutarsızlıklar, klavye ve ekran okuyucu boşlukları, 44 px altı dokunma alanları, kontrast, 390 px
sorunları, TR/EN eksikleri. Kural kaynağı: `ui-ux-pro-max` (geri alma, taslak, hata kurtarma, boş durum, oturum
uyarısı, odak dönüşü, dokunma alanı kuralları) ve WCAG 2.2 AA.

**Özet:** 34 bulgu — **yüksek 5**, **orta 17**, **düşük 12**. 22'si bu işte düzeltildi, 1'i kısmen, 11'i nedeniyle
bırakıldı (ikisi bilerek: güvenlik işlemleri beklememeli).

**En kötü beş:**
1. Güvenlik duvarında "Ayır" tek tıkla, onaysız ve geri alınamaz biçimde sunucunun korumasını kaldırıyordu.
2. Güvenlik duvarının kaynak adresleri tek satırlık alandı: satır satır yapıştırılan liste tek bir yanlış değere
   ("1.2.3.45.6.7.8") birleşiyordu.
3. Oturum çerezi girişten 12 saat sonra, kullanılsa da, uyarısız bitiyordu (aşağıda); çalışan kişi ancak bittikten
   sonra öğreniyordu.
4. Toplu silme onayı, yöneticinin bekleme süresi kapalıyken de "süre dolana kadar geri alabilirsiniz" diyordu; API
   onaydan sonra reddediyordu.
5. Uzun işlemler (oluşturma, boyut, yedek, geri yükleme) yalnızca adım adı ve belirsiz bir çubuk gösteriyordu: ne zaman
   başladığı, genellikle ne sürdüğü, uzayıp uzamadığı yoktu.

## Bulgular

Önem: **Y** yüksek (bir işi bozar ya da veri / korumayı tek tıkla kaybettirir), **O** orta (işi zorlaştırır, yanıltır),
**D** düşük (cila, tutarlılık).

| # | Bulgu | Önem | Durum |
|---|---|---|---|
| 1 | Güvenlik duvarı → Sunucular → "Ayır": onay yok, geri alma yok, koruma hemen kalkıyor (`firewalls/[id]/detail.tsx`). | Y | **Düzeltildi:** ayırma birkaç saniye "Geri al" ile bekliyor, istek ileti kapanınca gidiyor. |
| 2 | Güvenlik duvarı kaynakları (ve diğer tek satırlık liste alanları) satır satır yapıştırılan listeyi birleştiriyor. | Y | **Düzeltildi:** yapıştırmada satır sonları virgüle çevrilir ve bunu söyler (`repairPaste`). |
| 3 | "Beni hatırla" ile açılan oturumun çerezi girişten `SESSION_TTL_HOURS` (12) saat sonra bitiyor; istekler veritabanındaki oturumu uzatıyor ama çerezi yeniden yazmıyor. Önceden uyarı yok. | Y | **Düzeltildi:** bitişten 5 dk önce uyarı, "Oturumu açık tut" yalnızca tıklamayla uzatır (`POST /auth/stay`). Sabit bitişler (kullanıcı olarak gir, dizin/SSO, rol süresi) nedenini söyler, uzatma sunulmaz. |
| 4 | Toplu silme onayı bekleme süresi kapalıyken de geri alma vaat ediyor; API sonra `ACTION_DISABLED` ile reddediyor (`servers-ui.tsx` BulkBar). | Y | **Düzeltildi:** onay saati söylüyor; süre kapalıysa düğme yerine neden ve ne yapılacağı yazıyor. |
| 5 | 44 px'den küçük dokunma alanları: toplu etiket kaldırma (24 px), ek dosya kaldırma (20 px). | Y | **Düzeltildi:** dokunmatik ekranda 44 px alan (`.hit-44`), görünüş aynı. |
| 6 | Uzun işlemlerde geçen süre ve beklenen süre yok. | O | **Düzeltildi:** "Genellikle yaklaşık 2 dakika", "Her zamankinden uzun sürüyor", neye dayandığı; bitince süresiyle sonuç. |
| 7 | Anlık görüntüye dönüş veri kaybettiriyor ama yalnızca düz onay istiyor; neyin kaybolacağı kesin değil. | O | **Düzeltildi:** sunucu adı yazılarak onay; metin tarihi ve kaybolanları söylüyor. |
| 8 | SSH anahtarı, proje, güç zamanlaması ve hazır yanıt silme "emin misiniz?" diye soruyor; hepsi güvenle birkaç saniye bekleyebilir. | O | **Düzeltildi:** "Geri al" iletisi; geri alınanı API hiç görmez. |
| 9 | Sipariş formu siparişler arasında hiçbir şey hatırlamıyor. | O | **Düzeltildi:** yeni sipariş en yeni sunucunun konumu, imajı, paketi/boyutu ve projesiyle başlar ve bunu söyler; "Boş başla". |
| 10 | Sipariş taslağı güvenlik duvarı seçimini tutmuyor; SSH anahtarı eklemek için sayfadan çıkınca kayboluyor. | O | **Düzeltildi:** seçim taslakta (yalnız kimlikler). |
| 11 | "Benzerini sipariş et" önceki bir kopyalama taslağını (`cloneFrom`) temizlemiyor; proje taşınmıyor. | O | **Düzeltildi.** |
| 12 | Panel sunucusu yanıt vermezken listeler yoklamayı sürdürüyor (her biri bir yeniden deneme ile), yeniden deneme düğmesi yok. | O | **Düzeltildi:** yoklama duraklar, tek bir istek 2–30 sn aralıkla dener, "Şimdi dene"; dönünce sayfa yenilenmeden sürer. |
| 13 | Bağlantı yokken gönderilen bir değişiklik (React Query'nin "çevrimdışı" durumunda) beklemeye alınıp sonra kendiliğinden çalışabilirdi. | O | **Düzeltildi** (bu iş sırasında bulundu): değişiklikler hemen başarısız olur, neden söylenir, form yazılanı tutar (`networkMode: 'always'`). |
| 14 | Yönetici başlangıç listesi ödeme yöntemi, yedek zamanlaması, izleme, güncellemeler, personelin iki adımlı doğrulaması ve e-postanın gerçekten gidip gitmediğini bilmiyor; kapatılamıyor. | O | **Düzeltildi:** "Sağlıklı tutar" adımları gerçek durumdan; "Bir şey değişene kadar gizle", bozulan adım listeyi geri getirir. |
| 15 | Çevirisi olmayan bir hata kodu ve kodsuz yanıtlar (vekil/ağ geçidi sayfası) "Bilinmeyen bir hata oluştu" oluyor: neden ve sonraki adım yok. | O | **Düzeltildi:** kod adıyla söylenir, kodsuz yanıt HTTP durumuyla ve ne yapılacağıyla (`lib/error-key.ts`). |
| 16 | Yönetici sunucu listesi boşken müşteri cümlesini ("Henüz sunucunuz yok") gösteriyor. | O | **Düzeltildi:** yöneticiye göre boş ve süzgeçli boş durum. |
| 17 | Servis çekmecesinde yeniden başlatma onayı iptal edilince odak sayfaya düşüyor; ardından Escape çekmeceyi kapatmıyor. | O | **Düzeltildi:** onay penceresi kapanınca odak onu açan düğmeye döner (`returnFocus`). |
| 18 | Sunucu listesinin hızlı menüsünden açılan Yeniden adlandır / Sil pencereleri kapanınca odak sayfaya düşüyor. | O | **Düzeltildi:** odak "…" düğmesine döner. |
| 19 | SSH anahtarı alanı sk- (güvenlik anahtarı), PuTTY, SSH2 biçimi ve özel anahtar için genel "geçersiz" diyor; bölünmüş anahtar bozuluyor. | O | **Düzeltildi:** tür ve boyut gösterilir, özel anahtar anında uyarılır, SSH2 biçimi ve bölünmüş anahtar tek satıra çevrilir. |
| 20 | Uzun yönetici formları (ayarlar sekmeleri, katalog, kullanıcı oluşturma, VMware bağlantısı) yenilemede taslak tutmuyor; seçim kutuları ve anahtarlar kaydedilmemiş değişiklik sayılmıyor. | O | **Bırakıldı:** bu formların çoğu sır taşır (parola, API anahtarı); güvenli bir alan listesi çıkarmak ayrı bir iş. Metin alanları zaten ayrılırken soruluyor. |
| 21 | Başarısız boyut değiştirme / yeniden kurulum / geri yükleme / yedek müşteriye yalnızca destek yolunu gösteriyor. | O | **Bırakıldı:** API yeniden denemeyi `operations.retry` yetkisine bağlıyor (kota, fatura ve kilit kuralları); personelde var. |
| 22 | Anlık görüntü, yedek, SSH anahtarı, API anahtarı, proje listelerinde arama/sıralama yok; fatura listesinde sıralama yok. | O | **Bırakıldı:** listeler kısa (sınırlı sayıda kayıt); ayrı iş. |
| 23 | Kullanıcı listesi hiç kullanıcı yokken "Eşleşen kullanıcı yok" diyor. | D | **Düzeltildi.** |
| 24 | Kupon kopyalama, konum ping düğmesi, etiket × düğmesi 28 px. | D | **Düzeltildi** (`.hit-44`). |
| 25 | Katalog boş durumları ("Henüz paket yok") yeni oluşturma düğmesini anmıyor (düğme hemen üstünde). | D | **Bırakıldı:** düğme aynı satırda görünür. |
| 26 | vCPU, "RAM (MB)", IP, MoRef, MAC gibi teknik etiketler çeviri dosyası dışında. | D | **Bırakıldı:** iki dilde de aynı teknik terimler. |
| 27 | Komut paletinde yönetici eylemleri ve ayar sekmeleri yok. | D | **Bırakıldı.** |
| 28 | Sabitleme yalnızca sunucularda (yıldız); talep ve kişi sabitlenemiyor. | D | **Bırakıldı:** son açılanlar palette ve karşılamada zaten var. |
| 29 | Ayarlar → Genel'in iki adımlı doğrulama sayısı yalnızca `admin` rolünü sayıyor. | D | **Kısmen:** başlangıç listesindeki yeni adım bütün personeli sayar; genel bakış kartı aynı kaldı. |
| 30 | VMware bağlantı ayrıntısında yükleme hatası düz metin, yeniden deneme yok. | D | **Bırakıldı.** |
| 31 | Sayı alanları birimli yazımı ("4 GB") almıyor. | D | **Bırakıldı:** alanlar birimi kendi gösteriyor; çevirme yanlış anlaşılmaya açık. |
| 32 | Güvenlik sayfasında tek bir oturumu kapatmak onaysız. | D | **Bırakıldı (bilerek):** oturum kapatmak bir güvenlik işlemi, beklemeden olmalı. |
| 33 | API anahtarı silme onay istiyor (geri alma değil). | D | **Bırakıldı (bilerek):** sızan anahtarın iptali beklememeli. |
| 34 | Başlangıç listesi "Getting started" adımlarının hepsi bitince tamamen kayboluyordu; sonradan bozulan bir şey (yedek, e-posta) görünmüyordu. | D | **Düzeltildi** (14 ile). |

## Kararlar

- **Geri alma ve denetim kaydı:** kaldırma isteği ileti kapanınca gönderilir; "Geri al" basılırsa hiç gönderilmez.
  Bu yüzden denetim kaydı **yalnızca gerçekleşen sonucu** yazar; geri alınan bir kaldırma API'ye hiç ulaşmaz.
  Yetki, kota, kilit ve denetim aynen eski isteğin kurallarıdır. Sekme kapanırken bekleyen kaldırmalar `keepalive` ile
  gönderilir. Geri alınamayanlar (sunucu silme, yedekten geri yükleme, anlık görüntüye dönme, yeniden kurulum) adı
  yazılarak onaylanır ve neyin kaybolacağını söyler.
- **Taslaklar:** yeni bir taslak deposu eklenmedi. Uzun metinler (talep, itiraz, olay, toplu ileti) zaten taslak
  tutuyor; oturum biterken panelin kişi verisini tarayıcıdan silmesi (paylaşılan bilgisayar) bilerek korundu. Süre
  dolarken yazılan metin ekranda kalıyor (mevcut "oturum doldu" penceresi). Sipariş taslağı artık güvenlik duvarı
  seçimini de tutuyor; parola, anahtar, kart hiçbir taslakta yok.
- **Hatırlanan seçimler** tarayıcıya yazılmıyor: sipariş formu sayfanın zaten okuduğu sunucu listesinden çıkarıyor.
- **Oturum:** kendiliğinden hiçbir şey uzatılmıyor. Uyarı `/auth/me`'nin zaten dakikada bir okunan yanıtından
  hesaplanıyor; yeni bir yoklama yok.

Ayrıntılar ve neyin neye dayandığı: [smart-features.md](smart-features.md#günlük-işi-kolaylaştıranlar).

## Round 2 — kararlılık, erişilebilirlik ve yeni yardımcılar (2026-11-23)

Aynı üç taraf (müşteri, bayi, yönetici) bu kez önce **kararlılık ve erişilebilirlik**, sonra yeni yardımcılar için
yeniden yüründü. Kural kaynağı yine `ui-ux-pro-max` (`--domain ux`: yükleme sırasında düğme kilidi ve çift gönderme,
4,5:1 kontrast, yalnız renge dayanmama, boş durum ve "sonuç yok", canlı bölge ve ileti süresi; `--stack nextjs`) ve
WCAG 2.2 AA; ölçüm aracı tarayıcı testlerindeki axe-core.

**Özet:** 15 aday incelendi; **9'u** tam yapıldı, **1'i** kısmen (14), **5'i** nedeniyle bırakıldı. Yol boyunca **14
kusur** bulundu ve düzeltildi (aşağıda K1–K14). Kurulum sihirbazı testinin ara sıra kalmasının nedeni bulundu ve
kanıtlandı (K1).

### Adaylar

| # | Aday | Durum |
|---|---|---|
| 1 | Kurulum sihirbazı testi ara sıra kalıyor ("Yerel adres" satırı yok, ardından 11 girişte kalış). | **Neden bulundu ve düzeltildi** (K1, aşağıda kanıtıyla). |
| 2 | Eski yanıtın yenisinin üstüne yazması (arama, süzgeç, sekme, yoklama ile değişiklik). | **Yapıldı:** tek desen `lib/latest.ts` (`useLatest`, `keepEdits`): sihirbaz denetimleri, kök parola gösterme, altı ayar formu. Arama ve süzgeçler zaten React Query anahtarlı (yarış yok); süzgeçli listeler yeni yanıt gelene kadar eskisini gösterir. |
| 3 | Çift gönderme (çift tıklama, Enter'in tekrarı). | **Yapıldı:** tek desen `lib/once.ts`: `useApiForm` (bütün formları), `useApiAction` (aynı değişkenlerle), anlık görüntü formu, boyut ve yeniden kurulum, ödeme sayfası. API tarafındaki eş istek koruması da düzeltildi (K1). |
| 4 | Uzun formlarda kaydedilmemiş değişiklik uyarısı (seçim kutuları, anahtarlar). | **Bırakıldı:** metin alanları zaten soruluyor; seçim ve anahtarları her formda tek tek bağlamak 30 kadar formu değiştirir ve dokunulmamış formda yanlış uyarı riski taşır. Ayrı iş. |
| 5 | Otomatik erişilebilirlik denetimi (axe-core), iki tema; Geri al iletisinin klavye ve ekran okuyucu davranışı. | **Yapıldı:** `e2e/ux2.spec.ts` 15 sayfayı (oturumsuz giriş ve durum sayfası, bir sunucu sayfası dahil) iki temada axe-core ile tarar, ciddi ya da kritik bulgu testi düşürür; bulunanlar düzeltildi (K9–K11). İleti: F6 ile ulaşılan bölge, `alertdialog` ve `alert` ile duyurulur, odaktayken süresi durur, odağı almaz. |
| 6 | Firefox ve WebKit. | **Yapıldı (duman seti):** bütün paket iki tarayıcıda daha CI'ı bir saati aşkın sürdürürdü; `@smoke` adlı testler (giriş, gösterge paneli 390 px, komut paleti, Geri al iletisi) Firefox ve WebKit'te de koşar (`playwright.config.ts` projeleri). |
| 7 | Uzun yönetici formlarında sır olmayan alanların taslağı. | **Bırakıldı:** her form için kanıtlanmış bir izinli alan listesi on kadar formun tek tek incelenmesini ister; ilk turdaki gerekçe sürüyor. |
| 8 | Büyük listelerde kayıtlı görünümler. | **Bırakıldı (zaten var):** sunucular, kullanıcılar, faturalar, ödemeler, destek kuyruğu ve denetim için kişi başına sunucuda saklanan görünümler ve adreste süzgeç durumu var. Müşterinin kısa fatura ve talep listeleri ile sütun seçimi düşük değerli. |
| 9 | Yazarken doğrulama (ad, CIDR, port, e-posta, alan adı) ve sunucu hatasının alanına yazılması. | **Bırakıldı (zaten var):** `TextInput format` nedenini ve örneğini söylüyor, API'nin `fields` kodları alana yazılıyor; örneklenen formlarda yeni bir boşluk bulunmadı. |
| 10 | Eksik kopyalama düğmeleri, "SSH komutu olarak kopyala". | **Yapıldı:** sunucu özetinde IP ve kimlik, fatura numarası, talep numarası; Windows sunucularda bağlantı kutusu SSH yerine Uzak Masaüstü ve `Administrator` gösterir (K12). SSH komutunu kopyalama zaten vardı. Başarısız kopyalamada "kopyalandı" diyen üç düğme düzeltildi (K5). |
| 11 | "Siz yokken" listesi. | **Yapıldı:** gösterge panelinde; kişinin kendi bildirimlerinden, "Görüldü" yalnız tıklamayla. |
| 12 | Sunucu sayfasında "sıradaki adım" önerileri. | **Yapıldı:** yedek yok ya da eski, güvenlik duvarı yok, panel kök parolayı saklıyor, eski anlık görüntüler; her biri ilgili bölüme götürür, bir hafta ya da kalıcı gizlenir. Disk doluluğu ve parolayla giriş platformlardan okunamadığı için yok. |
| 13 | Komut paletinde arama: IP, ad, fatura ve talep numarası, e-posta; yazım hatası; i/İ/ı. | **Yapıldı:** IP, ad, numara ve e-posta zaten bulunuyordu; artık bir harfi eksik, fazla, yanlış ya da yer değiştirmiş sözcükler de bulunur (`lib/fuzzy.ts`), tam eşleşmeler önce gelir. Rakam içeren sözcükler (adresler) tam yazılmalı. |
| 14 | Yükleme ve yerleşim kararlılığı. | **Kısmen:** süzgeç değişince liste "…" ile boşalmıyor (önceki yanıt kalır), yoklama bir satır ekleyince tablo ilk sayfaya atlamıyor (K8). Ortak bir iskelet bileşeni bırakıldı (görünüş, 20 yer). |
| 15 | Yeni müşteri için ilk adımlar. | **Bırakıldı (zaten var):** gösterge panelinde dört gerçek adımlı, kapatılabilen "İlk adımlar" kartı var. |

### Bulunan kusurlar

| # | Kusur | Düzeltme |
|---|---|---|
| K1 | API'nin "aynı istek zaten işleniyor" koruması, yanıtı gelmeden ayrılan bir tarayıcının (sayfa yenileme, kapanan sekme) isteğini **iki dakika** bırakmıyordu: aynı istek o süre `409 DUPLICATE_REQUEST` alıyordu. | İşaret iş bitince kaldırılır (`main.ts`, `onSend`); iş sürerken aynısı hâlâ reddedilir. |
| K2 | Sihirbazda bırakılmış bir adımın ya da geride kalmış bir denetimin yanıtı ekrana yazılabilirdi. | Yalnız en yeni denetim yazar; aynı denetim sunucuda sürerken sihirbaz bekleyip yeniden sorar. |
| K3 | Anlık görüntü formunda Enter tekrarı iki anlık görüntü alabilirdi (her basışta yeni `Idempotency-Key`). | `lib/once.ts`. |
| K4 | Ödeme sayfasında kart alanında Enter tekrarı ikinci ödeme isteğini gönderirdi (yalnız API'nin 409'u durduruyordu). | `lib/once.ts`. |
| K5 | Konsol kısayolları, kurulum rehberindeki kod ve API başvurusu, kopyalama başarısız olsa da "kopyalandı" diyordu. | `useCopy` üzerinden. |
| K6 | E-fatura "Dene" sonucu formu düğmeye basılmadan önceki hâline döndürüyordu. | Yalnız sonuç alanı yazılır. |
| K7 | Altı ayar formunda kaydetme sürerken yazılanı dönen yanıt siliyordu. | `keepEdits`: yazılan kalır, kaydedilmemiş görünür. |
| K8 | Tablo, yoklama bir satır ekleyince ya da çıkarınca ilk sayfaya atlıyordu. | Yalnız sayfadaki satırlar gidince (süzgeç) başa döner. |
| K9 | Açık temada ikincil metin rengi gri yüzeylerde 4,0–4,4:1 (sekmeler, arama kutusu, tablo başlıkları, açıklamalar); yeşil "başarılı" metni beyazda 2,2:1 (durum sayfası); kırmızı üstünde beyaz 3,5:1 (rozetler, tehlike düğmeleri, olay şeridi), kırmızı zemin üstünde kırmızı yazı 4,25:1 (menüdeki başarısız işlem sayısı); vurgu rengi gri üstünde 4,49:1; yumuşak "hazır", "ödendi", "gecikmiş" çiplerinin yazısı; koyu temada API başvurusundaki DELETE etiketi 3,7:1. | Açık temada `--muted` bir ton koyu (gri üstünde 4,9–5,5:1), `--success-text`, `--danger` (beyazla 5,2:1; koyu temada kırmızı yazı için ayrı açık ton), vurgu bir ton koyu, çip yazıları koyu; etiket açık kırmızı. |
| K10 | Dil düğmesi ("en"), hesap menüsü (ad), arama düğmesi ("Ctrl K"), bildirim zili ("9+"), zamanlamanın gün düğmeleri ("Pzt" görünüp "Pazartesi" denmesi) ve Sistem'deki servis satırları (sürüm, CPU ve bellek yazılı ama adda yok) ekran okuyucuya görünen metni içermeyen bir ad söylüyordu (WCAG 2.5.3). | Ad görünen metni içerir; kısayol `aria-keyshortcuts` ile; zil ve gün düğmeleri adlarını gizli sözcüklerden alır; servis satırında yalnız göz için olan kısımlar okunmaz, ad eskisi gibi servis ve durumu söyler. |
| K11 | Kullanıcılar sayfasında liste öğeleri `role="button"` ile liste öğesi olmaktan çıkıyordu. | Düğme öğenin içinde. |
| K12 | Windows sunucunun bağlantı kutusu `ssh root@…` ve `scp` gösteriyordu. | Uzak Masaüstü (`mstsc /v:…`) ve `Administrator`. |
| K13 | Dokunma ve tıklama hedefleri (WCAG 2.5.8): "Çevrimiçi olanlar"ın "Tümünü gör" bağlantısı 20 px yüksekliğindeydi; içgörü kartının bağlantısı kendi gizle ve düzelt düğmelerinin altında kalıyor, işaretçinin güvenebileceği 10–16 px'lik bir şerit kalıyordu. | Bağlantı 24 px; kart artık liste öğesi, bağlantı ve düğmeler yan yana, biri ötekinin üstünde değil. |
| K14 | Alanın önerilen adı, alan odaktayken gelirse (dayandığı liste hâlâ yükleniyorken) yazılanın önüne geçiyordu ("Project 1kept after expiry", CI'da görüldü). | Geç gelen öneri de seçilir; yazılan onun yerine geçer. |

### Kurulum sihirbazı testinin ara sıra kalması: neden ve kanıt

- **Belirti** (CI `45104033887`, ilk deneme): erişim adımında `127.0.0.1:8080` denetlenince "Yerel adres;
  doğrulanamaz" satırı 5 sn içinde görünmedi; yönetici oluşmadığı için sonraki 11 test girişte kaldı.
- **Neden:** test adıma girer girmez sayfayı yeniler. Adım açılınca kendiliğinden çalışan denetim (gövdesi
  `{"publicUrl":"http://127.0.0.1:8080"}`) o anda yoldaysa tarayıcı onu bırakır. API'nin eş istek koruması isteği
  Redis'te işaretler ve işareti yalnız Fastify'ın `onResponse` kancasında kaldırıyordu; yanıtı alacak kimse kalmayan
  istekte bu kanca hiç çalışmaz, işaret 120 sn kalır. Testin sonra yazdığı adres sayfanın kendi adresiyle aynı
  olduğu için gövde de aynıdır: hem yenilemeden sonraki otomatik denetim hem testin "Kontrol et"i
  `409 DUPLICATE_REQUEST` aldı, satır hiç gelmedi. Yeniden çalıştırmada geçmesi, yenilemenin denetimden önce mi
  sonra mı düştüğüne bağlı bir zamanlama.
- **Kanıt:** (1) Fastify 5.12.7 ile küçük bir deney: istemcinin yanıttan önce kopardığı istekte `onResponse` hiç
  çalışmıyor, `onSend` (iş bitince, `destroyed=true`) çalışıyor. (2) Entegrasyon testi
  `apps/api/test/integration/stability.test.mjs`: yanıttan önce kopan istekten sonra, iş bittiğinde aynı istek
  düzeltmeden önce **409**, sonra **200**; iş sürerken aynısı yine 409. (3) Tarayıcıda zorlanmış gecikme (yerel
  yığın): sihirbazda yanıt vermeyen bir adres (`192.0.2.1`, 5 sn bekleyen denetim) denetlenirken sayfa yenilendi, 7
  sn sonra aynı denetim: düzeltmeden önce ekranda "Aynı istek zaten işleniyor" ve sonuç yok, düzeltmeden sonra sonuç
  satırı. Sihirbaz testi bu durumu artık her koşuda bilerek kurar.
