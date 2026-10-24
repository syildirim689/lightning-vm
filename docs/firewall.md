# Firewall

Hetzner Cloud Firewall'a benzer: müşteri adlandırılmış bir kural seti oluşturur, gelen ve giden kuralları
yazar ve seti sunucularına bağlar. Kuralları VMware uygular (Distributed Switch port filtresi); sunucunun
içinden kapatılamaz.

## Kullanıcı açısından
- **Firewall'lar** sayfası (`/firewalls`): oluşturma (şablonlar: boş, web sunucusu, yalnızca SSH,
  Windows/RDP), kart görünümü, her kartta bağlı sunucular ve kuralların durumu.
- **Firewall sayfası**:
  - gelen ve giden kurallar birlikte düzenlenir ve tek seferde kaydedilir;
  - hızlı ekleme düğmeleri vardır: SSH, HTTP, HTTPS, Ping, RDP, DNS;
  - kural alanları: protokol (TCP, UDP, ICMP, ESP, GRE), port veya aralık, adresler/ağlar (IPv4/IPv6 CIDR), açıklama;
  - bağlı sunucuların tablosu, sunucu bağlama ve bağlantı kaldırma, başarısız olanı yeniden uygulama.
- **Sunucu sayfası**: bağlı firewall'lar ve kuralların durumu (Uygulandı / Uygulanıyor / Başarısız).
- **Sipariş**: isteğe bağlı firewall seçimi. Seçilenler VM ilk kez açılmadan önce uygulanır.
- **Bildirim**: kurallar sunucuya yazılamazsa `server.firewall_failed` gönderilir.

## Kurallar (Hetzner ile aynı anlam)
- **Gelen:** yalnızca bir kuralın izin verdiği trafik girer, gerisi düşer. Hiç gelen kural yoksa hiçbir şey girmez.
- **Giden:** giden kural yoksa her şey serbesttir. En az bir giden kural varsa yalnızca izin verilenler çıkar.
- Bir sunucuya en fazla 5 firewall bağlanabilir ve kuralları toplanır.
- Sınırlar: firewall başına 50 kural, kural başına 100 adres. Sunucu başına toplam 500 filtre kuralı;
  her adres ayrı bir filtre kuralı sayılır.
- Kullanımdaki bir firewall silinemez (`FIREWALL_IN_USE`); önce bağlantısı kaldırılır.

## Nasıl uygulanır
1. API kuralları doğrular ve kaydeder (`firewalls`, `firewall_servers`). Etkilenen her sunucunun
   `firewall_version` değeri artar. İş, COMMIT'ten **sonra** `firewalls` kuyruğuna bırakılır.
2. Worker bu kuyruğu tek tek (concurrency 1) işler:
   - sunucunun güncel kurallarını okur, sürümü kurallardan önce okur;
   - adaptöre `/v1/vm/firewall` isteği atar;
   - uygulanan sürümü `firewall_applied_version` olarak yazar.
   Kayıp bir iş, kurtarma taramasında yeniden kuyruğa girer (`applied < version`).
3. Go adaptörü (`services/vmware/firewall.go`):
   - VM'in her ağ kartı için distributed port'u bulur. Standart switch'teki bir kart için
     `FIREWALL_NEEDS_DVS`, port atanmamış kart (ephemeral binding) için `FIREWALL_NO_PORT` döner.
   - Port grubunda "traffic filtering override" kapalıysa açar.
   - Porta `dvfilter-generic-vmware` trafik kuralı setini yazar; varsa düzenler, firewall kalmadıysa kaldırır.
4. Yeni sunucuda kurallar klon ile ilk açılış arasında uygulanır (`firewall` adımı).

### Durumsuz filtre için eklenen otomatik kurallar
vDS filtresi durumsuzdur (stateful değildir) ve sıra numarasına göre ilk eşleşen kural uygulanır. Bu yüzden
kullanıcının kurallarına şunlar eklenir:
- gelen TCP/UDP: 32768-65535 hedef portları (sunucunun açtığı bağlantıların yanıtları);
- ICMPv6 (IPv6 komşu keşfi);
- gelen için en sonda "geri kalan her şeyi düşür";
- giden kural varsa:
  - izin verilen gelen servislerin yanıtları (kaynak port = servis portu);
  - ICMPv6;
  - en sonda "geri kalan her şeyi düşür".

**Sınırlama:** 32768-65535 aralığında dinleyen bir servis, gelen kural olmadan da erişilebilir olur. vDS
filtresinde bağlantı takibi olmadığı için bu bilinçli bir uzlaşmadır. Gerçek durumlu filtre için NSX
dağıtık firewall gerekir.

## Altyapı gereksinimleri
- vCenter ve vSphere Distributed Switch (vDS). Tek ESXi'de firewall sunulmaz; bağlantı, keşifte
  `operations.firewall = false` olarak işaretlenir.
- Sunucu port grubu **static binding** kullanmalıdır (varsayılan).
- Bağlantı hesabında şu yetkiler olmalıdır:
  - `DVSwitch.PortConfig` (port filtresini yazmak);
  - `DVPortgroup.PolicyOp` (override iznini açmak).

## Doğrulama
- **Go:** kural çevirisi için birim testleri yazıldı. Simülatörde uygulama, düzenleme, kaldırma, port grubu izni ve
  hata kodları test edildi. Simülatör `ReconfigureDVPort_Task` desteklemediği için bunu test amaçlı
  `simfw` paketi taklit eder.
- **API entegrasyonu:** doğrulama, sahiplik, standart switch'te `FIREWALL_NEEDS_DVS`, sipariş anında uygulama,
  kural değişikliği ve bağlantı kaldırmanın yeniden uygulanması test edildi.
- **Gerçek vCenter'da doğrulanmadı:**
  - Trafik yönü eşlemesi: VM'e gelen trafik = `outgoingPackets`. Bu, vSphere belgelerindeki
    ingress/egress tanımından alındı.
  - Paketlerin gerçekten düştüğü.
