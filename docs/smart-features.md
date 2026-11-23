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
  - **En az geçmiş:** önceki 4 ayrı günden toplam 12 saat. Daha azında sonuç "yeterli veri yok"tur. Günler pencereden
    geriye doğru sayılır (takvim gününe göre değil): gece yarısı (UTC) çevresindeki pencerede bir gece iki gün sayılmaz.
  - **Haftalık düzen bulgu değildir:** ayrılma, **bir ve iki hafta önceki aynı günün aynı saatlerine** göre de
    geçerli olmalıdır (o saatlerden en az 2'si varsa). Hafta içi çalışıp hafta sonu boşta duran sunucu hafta sonu
    "olağandan düşük", her pazar gecesi çalışan iş "olağandan yüksek" sayılmaz. Bir haftadan kısa geçmişte bu düzen
    bilinemez; kural yalnızca günlük karşılaştırmadır. Bu bakış yalnızca bulgu **eler**: haftada bir çalışan bir işin
    çalışmaması fark edilmez.
  - **Ölçüm boşluğu:** son saatlerde ölçüm yoksa (platform yanıt vermedi, worker durdu, sunucu kapalı) açık bulgu
    hemen kapanmaz; sayılarının en son doğrulandığı andan sonra 6 saat tutulur (`UNJUDGED_KEEP_HOURS`), ölçüm
    dönerse aynı bulgu sürer ve sahibine ikinci kez yazılmaz.
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
  sunucunun en çok 15 × 24 saatlik satırı ve 16 günlük trafik satırı okunur; grubun satırları sunucularına bir kez
  dağıtılır. Kapanan bulgular 90 gün sonra silinir. "Son saatten beri gelen örnekler" örneklerin zamanı üzerindeki
  blok aralığı dizininden (BRIN) bulunur; dizin, aralıkları doldukça özetler (`autosummarize`, migration 091).
  200 sunucu ve 14 günlük örnekle (yaklaşık 800 000 satır) ölçülen süreler: [validation.md](validation.md).

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
  bu ay henüz uyarılmamış hesaplar için, 500'er hesaplık sayfalar hâlinde **hepsi** (kimlik sırasıyla; bütçesinin
  altındaki hesap işaretlenmediği için "ilk 500" her çalışmada aynı 500'dü); hesap başına üç küçük sorgu. Yedekten geri
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
  - **Saat dilimi adları:** zamanlayıcı saati SQL içinde zamanlamanın diliminde okur. Çalışma zamanının tanıyıp
    PostgreSQL'in tanımadığı adlar vardır (`AET` gibi kısa adlar; eski adları taşımayan veritabanında
    `Asia/Calcutta`, `Europe/Kiev` gibi yeniden adlandırılmış dilimler). Böyle bir ad artık saklanmaz: dilimin
    veritabanının tanıdığı öteki adı yazılır, o da yoksa istek reddedilir (`timezone: INVALID_VALUE`). Zamanlayıcı
    saati yalnızca tanınan dilimler için okur; eskiden kalmış bir satır yeniden adlandırılır ya da atlanıp bir kez
    `schedule_timezone_unknown` olarak kaydedilir. (Önceden böyle tek bir satır bütün zamanlamaları durduruyordu.)
- **Zaten zamanlaması olan sunucu:** etkin bir açma ya da kapatma zamanlaması varsa öneri yapılmaz.
- **Ne kazandırır:** faturalama kapalı sunucudan daha az ücret **almaz** (abonelik dönemliktir; saatlik kullanım
  sunucu var olduğu her saat için yazılır), bu yüzden para vaat edilmez ve sayfa bunu açıkça söyler
  (`OFF_SERVER_COSTS_LESS = false`, `schedule-suggest.ts`). Enerji ölçülen platformlarda sunucunun son 7 gündeki
  ortalama güç payı × haftalık kapalı saat, kWh olarak gösterilir; ölçülmeyenlerde yalnızca kapalı saat söylenir.
