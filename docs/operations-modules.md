# Topoloji, enerji, kötüye kullanım izleme ve sanal veri merkezi

## Topoloji (`/admin/topology`, `/topology`)

- **Yönetici görünümü:** İnternet → lokasyon → küme → host → sunucu.
  - Host kutularında CPU ve RAM çubukları vardır.
  - Bir hostta en çok trafik yapan 6 sunucu gösterilir. Kalanlar "+N" düğümünde toplanır.
- **Müşteri görünümü:** İnternet → lokasyon → kendi sunucuları. Firewall uygulanan bağlantıda kalkan simgesi
  görünür.
- **Paket animasyonu:** paketler gerçek trafikle akar. Gelen ve giden trafik ayrı renktedir. Paketlerin sayısı
  ve hızı, bağlantının altındaki tüm sunucuların trafiğinin logaritmasına göre ayarlanır.
- **Veri kaynağı:** adaptörün `/v1/topology` ucu kullanılır. Bu uç property collector ile tek bir PerfManager
  sorgusu yapar (`net.received/transmitted.average`, son 20 sn).
- **Önbellek:** veri her bağlantı için 15 sn Redis'te tutulur, sayfa 15 sn'de bir yenilenir.
- **Erişilebilirlik:** düğümler klavyeyle gezilebilir ve odaklanılan düğümün kök yolu vurgulanır. "Hareketi
  azalt" açıksa paketler gösterilmez. Aynı veriler "Tablo" sekmesinde de vardır.

## Enerji (`/admin/energy`)

- **Ölçüm:** worker 5 dakikada bir (`POWER_SAMPLE_MINUTES`) her host için `/v1/power` ucunu çağırır.
  - Host `power.power.average` sayacını bildiriyorsa değer **ölçülen** olarak kaydedilir.
  - Bildirmiyorsa **tahmini** değer kullanılır: `boşta + (tam yük − boşta) × CPU kullanımı`. Varsayılan profil
    120–400 W'tır. Host başına profil enerji sayfasından girilir.
- **Sunucu payı:** hostun gücü, üzerindeki sunuculara CPU kullanımı oranında dağıtılır. Bu bir tahmindir.
- **kWh hesabı:** her örnek bir önceki örneğe kadar geçen süreyi (en fazla 15 dk) temsil eder. Worker'ın
  kapalı kaldığı süre tüketime eklenmez.
- **Ayarlar:** kWh fiyatı, para birimi, PUE (tesis yükü) ve şebeke CO₂ yoğunluğu (g/kWh).
- **Saklama:** host örnekleri 400 gün, sunucu örnekleri 120 gün tutulur.

## Kötüye kullanım izleme (`/admin/abuse`)

- **Port taraması:** her hazır sunucunun IPv4 adreslerinde, listedeki riskli portlara TCP bağlantısı denenir.
  - Varsayılan liste: Telnet, SMB, MS SQL, Docker API, MySQL, PostgreSQL, Redis, Elasticsearch, Memcached,
    MongoDB.
  - Tarama varsayılan olarak 30 dk'da bir yapılır. Aynı anda en fazla 64 deneme yapılır, zaman aşımı 2 sn'dir.
  - Açık port bir bulgu açar. Port kapanınca bulgu kendiliğinden kapanır.
- **Madencilik şüphesi:** pencere içinde (varsayılan 6 saat) örneklerin en az %90'ı CPU eşiğinin (varsayılan
  %90) üstündeyse bulgu açılır. Bu bir işarettir, kanıt değildir.
- **Bildirim:** yeni bulgu, `servers.view_all` iznine sahip personele `admin.abuse` olarak bildirilir.
  "Müşteriye de bildir" açıksa açık port müşteriye `server.port_open` olarak gider.
- **Onaylama:** personel bulguyu not ile onaylayabilir. Bulgu açık kalır ama yeniden bildirilmez.
- **Kapsam dışı:** yalnızca panelin ağından görünen portlar taranır. Dışarıdan açık ama panelden kapalı bir
  port görülmez. Giden bağlantı (madencilik havuzu) izlemesi yoktur.

