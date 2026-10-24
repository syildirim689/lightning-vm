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
- Erişim modları: yalnızca yerel (SSH tüneli), alan adıyla Caddy otomatik HTTPS (Let's Encrypt,
  staging seçeneğiyle) veya mevcut bir Nginx/Caddy/Traefik arkasında güvenilen proxy sınırıyla
  (docs/domain-https.md).
- ESXi ve vCenter bağlantısı (yalnızca okuma): ürün, lisans, yetki ve desteklenen işlem keşfi;
  host, datastore, ağ/VLAN, küme ve VM envanteri; fiziksel kapasite. TLS sistem CA, özel CA veya
  sabitlenmiş parmak iziyle doğrulanır. Parolalar ayrı anahtarla şifrelenir. Aynı host iki kez
  sayılmaz (docs/vmware.md). Gerçek ESXi/vCenter ile değil, govmomi simülatörüyle test edildi.
- Yönetici tarayıcı konsolu: ayrı WebSocket geçidi, tek kullanımlık HttpOnly çerez (bilet
  tarayıcıya gitmez), Origin kontrolü, sınırlar, çıkışta ve yönetici kararıyla iptal, denetim
  kaydı (docs/console.md). VMware HTML Console SDK lisansı nedeniyle dahil değildir; kurulumu
  yapan kişi ekler. Ekran gerçek SDK ve gerçek ESXi ile henüz denenmedi.
- Katalog: kaynak havuzları (fiziksel / pay / satışa açılan / rezerve / kullanılan kapasite ayrı;
  CPU, RAM ve depolama fazla tahsisi ayrı; thin disk farkı), özel kaynak kuralları, paketler,
  imajlar, IPv4 IP havuzları, kotalar, projeler ve fiyat teklifi (docs/catalog.md).
- Sunucu oluşturma (yalnızca vCenter, şablondan kopyalama + cloud-init), güç işlemleri, silme,
  IP ataması, kapasite rezervasyonu ve kota; Idempotency-Key, kaldığı adımdan devam eden worker,
  kurtarma taraması ve yalnızca raporlayan uzlaştırma. Müşteri kendi sunucusunun konsolunu açabilir
  (docs/provisioning.md). Gerçek vCenter ile değil, govmomi simülatörüyle test edildi.

## Henüz uygulanmayanlar
- Sihirbazda kaynak havuzu adımı (havuzlar Yönetim → Katalog'dan oluşturulur).
- MFA, parola sıfırlama, proje/müşteri modeli.
- Standalone ESXi üzerinde oluşturma, yeniden kurulum, snapshot, metrikler, IPv6.
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

**5. (İsteğe bağlı) Alan adı ve HTTPS.** Alan adınızın A kaydı sunucuyu göstermeli ve 80/443
portları internetten açık olmalı. Önce test sertifikasıyla deneyin, sonra gerçek sertifikayı alın:
```sh
sudo sh scripts/install.sh domain panel.example.com --acme-staging
```
```sh
sudo sh scripts/install.sh domain panel.example.com
```
Mevcut bir web sunucusunun arkasında çalıştırmak için `behind-proxy` modunu kullanın. Ayrıntılar
docs/domain-https.md dosyasında.

Varsayılan port yalnızca loopback üzerinde açılır. `LISTEN_ADDRESS` değerini elle `0.0.0.0` yapıp
paneli HTTPS'siz internete açmayın: parolalar düz HTTP ile gider.

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

Detaylar: docs/setup.md, docs/catalog.md, docs/vmware.md, docs/console.md, docs/domain-https.md, docs/auth.md, docs/i18n.md, docs/architecture.md, docs/roadmap.md, docs/validation.md, CONTRIBUTING.md, SECURITY.md.
Lisans: Apache-2.0.
