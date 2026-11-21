# Akıllı yardımcılar

Bu sayfadaki her şey **kural tabanlı ve istatistikseldir**; panelin kendi veritabanındaki verilerden, panelin içinde
hesaplanır. Dışarıdaki bir yapay zekâ ya da başka bir servis kullanılmaz, kurulumdan hiçbir veri çıkmaz. Her öneri
neden gösterildiğini (arkasındaki sayıları) söyler ve gizlenebilir. Bir müşterinin sunucusunda değişiklik yapan her
öneri, yetkisi olan birinin açık tıklamasıyla çalışır; panel kendiliğinden hiçbir şey yapmaz.

İlk küme (doğru boyutlandırma, sağlık puanı, bu ayın maliyeti, içgörüler) için bkz.
[operations-modules.md](operations-modules.md#akıllı-özellikler). Bu sayfa sonradan eklenenleri anlatır.

## Olağan dışı kullanım

Bir sunucunun işlemci ya da ağ kullanımı **kendi yakın geçmişinden** keskin biçimde ayrıldığında bir bulgu açılır.
Başka sunucularla karşılaştırma yapılmaz.

- **Nerede hesaplanır:** worker, saatte bir (`apps/worker/anomalies.mjs`; kurallar `apps/worker/anomaly-rules.mjs`,
  birim testleri `apps/worker/test/anomaly-rules.test.mjs`). Aralık `ANOMALY_MINUTES` ile değişir (varsayılan 60).
  Yedekten geri yükleme beklemesi sürerken çalışmaz.
- **İşlemci:** son 3 tam saatin saatlik ortalamalarının medyanı, önceki 14 günün **günün aynı saatleriyle** (±1 saat)
  karşılaştırılır. Saatler UTC'dir; yaz saati geçişi yerel düzeni bir saat kaydırır, ±1 saatlik bant bunu karşılar.
  - Yayılım, medyan mutlak sapmadan (MAD × 1,4826) hesaplanır ve 5 puandan küçük alınmaz: düz çalışan bir sunucuda
    küçük bir oynama bulgu olmaz.
  - **Açılır:** sağlam z-puanı ≥ 4 **ve** olağandan en az 20 puan yüksek. **Kapanır:** z < 2 ya da fark < 10 puan.
    İki eşik arasındaki değer açık bulguyu açık tutar, yeni bulgu açmaz (titreme olmaz).
  - **Olağandan düşük:** yalnızca olağanı en az %15 olan sunucuda; son saatler olağanın %20'sine ya da altına
    indiğinde açılır, %50'sine çıkınca kapanır (çalışan bir hizmet durmuş olabilir).
  - 3 saatin en az 2'sinde ölçüm olmalıdır; tek saatlik sıçrama bulgu değildir.
  - **En az geçmiş:** önceki 4 ayrı günden toplam 12 saat. Daha azında sonuç "yeterli veri yok"tur.
- **Ağ:** panel trafiği gün gün tutar. Bugünün şimdiye kadarki toplamı ile dünün toplamından büyüğü, ondan önceki 14
  günün medyanıyla karşılaştırılır. En az 7 gün gerekir. **Açılır:** en az 5 GiB, olağan günün en az 3 katı ve z ≥ 4
  (yayılım en az 1 GiB ve olağanın %25'i). **Kapanır:** z < 2.
- **Kalıcı değişiklik:** kullanım günlerce yeni düzeyinde kalırsa taban onu öğrenir ve bulgu kendiliğinden kapanır
  (yaklaşık bir hafta).
- **Ölçüm vermeyen platformlar:** XCP-ng, oVirt, libvirt ve Incus işlemci ölçümü bildirmez; bu sunucular için hiçbir
  sonuca varılmaz ve sunucu sayfası bunu açıkça söyler. Trafik satırı hiç olmayan sunucunun ağı da yargılanmaz.
- **Müşteri:** sunucu sayfasında "Kullanım takibi" bölümü (bulgunun sayıları, ne zamandan beri, 7 gün gizle) ve genel
  bakıştaki içgörüler (`USAGE_ANOMALY_CPU_HIGH`, `USAGE_ANOMALY_CPU_LOW`, `USAGE_ANOMALY_NETWORK_HIGH`). Bulgu
  açıldığında bir kez `server.usage_anomaly` bildirimi gider (varsayılan: yalnız panel; kullanıcı e-posta ve diğer
  kanalları Hesap → Bildirimler'den açabilir). Gizleme içgörülerin kendi gizlemesidir; yeni bir bulgu yeni
  anahtardır, eski gizleme onu saklamaz.
- **Personel:** Yönetim → Kötüye kullanım → "Olağan dışı kullanım" sekmesi (`GET /admin/anomalies`,
  `servers.view_all`) ve özet içgörüsü `USAGE_ANOMALIES`. Sayılar kötüye kullanım izlemenin aradığına benziyorsa not
  düşülür: işlemci %90 ve üstünde ("madenciliğe benziyor") ya da trafiğin en az %90'ı giden ("saldırı trafiğine
  benziyor"); aynı sunucudaki açık kötüye kullanım bulguları da sayılır. Bu liste istatistiktir: kötüye kullanım
  bulgusu **oluşturmaz**, o modülün kendi denetimleri ve onay akışı aynen sürer.
- **Arka plan maliyeti:** her çalışmada (1) son toplanan saatten bu yana gelen ham örnekler okunup saatlik satırlara
  yazılır (`server_cpu_hourly`, 63 gün tutulur; ham örnekler 14 gün), (2) 200'er sunuculuk gruplar hâlinde her
  sunucunun en çok 15 × 24 saatlik satırı ve 16 günlük trafik satırı okunur. Kapanan bulgular 90 gün sonra silinir.

## Ay sonu maliyet tahmini ve bütçe

Genel bakıştaki "Bu ay" kartı (`GET /usage/summary`) para birimi başına şimdiye kadarki tutarı, ay sonu tahminini ve
aylık toplamı gösterir. Fiyatlar faturalamanın tuttuğu yerden okunur; burada yeniden fiyat hesaplanmaz.

- **Aylık faturalanan** sunucular ve sanal veri merkezleri: aylık fiyat, bu ay (UTC) var oldukları süreye oranlanır
  (`smart-rules.ts`, `monthCost`; eskisi gibi).
- **Saatlik faturalanan** sunucular: faturalamanın bu ay için kaydettiği kullanım (`server_usage`; ay içinde silinen
  sunucuların saatleri de buradadır) **artı** hâlâ kullanım biriktiren sunucuların saatlik fiyatı × ayın kalan tam
  saatleri. Başlamış saat zaten kayıtlıdır (faturalama saati başlarken yazar). Bakiye bittiği için bekletilen ve
  kapalı duran sunucu kullanım biriktirmez; fiyatı ileriye taşınmaz. Kural: `apps/api/src/forecast-rules.ts`
  (`monthForecast`), birim testleri `apps/api/test/forecast-rules.test.mjs`.
- **Bütçe iki şeye göre ölçülür:** aylık gidiş (sunucuların aylık fiyat toplamı; eskisi gibi, `billing.budget_exceeded`)
  ve **bu ayın tahmini**. İkincisi birincinin göremediğini görür: saatlik kullanım ya da ay içinde silinmiş ama para
  harcamış sunucular.
  - Eşikler: bütçenin %80'i ve üstü "yaklaşıyor", %100'ün üstü "aşıyor" (`BUDGET_NEAR = 0.8`, `budget.ts`).
  - Kartta ikinci bir satır ve içgörü (`BUDGET_FORECAST_NEAR`, `BUDGET_FORECAST_OVER`; sayılarıyla, gizlenebilir;
    her ay yeni anahtar).
  - Tahmin bütçeyi aşınca `billing.budget_forecast` bildirimi **ayda bir kez** gider (varsayılan: panel ve e-posta).
    Aynı ay "bütçeniz aşıldı" bildirimi gittiyse üstüne gönderilmez. Bütçe değiştirilince yeniden gönderilebilir.
- **Arka plan maliyeti:** API'de 6 saatte bir (`cost-forecast.ts`, `BUDGET_FORECAST_HOURS`), yalnızca bütçesi olan ve
  bu ay henüz uyarılmamış hesaplar için, bir çalışmada en çok 500 hesap; hesap başına üç küçük sorgu. Yedekten geri
  yükleme beklemesinde çalışmaz. Bütçe kaydedildiğinde de hemen bakılır.
- Bütçesi olmayan hesap için hiçbir karşılaştırma yapılmaz. Saatlik sunucusu olmayan hesabın rakamları öncekiyle aynıdır.

## Güç zamanlaması önerisi

Bir sunucunun işlemci geçmişi, haftanın belirli saatlerinde **haftalardır her hafta** boşta kaldığını gösteriyorsa,
panel bu saatlerde kapalı tutacak zamanlamayı önerir. Öneri yalnızca öneridir: zamanlama, sunucuyu açıp kapatma
yetkisi olan birinin düğmeye basmasıyla ve sıradan zamanlamaların kendi koduyla (`schedules.ts`, `addSchedule`)
oluşturulur.

- **Kural** (`apps/api/src/schedule-rules.ts`, birim testleri `apps/api/test/schedule-rules.test.mjs`): son 4 haftanın
  saatlik işlemci satırları (`server_cpu_hourly`) haftanın 168 saatine, isteyenin saat diliminde dağıtılır.
  - Bir saat **boş** sayılır: en az 3 haftada görülmüş ve her birinde saatlik ortalama %3'ün, en yüksek örnek
    %10'un altında. Ölçümü olmayan saat (sunucu kapalıydı) **kullanımda** sayılır.
  - **Gece penceresi:** hiçbir gün kullanılmayan en uzun saat aralığı (gece yarısını aşabilir). Sunucu, kullanıldığı
    görülen saatlerden 1 saat önce açılır, 1 saat sonra kapatılır; kalan pencere en az 6 saat olmalıdır. Açma
    zamanlaması yalnızca sunucunun o gün kullanıldığı günlere konur: hafta sonu kullanılmayan sunucu cuma akşamı
    kapanır, pazartesi sabahı açılır.
  - **Haftalık pencere:** gece penceresi yoksa haftadaki en uzun boş aralık (ör. hafta sonu), en az 24 saat.
  - Haftada 20 saatten az kapalı kalacaksa bir şey önerilmez. Her an boşta olan sunucu için de önerilmez (o durum
    `IDLE_SERVER` önerisinin konusudur).
  - **En az geçmiş:** 21 gün. Daha azında "yeterli veri yok" denir ve kaç gün olduğu yazılır. İşlemci ölçümü
    vermeyen platformlarda (XCP-ng, oVirt, libvirt, Incus) hiçbir şey önerilmez; sayfa bunu söyler.
  - Yaz saati geçişi: saatler yerel saate göre dağıtıldığı için öneri saat değişiminden etkilenmez.
- **Zaten zamanlaması olan sunucu:** etkin bir açma ya da kapatma zamanlaması varsa öneri yapılmaz.
- **Ne kazandırır:** faturalama kapalı sunucudan daha az ücret **almaz** (abonelik dönemliktir; saatlik kullanım
  sunucu var olduğu her saat için yazılır), bu yüzden para vaat edilmez ve sayfa bunu açıkça söyler
  (`OFF_SERVER_COSTS_LESS = false`, `schedule-suggest.ts`). Enerji ölçülen platformlarda sunucunun son 7 gündeki
  ortalama güç payı × haftalık kapalı saat, kWh olarak gösterilir; ölçülmeyenlerde yalnızca kapalı saat söylenir.
- **Tek tıkla oluşturma** (`POST /servers/:id/schedule-suggestion`): öneri sunucu tarafında, o anki geçmişten
  yeniden hesaplanır; istekte saat diliminden başka hiçbir şey dikkate alınmaz. Elle eklemedeki denetimler aynen
  geçerlidir: `server.power` yetkisi, yöneticinin "müşteri güç işlemleri" anahtarı, sunucu başına 10 zamanlama
  sınırı, sahiplik kilidi ve `server.schedule_created` denetim kaydı (`suggested: true`).
- **Gizleme:** "Şimdi değil" içgörülerin kendi gizlemesidir (7 gün); içgörü `SCHEDULE_SUGGESTED`.
- **Maliyet:** arka plan işi yoktur. Sunucu sayfası açıldığında tek sunucunun en çok 672 saatlik satırı okunur;
  içgörüler için hesap sahibinin en çok 20 çalışan sunucusuna bakılır ve sonuç sunucu başına 6 saat saklanır.

## Bakım için en sakin saatler

Sunucuları rahatsız eden işler (panelin kendini güncellemesi, bir host'un bakıma alınması) için panel, sunucuların
**en az meşgul olduğu saatleri** kullanım geçmişinden çıkarır ve personelin bu işleri planladığı iki yerde gösterir.
Yalnızca öneridir: hiçbir şeyi kendiliğinden taşımaz, zamanlamaz ya da değiştirmez.

- **Veri:** kullanım takibinin tuttuğu saatlik işlemci satırları (`server_cpu_hourly`). Yük birimi **meşgul vCPU**'dur:
  her sunucunun saatlik işlemci ortalaması × vCPU sayısı, o saatte ölçülen sunucular üzerinden toplanır. Silinmiş
  sunucular ve işlemci ölçümü vermeyen platformlar (XCP-ng, oVirt, libvirt, Incus) sayılmaz.
- **Kural** (`apps/api/src/quiet-hour-rules.ts`, birim testleri `apps/api/test/quiet-hour-rules.test.mjs`): son 4
  haftanın saatleri haftanın 168 saatine dağıtılır.
  - Haftanın bir saati ancak **en az 3 haftada** görülmüşse karşılaştırılır; yükü bu haftaların ortalamasıdır.
  - Aranan dilim **2 saattir** ve içindeki her saatin karşılaştırılabilir olması gerekir.
  - **Günlük dilim:** haftanın yedi gününde de aynı saatte başlayan dilimlerin ortalaması en düşük olanı. En yoğun
    olduğu günün yükü de ayrıca söylenir (`worst`).
  - **Haftalık dilim:** haftanın tamamındaki en sakin 2 saat (ör. pazar 04:00–06:00).
  - Eşitlikte haftanın / günün daha erken dilimi seçilir; yanıt bir çalıştırmadan ötekine oynamaz.
  - **En az geçmiş:** 21 gün. Daha azında, ya da hiçbir dilim yeterince görülmemişse "yeterli veri yok" denir ve kaç
    gün olduğu yazılır. İşlemci ölçümü veren hiçbir bağlantı yoksa "ölçülmüyor" denir.
  - Dilim yerel saate göre hesaplanır; gece yarısını ve hafta sonunu aşabilir.
- **Gösterilen sayılar:** dilimin ortalama yükü, haftanın genel ortalaması (`usual`), en yoğun saatin yükü
  (`peak`), kaç haftalık ve kaç günlük geçmişe dayandığı, saat başına ölçülen sunucu sayısı.
- **Otomatik güncelleme penceresi** (Yönetim → Sistem → Otomatik güncellemeler; `GET /admin/maintenance/quiet-hours`,
  `system.view` ya da `dashboard.view`): kurulumun bütün sunucuları, **panel sunucusunun kendi saat diliminde**
  (pencereyi `scripts/install.sh` orada okur). "Güncelleme penceresi olarak kullan" düğmesi günlük dilimi var olan
  istekle kaydeder: `POST /admin/maintenance/requests` (`action: auto-update`), yani aynı yetki (`system.update`),
  aynı anda tek bakım işi ve `maintenance.request` denetim kaydı; kayıtta `suggested: true` yazar. Açık / kapalı ve
  kanal ayarı kayıtlı olduğu gibi gönderilir. Pencere zaten bu saatlerdeyse düğme yerine bunu söyler. Sunucu ajanı
  saat dilimini kaydetmemişse saatler UTC olarak gösterilir ve pencere olarak **önerilmez**.
- **Host bakımı** (Yönetim → VMware → bağlantı → Host'lar; `GET /admin/vmware/connections/:id/quiet-hours`,
  `vmware.view`, `vmware.manage` ya da `catalog.manage`): bağlantının tamamı ve panel sunucusu çalıştıran her host
  için, görüntüleyenin saat diliminde. Bir sunucu **şu anda çalıştığı** host'a yazılır (son envanter); taşınmış bir
  sunucunun taşınmadan önceki saatleri de şimdiki host'una sayılır. Host'u boşaltma düğmesi eskisi gibidir ve
  hemen çalışır; panel taşımayı bu saate zamanlamaz.
- **Maliyet:** arka plan işi ve ek tablo yoktur. Yanıt başına saatlik satırlar üzerinde gruplanmış tek sorgu (en çok
  4 haftalık satır), sonuç 30 dakika Redis'te saklanır (`quiet:*`).

## Dönemsel özet

Olay başına bildirim yerine, kişinin seçtiği gün ve saatte durumu **tek mesajda** söyler. **Açılmadıkça kapalıdır.**
İçeriği panelin zaten hesapladığı şeylerden toplanır (içgörüler, ödeme riski, ay sonu tahmini); yeni bir kural ya da
dış servis yoktur. Kod: `apps/api/src/periodic-digest.ts`; saf kurallar `apps/api/src/digest-rules.ts` (birim
testleri `apps/api/test/digest-rules.test.mjs`, entegrasyon testi `test/integration/smart-digest.test.mjs`).

- **Kim alır:**
  - **Personel** (`dashboard.view`): Hesabım → Bildirimler → "Dönemsel özet" bölümünden kendi özetini açar. Olay
    `admin.digest`. İçerik: önem derecesine göre açık bulgular, son özetten beri **açılan ve kapanan** bulgular,
    ödeme riski altındaki hesaplar (sayı ve en büyük üç tutar; yalnızca `billing.view` varsa), son özetten beri
    başarısız işlemler, kapasite bulguları (havuz doluluğu ve dolma tahmini). Her satır, kişinin panelde zaten
    görebildiği şeydir: bulgular içgörü listesiyle aynı yetki süzgecinden geçer (`maySeeFinding`).
  - **Müşteri:** yalnızca yönetici Ayarlar → Bildirim kuralları'nda `account.digest` olayını açtıysa (**varsayılan:
    kapalı**) ve müşteri kendi özetini açtıysa. İçerik: kendi sunucularının bulguları (içgörüler), bu ayın şimdiye
    kadarki tutarı ve ay sonu tahmini (bütçe varsa durumuyla), 14 gün içindeki yenileme (tarih ve tutar). Başka
    müşterinin hiçbir verisi okunmaz: bütün sorgular hesabın kendisini adlandırır.
- **Zaman:** haftalık (varsayılan: pazartesi 08:00) ya da günlük; gün ve saat **kişinin kendi saat dilimindedir**.
  Sonraki özet, kişinin saati seçilen saati bir sonraki geçtiğinde gönderilir (`nextSlot`): yaz saatine geçişte
  atlanan saat boşluktan sonraki ilk an sayılır, geri alınan saatte özet bir kez gider; yarım saatlik dilimler
  (ör. Asia/Kolkata) desteklenir.
- **Teslimat:** sıradan bir bildirimdir. Kanalları kişi olay satırından seçer (panel, e-posta, mesajlaşma;
  varsayılan e-posta), yöneticinin olay kuralı geçerlidir, **sessiz saatlerde** mesajlaşma uygulamalarına gitmez
  (e-posta ve gelen kutusu alır). Bölüm, seçili kanallardan hangilerinin şu anda gerçekten ulaşacağını söyler
  (posta ayarlı mı, uygulama bağlı mı); hiçbiri ulaşmıyorsa uyarır.
- **Boş özet gönderilmez:** "bilgi" düzeyinin üstünde açık bulgu yoksa, son özetten beri açılan ya da kapanan yoksa
  ve rakamlar boşsa (risk altındaki hesap, başarısız işlem, kapasite bulgusu; müşteride tutar ve yenileme) o dönem
  mesaj gitmez. "İki adımlı doğrulama kapalı" gibi kalıcı notlar tek başına haftalık mesaj olmaz; ilk özet onları
  bir kez listeler. Dönem yine de işlenmiş sayılır.
- **Açılan / kapanan:** her çalıştırma, kişinin görebildiği bulguların anahtarlarını saklar (en çok 200); sonraki
  özet bunlarla karşılaştırır. Kişinin **gizlediği** bulgu listede görünmez ama "kapandı" da sayılmaz.
- **Tam bir kez:** API'de beş dakikada bir, faturalama ve zamanlama sayaçlarındaki gibi bir Redis kilidi altında
  çalışır (`lock:digest`). Asıl güvence veritabanındadır: her kişinin satırı, `next_at` değerini ileri alan tek
  bir koşullu `UPDATE` ile sahiplenilir; kilidi aşan ikinci bir kopya vadesi gelmiş satır bulamaz (entegrasyon
  testi aynı anda dört çalıştırmayla bunu sınar). Çalıştırma başına en çok 200 kişi; kalanı beş dakika sonra.
  Yedekten geri yükleme beklemesinde çalışmaz. Özet hazırlanırken hata olursa o dönem atlanır ve
  `digest_failed` olarak kaydedilir (iki kez göndermektense hiç göndermemek).
- **Önizleme** (`POST /account/digest/preview`): özetin o anki halini aynı kanallardan, başlığında "Önizleme" ile
  hemen gönderir ve metnini ekranda gösterir; dönem sayılmaz. Saatte 5.
- **Maliyet:** vadesi gelenler için kısmi dizinli tek sorgu (`digest_preferences_due`); özet başına içgörü
  listesinin sorguları. Personel listesi bir çalıştırmada bir kez hesaplanır, kişi başına değil.

## Ödeme riski

Kurallar `apps/api/src/payment-risk-rules.ts` içindedir (birim testleri `apps/api/test/payment-risk-rules.test.mjs`);
hiçbiri tahsilat yapmaz, hizmet askıya almaz ya da kimseye yazmaz. Hatırlatma, askıya alma ve silme adımları
faturalamanın kendi akışında kalır ([billing.md](billing.md)).

- **Müşteri** (içgörüler; yalnızca Faturalama ayarlarında otomatik tahsilat açıkken; faturalarını elle ödeyen hesaba
  bir şey söylenmez). Sıradaki yenileme, faturalamanın keseceği tutarla (`nextRenewal`) ve en çok 30 gün ilerisi
  için ele alınır; yenilemenin faturası zaten kesildiyse o faturanın kendi hatırlatmaları geçerlidir.
  - `CARD_EXPIRES_BEFORE_RENEWAL`: kayıtlı kartların **hepsinin** süresi yenileme tarihinden önce doluyor ve bakiye
    tutarı karşılamıyor. Kart, son kullanma ayının son gününe kadar geçerli sayılır; son kullanma tarihi bilinmeyen
    kart hakkında sonuç çıkarılmaz. Varsayılan kart adıyla (son dört hane, AA/YY), tarih ve tutar söylenir.
  - `RENEWAL_NOT_COVERED`: süresi yeten kart yok, hesapta bakiye var ama yenilemeden az. Bakiye, eksik tutar,
    tarih ve tutar söylenir. Faturalama ayarlarında bakiye kapalıysa bakiye hesaba katılmaz.
  - İkisi de gizlenebilir; anahtar yenileme tarihini içerir, sonraki dönemde yeniden görünür.
- **Personel** (`GET /admin/billing/risk`, `billing.view`; Yönetim → Faturalandırma → "Risk altında" sekmesi ve
  `PAYMENT_RISK` içgörüsü). Hesap ve para birimi başına bir satır:
  - Listeye giren: vadesi geçmiş ödenmemiş faturası olan (itirazlı faturalar ve bakiye yüklemeleri sayılmaz) ya da
    son 30 günde en az 2 başarısız tahsilatı olan hesap.
  - **Risk altındaki tutar:** vadesi geçmiş toplam; vadesi geçmiş yoksa başarısız tahsilatların ait olduğu açık tutar.
  - **Büyüyor:** vadesi geçmiş tutarın bir bölümü son 7 günde eklenmiş, bir bölümü daha eski.
  - Sıra: risk altındaki tutar büyükten küçüğe (farklı para birimleri sayı olarak karşılaştırılır; liste bir toplam
    değil, bakılacaklar sırasıdır), sonra en eski gecikme. En çok 200 satır.
- **Maliyet:** arka plan işi yoktur. Müşteri içgörüsü için hesabın yenilemesi, kartları ve bakiyesi okunur; personel
  listesi, faturalar ve ödemeler üzerinde gruplanmış tek sorgudur (personel içgörüleri 60 saniye önbellekte tutulur).

## Destek yardımı

Eşleştirme panelin içinde, sözcük ortaklığıyla yapılır (`apps/api/src/similarity-rules.ts`, birim testleri
`apps/api/test/similarity-rules.test.mjs`); metin hiçbir dış servise gitmez ve saklanmaz.

- **Kural:** metin, aramadaki sadeleştirmeyle sözcüklere ayrılır (`db.ts` içindeki `foldText` ile aynı: büyük-küçük
  harf yok, Türkçe harfler düz; "Şifre" = "sifre", "IŞIK" = "isik"). 3 harften kısa sözcükler ve sık geçen Türkçe ve
  İngilizce sözcükler ("merhaba", "lütfen", "the", "please"…) atılır. Benzerlik, TF-IDF ağırlıklı kosinüstür: birçok
  metinde geçen sözcük az sayılır. Eşik: en az **2 ortak sözcük** ve **0,12** benzerlik; en çok **3** sonuç. Her
  sonuç ortak sözcüklerini taşır; ekranda "gösterilme nedeni" olarak yazılır. Talebin metni: konu (iki kez
  sayılır) ve müşterinin ilk mesajı.
- **Personel** (`GET /admin/support/tickets/:id/similar`, `support.view`; talep sayfasında "Benzer çözülmüş
  talepler"): son 365 günde kapanmış ve personelin yanıtladığı en yeni 300 talep karşılaştırılır. Her sonuçta
  talebi kapatan **son herkese açık personel yanıtı** gösterilir (iç notlar asla) ve kopyalanabilir. Kendiliğinden
  hiçbir şey gönderilmez; müşteriye ne yazılacağı personelin kararıdır.
- **Müşteri** (`POST /support/suggestions`; yeni talep penceresinde mesajın altında, yazma durduktan kısa süre
  sonra): yalnızca müşterinin zaten görebildiği kaynaklar okunur:
  - kendi taleplerinden personelin yanıtladıkları (en yeni 50) ve o yanıtlar;
  - durum sayfası açıksa oradaki olaylar: süren olayların hepsi, son 7 günde çözülenlerden konuya benzeyenler.
    Durum sayfası kapalıysa hiçbir olay gösterilmez.

  Başka müşterilerin talepleri müşteri için **hiçbir koşulda** okunmaz: sorgu, talebin sahibi olarak çağıranı
  adlandırır ve başka kaynak yoktur (entegrasyon testi, neredeyse aynı metni yazan iki müşteriyle bunu sınar).
  Çok kısa metinde ya da 10 dakikada 60 istekten sonra hata yerine boş yanıt döner; form çalışmaya devam eder.
- **Maliyet:** arka plan işi ve ek tablo yoktur. Personel isteği başına en çok 300 talebin konusu ve ilk mesajının
  ilk 2000 karakteri okunur; müşteri isteği başına en çok 50 talep ve 20 olay.