- **Tek tıkla oluşturma** (`POST /servers/:id/schedule-suggestion`): öneri sunucu tarafında, o anki geçmişten
  yeniden hesaplanır; istekte saat diliminden başka hiçbir şey dikkate alınmaz. İki zamanlama **tek işlemde**, sunucu
  kilidi altında yazılır ve "henüz güç zamanlaması yok" koşulu o işlemin içinde yeniden bakılır: düğmeye iki kez
  basmak (ya da iki sekme) çifti iki kez oluşturmaz, sınıra bir kalmış sunucuya açılışı olmayan bir kapanış yazılmaz.
  Saat dilimi veritabanının tanıdığı adla saklanır (aşağıya bakın). Elle eklemedeki denetimler aynen
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
  - `CARD_EXPIRES_BEFORE_RENEWAL`: **faturalamanın çekeceği kartın** (varsayılan kart; yoksa en yeni kart;
    faturalama başka kartı denemez) süresi yenileme tarihinden önce doluyor ve bakiye tutarı karşılamıyor. Süresi
    yeten yedek bir kart uyarıyı kaldırmaz; varsayılan yapılınca kalkar. Kart, son kullanma ayının son gününe kadar geçerli sayılır; son kullanma tarihi bilinmeyen
    kart hakkında sonuç çıkarılmaz. Varsayılan kart adıyla (son dört hane, AA/YY), tarih ve tutar söylenir.
  - `RENEWAL_NOT_COVERED`: süresi yeten kart yok, hesapta bakiye var ama yenilemeden az. Bakiye, eksik tutar,
    tarih ve tutar söylenir. Faturalama ayarlarında bakiye kapalıysa bakiye hesaba katılmaz.
  - İkisi de gizlenebilir; anahtar yenileme tarihini içerir, sonraki dönemde yeniden görünür.
- **Personel** (`GET /admin/billing/risk`, `billing.view`; Yönetim → Faturalandırma → "Risk altında" sekmesi ve
  `PAYMENT_RISK` içgörüsü). Hesap ve para birimi başına bir satır:
  - Listeye giren: vadesi geçmiş ödenmemiş faturası olan (itirazlı faturalar ve bakiye yüklemeleri sayılmaz) ya da
    son 30 günde en az 2 başarısız tahsilatı olan hesap. Müşterinin yarıda bıraktığı ya da süresi dolan ödeme
    sayfası (`CANCELLED_BY_CUSTOMER`, `EXPIRED`) başarısız tahsilat sayılmaz.
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

## Günlük işi kolaylaştıranlar

Bir kullanım incelemesinden ([ux-review.md](ux-review.md)) çıkan yardımcılar. Hepsi panelin içinde, panelin kendi
verisinden hesaplanır; yeni bir dış servis, yeni bir arka plan işi ya da yeni bir yoklama yoktur. Hiçbiri kişinin
tıklaması olmadan bir şey yapmaz.

### İşlemin süresi

- **Nerede:** sağ alttaki görev listesi (her satırda) ve sunucu sayfasının "İlerleme" bölümü (geçen süre, tahmin ve
  neye dayandığı). Biten uzun bir işlem iki dakika boyunca süresiyle söylenir ("Boyut değiştirme 2 dakika içinde bitti").
- **Kural** (`apps/api/src/eta-rules.ts`, birim testleri `apps/api/test/eta-rules.test.mjs`; `GET /operations/estimates`):
  son 90 günde **ilk denemede başarıyla biten** ve ödeme beklemeyen işlemlerin tıklamadan bitişe kadar geçen süreleri,
  tür başına en yeni 200 işlem. Disk boyutuna göre dört grup (≤ 40, ≤ 100, ≤ 300 GB, daha büyük): ortanca ve 90.
  yüzdelik. **Beşten az işlem olan grup için tahmin yoktur**; o zaman türün bütün boyutları kullanılır ve bu söylenir,
  o da beşten azsa hiçbir şey gösterilmez. 6 saatten uzun süren işlem (başka bir şeyi bekledi) süre sayılmaz.
