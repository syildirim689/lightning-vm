# Birden fazla sunucuda çalışma (cluster)

Amaç: panel bir sunucu çökse de çalışmaya devam etsin ve yük arttıkça sunucu ekleyerek büyüsün.

## 1. Uygulamanın çoklu kopyaya hazırlığı (tamamlandı)
API, web, worker, konsol ağ geçidi ve VMware adaptörü birden fazla kopya olarak çalışabilir. Ortak durum
PostgreSQL ve Redis'tedir:

| Konu | Durum |
|---|---|
| Oturumlar | PostgreSQL'de (better-auth). Hangi kopyaya gidilirse gidilsin geçerli. |
| İş kuyrukları | BullMQ (Redis). İşler kopyalar arasında dağılır; iş kimlikleri tekrarı önler. |
| Firewall uygulama | Kuyrukta **genel eşzamanlılık 1**: tüm worker kopyaları birlikte aynı anda tek iş çalıştırır. Eski kural yeni kuralın üstüne yazılamaz. |
| Uzlaştırma, içgörü uyarıları | Redis kilidi: aynı anda yalnızca bir kopya çalışır. |
| Kurtarma taramaları | Her kopya çalışır. İş kimliği aynı olduğu için aynı iş iki kez kuyruğa girmez. |
| Roller ve izinler | Her API kopyası bellekte tutar. Bir değişiklik Redis üzerinden duyurulur ve tüm kopyalar hemen yeniden yükler; ayrıca dakikada bir yedek yükleme yapılır. **Kaldırılan bir izin her kopyada hemen geçersiz olur.** |
| Ayarlar | Kopya başına 10 sn önbellek. Değişiklik en geç 10 sn'de her kopyaya ulaşır. |
| Migration | PostgreSQL advisory lock ile tek seferde bir kopya çalıştırır. |
| Worker sağlığı | Her kopya kendi adıyla (container host adı) sinyal yazar. Bir günden eski satırlar silinir. Panel en az bir sağlıklı kopya arar. |
| Konsol oturumları | Tek kullanımlık oturum ve iptal bilgisi Redis'te. Kullanıcı başına eşzamanlı konsol sınırı **kopya başına** sayılır (N kopyada en fazla N katı). |

**Doğrulama:** API entegrasyon testleri iki worker kopyasıyla 70/70 geçti; buna firewall, sunucu yaşam döngüsü
ve kurtarma testleri dahil. Rol değişikliğinin başka bir süreçteki kopyaya hemen ulaştığı ayrıca test edildi.

## 2. Cluster modu (ertelendi, 2026-10-24)
Kullanıcı kararı: en az 3 test sunucusu hazır olunca eklenecek. Sunucu kaybı denemesi yapılmadan yazılmayacak.
Bugünkü tek sunuculu kurulum bu adıma hazırdır: uygulama çoklu kopyada test edildi (1. bölüm), veriler
PostgreSQL ve Redis'te, yedekler ve güncelleme `install.sh` ile yapılıyor. Plan:
- **Docker Swarm** (Docker'ın içinde gelir).
  - `sudo sh scripts/install.sh cluster init`: ilk sunucuda cluster'ı kurar ve katılım komutunu basar.
  - `sudo sh scripts/install.sh cluster join <adres> <anahtar>`: yeni sunucuyu ekler.
  - API, web, worker, konsol ve adaptör kopyaları sunuculara dağıtılır; bir sunucu düşerse Swarm kopyaları
    diğerlerinde yeniden başlatır.
- **PostgreSQL:** Patroni + etcd ile birincil ve yedek kopya, otomatik devralma.
- **Redis:** Sentinel ile otomatik devralma.
- **Giriş noktası:** her sunucuda Caddy. Panel adresi sunucular arasında gezen sanal bir IP'ye (keepalived/VRRP)
  ya da veri merkezinin yük dengeleyicisine bağlanır.
- **Güncelleme:** panelden güncelleme kopyaları sırayla değiştirir (rolling); panel kesintisiz kalır.
- **Yedek:** veritabanı yedeği birincil kopyadan alınır; ajan her sunucuda kurulur ve işi lider sunucu yapar.

Gerçek yüksek erişilebilirlik için **en az 3 sunucu** gerekir (çoğunluk kararı: biri düşünce ikisi devam eder).
