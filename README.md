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

- Kurulum: `scripts/install.sh` (`install`, `check`, `recover-setup` modları; ön kontroller;
  iki dilli hata kodları) ve tarayıcıda 11 adımlı kurulum sihirbazı (docs/setup.md).

## Henüz uygulanmayanlar
- Sihirbazda alan adı/HTTPS, VMware ve kaynak havuzu adımları (şimdilik yalnızca atlanabilir).
- MFA, parola sıfırlama, proje/müşteri modeli.
- VMware bağlantısı, VM işlemleri, konsol geçidi, IP tahsisi.
- Faturalama, yedekleme otomasyonu, otomatik güncelleme.

Paneldeki kapalı düğmeler bu işlevleri gerçekleştirmez.

## Boş bir sunucuda deneme
Desteklenen sistemler: Ubuntu 22.04 veya 24.04 (amd64/arm64). En az 2 GB RAM ve 10 GB boş disk gerekir.

**1. Kaynağı alın.** Depo adresi bu belgede bilerek yazılmamıştır; kendi GitHub adresinizi kullanın:
```sh
git clone <DEPO_ADRESİ> lightning-vm
```
```sh
cd lightning-vm
```

**2. Sunucuyu kontrol edin.** Bu komut hiçbir şeyi değiştirmez:
```sh
sh scripts/install.sh check
```

**3. Kurun.** Docker yoksa `--install-docker` ekleyin; Docker resmî deposundan kurulur ve
bunun için root gerekir:
```sh
sudo sh scripts/install.sh --install-docker
```
Betik sonunda **1 saat geçerli bir kurulum anahtarı** yazar. Anahtarın süresi dolduysa:
```sh
sudo docker compose exec api node dist/cli.js bootstrap-token
```

**4. Panele kendi bilgisayarınızdan bağlanın (SSH tüneli):**
```sh
ssh -L 8080:127.0.0.1:8080 KULLANICI@SUNUCU
```
Ardından http://127.0.0.1:8080/setup adresini açın, anahtarı girin ve sihirbazı tamamlayın.

Kurulum yarıda kalırsa aynı `install` komutunu tekrar çalıştırın. Mevcut sırlar, veriler ve
yönetici hesabı korunur.

Varsayılan port yalnızca loopback üzerinde açılır. HTTPS (5. aşama) yapılandırılmadan
`LISTEN_ADDRESS` değerini `0.0.0.0` yapmayın ve paneli internete açmayın: parolalar düz HTTP ile gider.

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

Detaylar: docs/setup.md, docs/auth.md, docs/i18n.md, docs/architecture.md, docs/roadmap.md, docs/validation.md, CONTRIBUTING.md, SECURITY.md.
Lisans: Apache-2.0.
