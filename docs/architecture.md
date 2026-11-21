# Mimari

## Parçalar
Tarayıcı → Caddy (`proxy`) → Next.js (`web`) ya da NestJS/Fastify (`api`). Caddy `/console/ws` yolunu konsol
geçidine, `/terminal/ws` yolunu (açıksa) terminal servisine verir. API → PostgreSQL + Redis/BullMQ; uzun işleri
`worker` yürütür.

API ve worker hipervizörle doğrudan konuşmaz: bağlantının türüne göre yedi adaptör servisinden birini çağırır.
Adaptörler durum tutmaz, yalnızca Compose'un iç ağında dinler (dışarıya açık portları yoktur) ve ortak bir servis
anahtarı ister. Hepsi aynı HTTP sözleşmesini konuşur ([adapter-contract.md](adapter-contract.md)); bir adaptörün
yapmadığı işlem `PLATFORM_NOT_SUPPORTED` yanıtı alır. Hangi platformun neyi yaptığı README'deki "Platform kapsamı"
tablosundadır.

| Servis | Ne yapar |
|---|---|
| `web` | Next.js: müşteri ve yönetici paneli, kurulum sihirbazı, herkese açık durum sayfası |
| `api` | REST API, kimlik doğrulama (better-auth), ayarlar, faturalandırma, bildirimler; bildirim, ters DNS ve webhook kuyruklarını da kendisi tüketir |
| `worker` | Sunucu işlemleri (oluşturma, silme, güç, boyut, snapshot, yedek, disk, taşıma), uzlaştırma, enerji ve trafik örnekleri, kötüye kullanım taraması |
| `vmware` | Go + govmomi: vCenter / ESXi adaptörü |
| `proxmox`, `xcpng`, `ovirt`, `hyperv`, `libvirt`, `incus` | Node.js (bağımlılıksız): diğer altı platformun adaptörleri |
| `console` | Go: tarayıcı konsolu için WebSocket geçidi (yalnız VMware WebMKS) |
| `terminal` | `console` ile aynı kod, ayrı servis: yöneticinin panel sunucusuna terminali. Varsayılan olarak kapalıdır |
| `postgres`, `redis` | Kalıcı veri; kuyruklar, kilitler, kısa ömürlü oturum bilgileri |
| `proxy` | Caddy: TLS, yönlendirme, güvenlik başlıkları |
| İzleme profili | Prometheus, Alertmanager, Grafana, Loki, OpenTelemetry toplayıcısı (isteğe bağlı) |

Hostta, container dışında iki şey çalışır: `scripts/install.sh` (kurulum, güncelleme, yedek, geri yükleme) ve onu
panelin istekleri için çağıran **host ajanı** (systemd). Panel bir bakım isteğini bir klasöre dosya olarak bırakır,
ajan isteği yeniden doğrular ve betiği çalıştırır; sonuçları panel salt okunur bir klasörden okur. Web ve API
container'larına Docker soketi ya da host yetkisi verilmez.

Bunun tek istisnası terminal servisidir: açıldığında ayrıcalıklı (privileged) bir container olarak hostun kendisine
root kabuğu açar. Bu yüzden varsayılan olarak kapalıdır, yalnızca iki adımlı doğrulaması açık yöneticilere sunulur
ve oturumları sınırlıdır.

## Doğruluk ve yeniden deneme kuralları
- **PostgreSQL kalıcı doğruluk kaynağıdır.** Redis/BullMQ yalnızca iş kimliğini taşır; kuyruk kaybolsa da worker'ın
  kurtarma taraması açık işlemleri veritabanından bulup yeniden kuyruğa alır.
- Platform çağrısından **önce** işlem kaydı (`operations`) ve kaynak / IP rezervasyonu yazılır; çağrıdan dönen görev
  kimliği beklemeye başlamadan önce saklanır. Yeniden başlayan worker kayıtlı görevi beklemeye devam eder.
- Zaman aşımından ya da kaybolan bir görevden sonra gerçek nesneye bakılmadan aynı çağrı yinelenmez: sonuç okunabiliyorsa
  okunur, okunamıyorsa adım yeniden denenebilir olarak başarısız sayılır ve bir sonraki denemede baştan verilir.
- Bir sunucuda aynı anda tek açık işlem olur (veritabanındaki tekil indeks).
- Worker panel kayıtlarını platformdaki `lvm-*` VM'lerle düzenli olarak karşılaştırır (uzlaştırma); farkı bulgu olarak
  yazar, hiçbir şeyi kendiliğinden silmez.

Ayrıntı: [provisioning.md](provisioning.md).

## Güvenlik
Uygulananlar: izin tabanlı roller ve rol sınırları, sahiplik denetimi, güvenli çerezler, CSRF koruması, hız sınırları,
iki adımlı doğrulama (uygulama, SMS, e-posta, yedek kodlar), passkey, LDAP ve OpenID Connect ile giriş, sırların ana
anahtarla (`secrets/master.key`) şifrelenmesi, denetim kaydı, kullanıcının verdiği adreslere yalnızca herkese açık
HTTPS üzerinden istek ([auth.md](auth.md)).

Olmayanlar: bir projeyi ya da sunucuyu birden çok kullanıcının
paylaştığı bir ekip yapısı yoktur (proje tek sahibe aittir; bayi ve müşterileri ayrı bir yapıdır). Proje bağımsız bir
güvenlik denetiminden geçmedi (yapay zekâ destekli kısmi bir iç denetimin özeti: [security-audit.md](security-audit.md)). HTTPS olmadan yalnızca loopback üzerinde kullanılmalıdır.

## İşletim
Yedekleme, geri yükleme ve güncelleme hostta `scripts/install.sh` ile çalışır ([operations.md](operations.md),
[updates.md](updates.md)). Güncelleme yedek, migration uyumluluğu, iş boşaltma, sağlık kontrolü ve container geri
dönüşü içerir; veritabanı geri dönüşü yedekten elle yapılır. Kurulum ve güncelleme imajları kaynak koddan derler;
sürümlü, imzalı bir kurulum paketi yoktur. Birden çok sunucuda çalışma (cluster) yazılmadı ([cluster.md](cluster.md)).