- **"Her zamankinden uzun":** geçen süre 90. yüzdeliği ve ortancanın 1,5 katını (ve ortancayı en az 30 sn) aşınca.
  Yalnızca söylenir; işlemin kendi zaman aşımı değişmez.
- **Gizlilik:** yanıtta yalnız süreler vardır; sunucu, sahip ya da ad dönmez. 10 dakika Redis'te tutulur.
- **Türler:** kişinin beklediği uzun işler: oluşturma, silme, boyut, yeniden kurulum, anlık görüntü (al, dön, sil),
  yedek (al, geri yükle), taşıma, disk ekleme, imaj. Güç işlemleri saniyeler sürer, tahmin yoktur.

### Geri alınabilen kaldırmalar

- **Nerede:** SSH anahtarı silme (Hesap → SSH anahtarları), proje silme (Hesap → Projeler), güç zamanlaması silme
  (sunucu sayfası), güvenlik duvarından sunucu ayırma, hazır yanıt silme (personel, Destek). "Emin misiniz?" yerine öğe
  listeden hemen çıkar ve "Geri al" düğmeli bir ileti birkaç saniye (6 sn) görünür. İleti üzerine gelindiğinde ya da
  odaklandığında açık kalır; en geç 60 saniyede kaldırma gider.
- **Kural** (`apps/web/lib/undo.ts`, birim testleri `undo.test.ts`; sayfa tarafı `components/undo.tsx`): istek ileti
  kapanınca gönderilir; "Geri al" basılırsa **hiç gönderilmez**. Sekme kapanır ya da yenilenirse bekleyenler `keepalive`
  ile gönderilir. İstek başarısız olursa öğe geri gelir ve neden söylenir.
- **Yetki ve denetim:** API'ye eskisiyle aynı istek gider; yetki, kota, kilit ve denetim kaydı değişmez. Denetim kaydı
  yalnızca **gerçekleşen** kaldırmayı yazar; geri alınan hiç API'ye ulaşmadığı için kayıtta yoktur.
- **Geri alınamayanlar** adı yazılarak onaylanır ve neyin kaybolacağını söyler: sunucu silme, yeniden kurulum,
  yedekten geri yükleme ve artık **anlık görüntüye dönme** (tarihiyle: o andan sonra yazılan her şey kaybolur). API
  anahtarı iptali ve oturum kapatma bilerek bekletilmez.
- **Toplu silme** onayı yöneticinin bekleme süresini saatiyle söyler; süre kapalıysa düğme yerine nedeni yazılır (API
  böyle bir toplu silmeyi zaten reddeder).

### Bağlantı ve oturum