## Sanal veri merkezi (VDC)

- **Tahsis:** yönetici, Katalog → Sanal veri merkezleri bölümünden müşteriye bir havuzda tahsis yapar
  (vCPU, RAM, disk, en fazla sunucu) ve aylık ücret belirler.
  - Tahsis havuz kapasitesinden hemen düşülür. VDC içindeki sunucular ayrıca sayılmaz.
  - Büyütmek için havuzda yer olmalıdır. Küçültme, kullanılan kaynağın altına inemez.
- **Müşteri:** `/vdc` sayfasında kalan kaynak içinde istediği boyutta sunucu açar.
  - Bu sunucular ücretsizdir ve kullanıcı kotasına sayılmaz.
  - Kullanım çubuklarını görür ve toplu güç işlemleri yapabilir: tümünü aç, kapat, sıfırla.
- **Silme:** VDC, içinde sunucu varken silinemez.

## Akıllı özellikler

Kurallar `apps/api/src/smart-rules.ts` içindedir ve birim testleri vardır. Veriler `apps/api/src/smart.ts` uçlarından gelir.

- **Doğru boyutlandırma:** son 7 günün CPU örnekleri (`server_cpu_samples`) kullanılır. Öneri için en az 3 gün ve 24
  örnek gerekir.
  - Ortalama < %2 ve 95. yüzdelik < %5: **boşta** (`IDLE_SERVER`).
  - Ortalama < %10 ve 95. yüzdelik < %30 (1 vCPU'dan büyükse): **büyük** (`RIGHT_SIZE_DOWN`).
  - 95. yüzdelik > %85: **küçük** (`RIGHT_SIZE_UP`).
  - Önerilen vCPU, 95. yüzdeliği yaklaşık %60'a getirecek sayıdır.
  - Müşteri bunları içgörü olarak görür. Yönetici, boşta veya büyük sunucuların sayısını ve boşalacak vCPU'yu
    görür (`OVERSIZED_SERVERS`). VDC sunucuları hariçtir.
- **Sağlık puanı** (`GET /servers/:id/health`): 100'den başlar. Düşüşler şöyledir:
  - hata durumu −60
  - açık güvenlik bulgusu −15 (en fazla −30)
  - son 24 saatte başarısız işlem −10 (en fazla −20)
  - CPU doygun −15, CPU sık yüksek −8
  - kapalı −5, boşta −5

  85 ve üstü sağlıklı, 60 ve üstü göz atılmalı, altı sorunlu sayılır. Nedenler sunucu sayfasında listelenir.
- **Bu ayın maliyeti** (`GET /usage/summary`): sunucu ve VDC aylık fiyatları, bu ay var oldukları günlere göre
  oranlanır (UTC). Şu ana kadarki tutar, ay sonu tahmini ve aylık toplam para birimi başına gösterilir.
- **Kurulum listesi** (`GET /admin/onboarding`): vCenter, lokasyon, havuz, şablon, paket, IP havuzu, e-posta, ilk
  yedek ve iki adımlı giriş. Tüm adımlar bitene kadar yönetim özetinde görünür.
- **Klavye kısayolları:** `?` listeyi açar. `g` ardından bir harf sayfaya gider: `h` sunucularım, `o` yeni sunucu,
  `a` hesap, `t` topoloji, `d` yönetim özeti, `s` tüm sunucular, `c` katalog. Kısayollar metin alanlarında ve açık
  pencerelerde çalışmaz. Komut paletinde (Ctrl+K) yeni sayfalar ve "Klavye kısayolları" eylemi de vardır.
- **Duyarlılık:** E2E, her sayfayı 390 px ve 768 px genişlikte yatay kaydırma olmadan açar. Sunucu sayfası da iki
  genişlikte denetlenir.

## İşi kolaylaştıran araçlar

- **Etiketler ve notlar** (`PUT /servers/:id/labels`, `{ tags, notes }`): sunucu sahibinin kendi etiketleri ve notlarıdır.
  - En fazla 10 etiket olur, her biri 1–24 karakterdir. Etiket harf veya rakamla başlar; boşluk, `.`, `_` ve `-`
    içerebilir. Büyük/küçük harf farkı yok sayılarak tekrarlar atılır.
  - Notlar en fazla 2000 karakterdir.
  - Başkasının sunucusunu değiştirmek için `servers.manage_all` gerekir.
  - Migration: `020_server_labels`.
- **Liste süzgeçleri:** müşteri kartları ve yönetici tablosu aynı süzgeci kullanır (`server-filters.tsx`).
  - Arama ad, IP, lokasyon, şablon, sahip ve etiketlerde yapılır. Durum süzgeçleri: çalışıyor, kapalı, sorunlu,
    işlemde. Etiket ve sıralama (en yeni, ada göre) da seçilebilir.
  - Seçimler URL'de tutulur (`?q=&state=&tag=&sort=`), bu yüzden görünüm yer imine eklenebilir.
- **CSV indir** (yönetici): süzgeçten geçen satırlar UTF-8 BOM ile indirilir. `= + - @` ile başlayan hücreler
  formül olarak çalışmasın diye başına `'` eklenir.
- **Bağlan kartı:** IP, `ssh root@IP` ve `scp` komutları tek tıkla kopyalanır.
- **Benzerini sipariş et:** sipariş formu aynı lokasyon, şablon ve boyutla (paket veya özel) açılır. Ad olarak
  sıradaki boş `ad-N` önerilir. VDC sunucularında bu düğme yoktur.
- **Son açılanlar:** komut paleti, bu tarayıcıda son açılan 5 sunucuyu gösterir (`localStorage`).

## Güç zamanlaması ve toplu işlemler

- **Güç zamanlaması** (`/servers/:id/schedules`, sunucu sayfasında "Güç zamanlaması"): sunucu seçilen günlerde
  (ISO 1 = Pazartesi), yerel bir saatte açılır veya kapatılır (düzgün kapatma).
  - Saat dilimi tarayıcıdan alınır ve zamanlamayla birlikte saklanır.
  - "Mesai saatleri" düğmesi tek tıkla hafta içi 08:00 aç ve 19:00 kapat ekler.
  - Sunucu başına en fazla 10 zamanlama olur. Müşteri güç işlemleri yönetici ayarlarında kapalıysa eklenemez;
    eklenmiş zamanlamalar da atlanır.
  - Zamanlayıcı API'de dakikada bir çalışır. Redis kilidi sayesinde tek örnek çalışır. Belirlenen saatten sonraki
    5 dakika içinde ve son 10 dakikada çalışmamışsa normal bir işlem başlatır. Sunucu zaten istenen durumdaysa
    veya başka bir işlem sürüyorsa atlar. Son sonuç ve zamanı listede görünür.
  - 5 dakikadan uzun süren bir API kesintisinde o çalıştırma kaçırılır; telafi edilmez.
  - Migration: `021_power_schedules`.
- **Toplu güç işlemi** (yönetici, `POST /admin/servers/actions`, `servers.manage_all`): süzgecin gösterdiği
  sunuculara (en fazla 200) aç, kapat, zorla kapat veya sıfırla uygulanır.
  - Uygulamadan önce onay istenir. Her sunucuya ayrı işlem açılır. İşlemi süren veya uygun olmayan sunucular
    atlanır ve sayılır.
  - Aynı Idempotency-Key ile tekrarlanan istek yeni işlem başlatmaz.

## Denetim kaydı, hesap etkinliği ve duyuru

- **Denetim kaydı** (`/admin/audit`, `GET /admin/audit`, `audit.view` izni): tüm olaylar en yenisi önce, sayfa başına
  50 kayıt (`before` ile).
  - Arama işlem adında, e-postada, IP'de ve ayrıntılarda yapılır. Sonuç (başarılı, başarısız, reddedildi) ve
    kategori (`auth`, `server`, `settings`…) ile süzülür. Süzgeçler URL'de tutulur.
  - Her kaydın ayrıntısı açılabilir. Bilinen işlemler Türkçe/İngilizce adla gösterilir.
- **Hesap etkinliği** (Hesabım → Etkinlik, `GET /activity`): kullanıcının kendi girişleri ve değişiklikleri,
  sunucularında güç zamanlamalarının yaptıkları da dahil ("Zamanlama" etiketiyle).
- **Duyuru** (Ayarlar → Duyuru, `PUT /admin/settings/announcement`; okuma: `GET /announcement`): oturum açılmış
  her sayfanın üstünde görünen nottur.
  - Metin Türkçe ve İngilizce girilir. Ton (bilgi, uyarı, kritik, iyi haber), isteğe bağlı bağlantı (panel yolu
    veya https) ve başlangıç/bitiş zamanı seçilebilir.
  - Kullanıcı duyuruyu kapatabilir (tarayıcıda saklanır). Her kayıt yeni bir kimlik aldığı için, değiştirilen
    duyuru yeniden görünür.

## Anlık görüntüler, GitHub anahtarları, palette kullanıcılar

- **Anlık görüntüler** (sunucu sayfası; `GET/POST /servers/:id/snapshots`, `POST …/:sid/revert`, `DELETE …/:sid`):
  disklerin bellek olmadan alınan geri dönüş noktalarıdır. VMware Tools gerekmez.
  - Alma, geri dönme ve kaldırma normal işlemlerdir: sunucu başına tek işlem, görev listesi, geçmiş, yeniden
    deneme ve `server.snapshot` bildirimi.
  - Geri dönmede o noktadan sonra yazılanlar kaybolur. Sunucu açıksa geri dönüşten sonra yeniden açılır.
  - Sunucu başına en fazla 5 görüntü olur. Görüntünün o sanal makineye ait olduğu bağdaştırıcıda doğrulanır.
  - Yönetici, Ayarlar → Sunucular → "Anlık görüntüler" ile müşteriler için kapatabilir.
  - Migration: `022_snapshots` (yeni işlem türleri ve `operations.params`).
- **GitHub'dan SSH anahtarı** (Hesabım → SSH anahtarları, `POST /ssh-keys/github`): `github.com/<kullanıcı>.keys`
  adresindeki açık anahtarlar içe aktarılır (en fazla 20). Var olanlar atlanır.
- **Komut paleti:** `users.view` izni olan personel, kullanıcıları e-postayla arar. Seçince kullanıcı listesi o
  e-postayla süzülmüş olarak açılır.
- Ayarlar artık bir seviye derin birleştirilir. Sonradan eklenen bir anahtar (ör. `servers.customer.snapshots`),
  eski kayıtlı ayarda da varsayılan değerini alır.

## Alarmlar panel bildirimlerinde

- **Varsayılan akış:** Alertmanager'ın hazır yapılandırması (`deploy/observability/alertmanager.panel.yml`) her
  alarmı iç ağdan API'ye gönderir (`POST /internal/alerts`). API bunu `admin.alert` bildirimine çevirir.
  - Bildirim `system.view` izni olan yöneticilere gider: panel içi, e-posta, push. Yönetici politikası ve
    kişisel tercihler uygulanır.
  - Alarmın "Türkçe / English" özeti iki dile ayrılır. Sorun çözüldüğünde "Çözüldü" bildirimi gelir.
- **Sunucuda düzenlenecek dosya yok:** `data/observability/alertmanager.yml` kendi alıcılarını tanımlamadıkça
  hazır yapılandırma kullanılır. Alıcı eklenirse o dosya geçerli olur; paneli de korumak için
  `http://api:4000/internal/alerts` adresine giden bir webhook alıcısı eklenir.
- **Güvenlik:** Caddy `/api/internal/*` yolunu dışarıya 404 ile kapatır. Vekil üzerinden gelen (X-Forwarded-*)
  istekler de reddedilir. Bu uç çerezsiz çağrıldığı için CSRF başlığı istenmez.
