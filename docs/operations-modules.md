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