- **Panel yanıt vermezken** (iki istek üst üste başarısız, ya da tarayıcı çevrimdışı): bir şerit bunu söyler, bütün
  listeler yoklamayı **durdurur** (React Query'nin çevrimiçi durumu kapatılır; istekler yığılmaz), tek küçük bir istek
  (`/api/health`) 2, 4, 8, 16, sonra her 30 saniyede bir dener; "Şimdi dene" hemen dener. İlk başarılı yanıtta her şey
  sayfa yenilenmeden sürer ve ekrandakiler tazelenir. Kural: `apps/web/lib/reconnect.ts` (birim testleri). Bu sırada
  gönderilen bir değişiklik beklemeye alınmaz: hemen başarısız olur, neden söylenir ve form yazılanı tutar. Canlı olay
  akışı (EventSource) tarayıcının kendi yeniden bağlanmasıyla sürer.
- **Oturum bitmeden önce** (`GET /auth/me` yanıtındaki `session`, kural `apps/api/src/session-rules.ts`): bitişten 5
  dakika önce bir şerit ne zaman ve neden biteceğini söyler.
  - **Uzatılabilen** bitişler: "beni hatırla" ile açılan oturumun çerezi girişten (ya da son "Oturumu açık tut"tan)
    `SESSION_TTL_HOURS` saat sonra biter (kullanım veritabanındaki oturumu uzatır ama çerezi yeniden yazmaz); saklanan
    oturum son kullanımdan `SESSION_TTL_HOURS` sonra biter. "Oturumu açık tut" (`POST /auth/stay`) ikisini de şimdiden
    itibaren yeniler: tarayıcının gönderdiği aynı çerez (aynı belirteç ve imza) yalnız ömrü yeniden yazılarak gönderilir;
    "beni hatırla" seçilmemişse çerez tarayıcı kapanınca biten çerez kalır. Denetim kaydı: `session.extended`.
  - **Sabit** bitişler uzatılamaz ve nedenleri söylenir: "kullanıcı olarak gir" (1 saat), dizin ve SSO hesapları
    (`SESSION_TTL_HOURS`), rolün oturum süresi. API de bunları `SESSION_FIXED` ile reddeder.
  - Hiçbir şey kendiliğinden uzatılmaz. Yeni bir yoklama yoktur: uyarı zaten dakikada bir okunan `/auth/me` yanıtının
    "kalan milisaniye" değerinden, yanıtın geldiği andan sayılarak hesaplanır (saati kaymış bir bilgisayar uyarıyı
    kaydırmaz). Süre dolduktan sonrası eskisi gibidir (kaydedilmemiş metin ekranda kalır).

### Yönetici kurulum listesi

- **Nerede:** yönetici genel bakışı (`GET /admin/onboarding`, kural `apps/api/src/onboarding-rules.ts`, birim
  testleri). Önceki dokuz başlangıç adımına ek olarak "Sağlıklı tutar" adımları:
  - **E-posta gidiyor mu:** e-posta ayarlıysa, panelin gönderdiği son iletinin sonucu (adres ve konu tutulmaz; Redis
    `mail:last`, 30 gün). Başarısızsa ne zaman ve nedeni (sağlayıcının kodu) yazılır.
  - **Yedekler zamanlanmış mı:** sunucudaki bakım zamanlayıcısı kurulu ve yedek zamanlaması kapalı değil
    (`data/maintenance/settings.json`).
  - **İzleme açık mı:** Prometheus, Grafana ve Loki yanıt veriyor mu (Sistem sayfasının denetimi). Denetlenemezse
    adım gösterilmez.
  - **Güncellemeler:** otomatik güncelleme açık ya da en yeni sürüm çalışıyor; değilse bekleyen sürüm ve kanal yazılır.
  - **Ödeme yöntemi:** yalnızca faturalama açıksa, etkin bir ödeme yöntemi var mı.
  - **Personelde iki adımlı doğrulama:** müşterinin kendi sunucularından öte yetkisi olan, iki adımlı doğrulaması
    kapalı hesap sayısı (SSO hesapları sayılmaz: ikinci adımı sağlayıcı yapar).
- Her adım düzeltileceği sayfaya götürür ve neye dayandığını yazar. **"Bir şey değişene kadar gizle"** o an açık olan
  adımları bu tarayıcıda hatırlar (`lvm-setup-hidden`; kimin olduğunu değil hangi adımların açık olduğunu tutar); o
  sırada açık olmayan bir adım açılınca (bozulma ya da yeni adım) liste "Bir şey değiştiği için yeniden gösteriliyor"
  diyerek geri gelir. Kural: `apps/web/lib/setup-checklist.ts` (birim testleri).

### Yapıştırma ve hatalar

- **SSH anahtarı** (`apps/web/lib/formats.ts` `sshKeyInfo`, `repairPaste`; birim testleri `paste.test.ts`): türü,
  boyutu ve yorumu alanın altında yazılır ("ED25519 anahtarı, 256 bit · laptop"). Birkaç satıra bölünmüş anahtar,
  içeriğinin bittiği yerde birleştirilir (yorumu base64'e benzese de yutulmaz); RFC 4716 / SSH2 biçimi (PuTTYgen'in
  dışa aktarımı) tek satırlık OpenSSH biçimine çevrilir. **Özel anahtar** yapıştırılınca alan daha bırakılmadan uyarır;
  PuTTY dosyası, güvenlik anahtarı (sk-), DSA ve bozuk anahtar için ne yapılacağı söylenir. Kabul kuralı değişmedi
  (API ile aynı).
- **Liste alanları** (güvenlik duvarı kaynakları ve hedefleri, diğer tek satırlık listeler): satır satır yapıştırılan
  liste virgülle ayrılır; alan bunu söyler. Yanlış öğe eskisi gibi adıyla gösterilir.
- **Hatalar** (`apps/web/lib/error-key.ts`, birim testleri): çevirisi olan kod kendi cümlesini söyler; çevirisi
  olmayan kod (daha yeni bir API) adıyla söylenir ("Panel bunu reddetti (KOD) … bu kodu desteğe iletin"); kod
  taşımayan yanıt (vekil ya da ağ geçidi sayfası) HTTP durumuyla ve ne yapılacağıyla. Yalnızca hiçbir bilgi yoksa
  "bilinmeyen hata" denir. API'nin, adaptörlerin ve worker'ın gönderebildiği her kodun iki dilde cümlesi olduğunu
  `scripts/check-messages.mjs` denetler.

### Hatırlanan seçimler

- **Sipariş formu**, taslak yoksa, kişinin **en yeni sunucusunun** konumu, imajı, paketi (ya da serbest boyutu) ve
  projesiyle başlar; katalog bunlardan neyi hâlâ sunuyorsa yalnızca onu alır ve "Son sunucunuz web-3 esas alınarak
  dolduruldu … konum, imaj, paket" der; "Boş başla" temizler. Kural: `apps/web/lib/last-order.ts` (birim testleri).
  Tarayıcıya bunun için bir şey yazılmaz: sayfanın zaten okuduğu sunucu listesinden çıkarılır. Süren bir taslak,
  "benzerini sipariş et" ve paylaşılan sipariş bağlantısı buna dokunmaz. SSH anahtarı, parola ya da kart taşınmaz.
- Sipariş taslağı güvenlik duvarı seçimini de tutar (yalnız kimlikler); sayfadan SSH anahtarı eklemeye çıkınca
  kaybolmaz. "Benzerini sipariş et" artık projeyi de alır ve önceki bir kopyalama taslağını temizler.

### Klavye, odak ve dokunma

- Onay pencereleri kapanınca odak onları açan düğmeye döner, kapanış animasyonu odağı bıraktıktan sonra da (çekmece
  içindeki onaydan sonra Escape çekmeceyi kapatır). Sunucu listesinin hızlı menüsünden açılan pencereler kapanınca odak
  "…" düğmesine döner. "?" kısayol listesini açar (eskisi gibi).
- Küçük simge düğmeleri (etiket ×, ek dosya ×, kupon kopyalama, konum ping) dokunmatik ekranda görünüşleri aynı kalarak
  44 px alan alır (`.hit-44`).

## Kararlılık ve yeni yardımcılar (ikinci tur)

Kullanım incelemesinin ikinci turundan ([ux-review.md](ux-review.md#round-2--kararlılık-erişilebilirlik-ve-yeni-yardımcılar-2026-11-23)).
Hepsi panelin içinde, panelin kendi verisinden hesaplanır; dışarıya hiçbir şey gitmez, yeni bir dış servis ya da arka
plan işi yoktur ve hiçbiri kişinin tıklaması olmadan bir şey yapmaz. Yetki API'de denetlenir. Yeni çalışma zamanı
bağımlılığı yoktur; yalnız tarayıcı testleri için `@axe-core/playwright` (geliştirme bağımlılığı) eklendi.

### Sunucu sayfasında "sıradaki adımlar"

- **Nerede:** sunucu sayfasının üstünde, sunucu hazırken ve sürmekte olan bir işlem yokken (`GET
  /servers/:id/hints`, kural `apps/api/src/server-hint-rules.ts`, birim testleri `test/server-hint-rules.test.mjs`,
  entegrasyon testi `test/integration/stability.test.mjs`).
- **Öneriler**, her biri sunucunun şu anki durumundan:
  - **Yedek yok ya da eski:** son 30 günde hazır yedek yok. Yalnız konum yedek tutabiliyorsa ve bakan kişi yedek
    alabiliyorsa (yönetici müşterilere yedeği kapatmışsa müşteriye söylenmez); siparişten sonraki ilk gün söylenmez.
    "Yedek al" sayfanın Yedekler bölümüne götürür.
  - **Güvenlik duvarı yok:** konum güvenlik duvarı uygulayabiliyor, sunucuya hiçbiri bağlı değil. Güvenlik duvarları
    sayfasına götürür.
  - **Panel kök parolayı saklıyor:** sipariş sırasında belirlenen parolanın panel kopyası duruyor (ilk gün
    söylenmez). Kök parola bölümüne götürür; unutmak orada, onayla.
  - **Eski anlık görüntüler:** 30 günden eski anlık görüntü sayısı (platformdan, gösterge panelindeki bulguyla aynı
    önbellekle). Anlık görüntüler bölümüne götürür.
- Bölüme götüren düğme bölümü görünür yapar ve odağı ilk denetimine verir (klavye ve ekran okuyucu da oraya varır).
- **Gizle:** bir hafta ya da kalıcı; kişinin kendi bulgu gizlemeleri (`PUT /insights/dismissals`, anahtar
  `hint:<kod>:<sunucu>`). Personel aynı sunucuda kendi listesini görür.
- **Bilerek yok:** diskin doluluğu ve konuk işletim sisteminde parolayla girişin açık olup olmadığı. Platformlar
  bunları panele söylemiyor; tahmin eden bir öneri yarı yarıya yanlış olurdu.

### Siz yokken

- **Nerede:** müşteri gösterge paneli, karşılamanın altında (`GET /notifications/away`, kural
  `apps/api/src/away-rules.ts`, birim testleri `test/away-rules.test.mjs`).
- **Ne:** kişinin **kendi gelen kutusundaki** bildirimlerden, son "Görüldü"den beri: biten işlemler (sunucu hazır,
  yedek, anlık görüntü, güç ve boyut), başarısız işlemler (sunucu işlemi, güvenlik duvarı), faturalar (yeni, hatırlatma,
  gecikmiş, ödeme başarısız) ve talep yanıtları. Önce sayılar ("1 başarısız · 2 talep yanıtı · 3 tamamlandı"), sonra en
  kötüsü önde liste; her satır olduğu yere bağlantı. En çok 30 gün geriye; ilk kez açılınca hesabın açıldığı andan.
- **"Görüldü"** yalnız tıklamayla (`POST /notifications/away/seen`): liste o andan başlar, gösterdiği bildirimler
  gelen kutusunda da okundu olur. Okumak hiçbir şeyi değiştirmez. Yeni sütun: `users.away_seen_at`
  (`092_away_seen.sql`).

### Kararlılık

- **Eski yanıt yenisini ezmez** (`apps/web/lib/latest.ts`, birim testleri): `useLatest` her isteğe bir sıra verir,
  yalnız en yenisinin yanıtı yazılır. Kurulum sihirbazının denetimleri (bırakılan adımın ya da geride kalan denetimin
  yanıtı yazılmaz; aynı denetim sunucuda hâlâ sürüyorsa sihirbaz bir saniye arayla en çok 15 kez yeniden sorar) ve
  kök parolayı göster (unutulduktan ya da gizlendikten sonra gelen yanıt parolayı göstermez). `keepEdits`: ayar
  formları (sunucular, duyuru, güvenlik, genel sekmeler, giriş yöntemleri, e-fatura) kaydederken yazılanı ezmez.
- **Çift gönderme yok** (`apps/web/lib/once.ts`, birim testleri): aynı istek yolda iken ikinci basış ikinci isteği
  göndermez, ilkinin yanıtını alır. Bütün `useApiForm` formları (Enter tekrarı dahil), `useApiAction` eylemleri
  (aynı değişkenlerle; başka satırdaki aynı düğme ayrı çalışır), anlık görüntü formu, boyut değiştirme ve yeniden
  kurulum, ödeme sayfası. API'nin kendi korumaları (`Idempotency-Key`, aynı çerezle aynı POST için 409) arkada durur.
- **Geç gelen öneri:** alanın önerilen adı, alan odaktayken gelirse (dayandığı liste hâlâ yükleniyorken) seçili
  gelir; yazılan onun yerine geçer, arkasına eklenmez.
- **API'nin eş istek koruması:** yanıtı beklemeden ayrılan tarayıcının isteği artık iş bitince bırakılır (önceden iki
  dakika kalıyor, aynı istek "zaten işleniyor" alıyordu). Kurulum sihirbazı testinin ara sıra kalmasının nedeni
  buydu.
- **Listeler:** süzgeç ya da arama değişince (yönetici faturaları, abonelikler, ödemeler, destek kuyruğu, denetim
  kaydı, API istek günlüğü) yeni yanıt gelene kadar önceki satırlar kalır; denetim kaydında "daha fazla" yalnız yeni
  süzgecin yanıtıyla açılır. Tablolar yoklama bir satır ekleyince ilk sayfaya atlamaz.

### Kopyalama ve bağlantı

- Sunucu özetinde IP ve sunucu kimliği (kısa gösterilir, tamamı kopyalanır), fatura numarası, talep numarası için
  kopyalama düğmesi; "kopyalandı" yalnız gerçekten kopyalandığında (`lib/clipboard.ts`). Bağlantı kutusu Windows
  sunucuda SSH yerine Uzak Masaüstü komutunu ve `Administrator` kullanıcısını gösterir.

### Komut paletinde yazım hatası

- `apps/web/lib/fuzzy.ts` (birim testleri): önce tam eşleşenler, sonra sözcükleri herhangi bir sırada içerenler,
  sonra sözcüklerinden birinde bir harfi eksik, fazla, yanlış ya da yer değiştirmiş olanlar ("sevrer", "faturlar";
  8 harften uzun sözcükte iki). Türkçe İ/I/ı/i, büyük harf ve aksan hata sayılmaz. Rakam içeren sözcükler (IP, numara)
  ve 4 harften kısa sözcükler tam yazılmalı: "10.0.0.6" 10.0.0.5'i bulmaz. Arama yine tarayıcıda, palete zaten
  yüklenen listeler üzerinde; yetki her listenin kendi ucunda.

### Erişilebilirlik

- Tarayıcı testleri (`e2e/ux2.spec.ts`) giriş ve durum sayfasını, yönetici ve müşteri sayfalarını ve bir sunucu
  sayfasını açık ve koyu temada axe-core'dan geçirir (WCAG 2.0/2.1/2.2 A ve AA kuralları); ciddi ya da kritik bulgu
  testi düşürür. Bu turda düzeltilenler: açık temada ikincil metin, yeşil ve kırmızı metin ve yumuşak durum
  çipleri, kırmızı üstünde beyaz, gri üstünde vurgu rengi, koyu temada DELETE etiketi; başlık düğmeleri, bildirim zili,
  zamanlamanın gün düğmeleri ve Sistem'deki servis satırlarının ekran okuyucu adı; kullanıcılar sayfasındaki liste
  yapısı; 20 px'lik bir bağlantı ve kendi düğmelerinin altında kalan içgörü bağlantısı; kırmızı zemin üstünde kırmızı
  yazı. Ölçüm, sayfada yarı yolda bir geçiş kalmayınca yapılır; hedef boyutu, köşede bir süre duran katmanlar
  (çalışan işlemler listesi, iletiler) bir kenara alınarak ölçülür.
- Geri al iletisi (React Aria): F6 ile ulaşılan "Bildirimler" bölgesi, `alertdialog` içinde `alert` ile duyurulur,
  üzerine gelinince ya da odaktayken süresi durur, odağı sayfadan almaz; tarayıcı testi saati ileri sararak denetler.
- `@smoke` adlı testler Firefox ve WebKit'te de koşar.
