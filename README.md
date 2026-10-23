# Lightning VM

Açık kaynak VMware sunucu yönetim platformunun başlangıç deposu.

**Durum: geliştirme iskeleti. Üretime ve müşteri kullanımına hazır değildir.**

## Çalışan bileşenler
- Next.js (TypeScript) kullanıcı ve yönetim başlangıç ekranları; Türkçe/İngilizce (docs/i18n.md).
- Kimlik doğrulama: e-posta/parola girişi, `admin`/`user` rolleri, sunucu tarafı oturumlar, CSRF ve
  hız sınırı, kurulum anahtarıyla güvenli ilk yönetici, denetim kayıtları (docs/auth.md).
- NestJS/Fastify API: canlılık, PostgreSQL/Redis hazır olma kontrolü, yönetici sistem durumu ve Prometheus metrikleri.
  `/metrics` yalnızca iç ağdan erişilir; Caddy üzerinden `/api/metrics` 404 döner.
- BullMQ worker: Redis bağlantısı, PostgreSQL heartbeat ve bilinmeyen işleri reddetme.
- PostgreSQL sürümlü migration'lar (`migrate` servisi); Redis AOF; Caddy ters proxy.
- İsteğe bağlı Prometheus, Grafana, Loki ve OpenTelemetry Collector.
- GitHub Actions derleme kontrolü ve sürüm etiketinden GHCR imaj yayını.

## Henüz uygulanmayanlar
Kurulum sihirbazının kalan adımları, MFA, parola sıfırlama, proje/müşteri modeli, VMware bağlantısı, VM işlemleri, konsol geçidi,
IP tahsisi, faturalama, yedekleme otomasyonu ve otomatik güncelleme.
Paneldeki kapalı düğmeler bu işlevleri gerçekleştirmez.

## Gereksinimler ve ilk çalıştırma
Docker Engine + Compose v2 ve OpenSSL bulunan Linux sunucu.

```sh
sh scripts/install.sh
docker compose ps
curl -fsS http://127.0.0.1:8080/api/ready
```

Kurulum betiği sonunda **1 saat geçerli bir kurulum anahtarı** yazar. http://127.0.0.1:8080/setup
adresinde bu anahtarla ilk yönetici hesabını oluşturun. Anahtarın süresi dolduysa:

```sh
docker compose exec api node dist/cli.js bootstrap-token
```

Panel: http://127.0.0.1:8080 — yönetim: /admin.
Uzak sunucudan erişim için kendi bilgisayarında:

```sh
ssh -L 8080:127.0.0.1:8080 KULLANICI@SUNUCU
```

Varsayılan portlar yalnızca loopback üzerinde açılır. HTTPS (5. aşama) yapılandırılmadan
LISTEN_ADDRESS değerini 0.0.0.0 yapmayın veya internete yayınlamayın: parolalar düz HTTP ile gider.
Windows'ta Docker Desktop Linux container ortamı ve WSL2 içinden aynı komut kullanılabilir.

## İzleme
```sh
docker compose --profile observability up -d --build
```
Grafana: http://127.0.0.1:3001; kullanıcı admin, parola .env içindeki GRAFANA_PASSWORD.
Prometheus: http://127.0.0.1:9090. Veri kaynakları otomatik tanımlanır.
API ve worker JSON log üretir. OTel Collector OTLP log kabul eder; uygulama loglarının
Loki'ye otomatik gönderimi ve dağıtık tracing henüz bağlı değildir. Alarm kuralları başlangıç
olarak sağlanır; bildirim kanalı ve Alertmanager sonraki aşamadır.

## Veri ve işlemler
```sh
docker compose logs -f --tail=100 api worker
docker compose down
```
`down` verileri korur. `down -v` veritabanı dahil kalıcı verileri siler.
Şema değişiklikleri `apps/api/migrations` altındaki sürümlü SQL dosyalarıyla, her `up` sırasında
`migrate` servisi tarafından uygulanır. Otomatik güncelleme henüz yoktur.

## Dağıtım
Kaynak kurulum compose.yaml ile yerelde derlenir. v* etiketi GitHub Actions ile GHCR'ye
üç uygulama imajı (web, api, worker) yayımlar.
GHCR imajlarını kullanan sürümlü üretim Compose paketi ve güncelleyici henüz yoktur.

Detaylar: docs/architecture.md, docs/roadmap.md, CONTRIBUTING.md, SECURITY.md.
Lisans: Apache-2.0.
