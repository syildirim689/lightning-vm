# Lightning VM

Açık kaynak VMware sunucu yönetim platformunun başlangıç deposu.

**Durum: geliştirme iskeleti. Üretime ve müşteri kullanımına hazır değildir.**

## Çalışan bileşenler
- Next.js (TypeScript) yönetim ve müşteri paneli: HeroUI bileşenleri, koyu/açık tema, mobil uyumlu
  yan menü, grafikli genel bakış; Türkçe/İngilizce (docs/i18n.md).
- Kimlik doğrulama better-auth ile: e-posta/parola, passkey (WebAuthn), oturum listesi ve kapatma,
  SMTP tanımlıysa e-postayla parola sıfırlama, isteğe bağlı Cloudflare Turnstile, `admin`/`user`
  rolleri, CSRF ve hız sınırı, denetim kayıtları (docs/auth.md).
- NestJS/Fastify API: canlılık, PostgreSQL/Redis hazır olma kontrolü, yönetici sistem durumu ve Prometheus metrikleri.
  `/metrics` yalnızca iç ağdan erişilir; Caddy üzerinden `/api/metrics` 404 döner.
- BullMQ worker: Redis bağlantısı, PostgreSQL heartbeat ve bilinmeyen işleri reddetme.
- PostgreSQL sürümlü migration'lar (`migrate` servisi); Redis AOF; Caddy ters proxy.
- İsteğe bağlı Prometheus, Grafana, Loki ve OpenTelemetry Collector.
- GitHub Actions derleme kontrolü ve sürüm etiketinden GHCR imaj yayını.

- Kurulum: tek komut; Docker, HTTPS (alan adı veya `<ip>.sslip.io`), izleme, ilk yönetici ve yedek
  zamanlayıcısını kurup sonucu özetler. İsteğe bağlı tarayıcı sihirbazı (docs/setup.md).
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
- İşletim: şifreli yedek ve kontrollü geri yükleme, git etiketleriyle güvenli güncelleme (yedek,
  migration uyumluluğu, iş boşaltma, geri dönüş), zamanlanmış bakım; Prometheus/Alertmanager alarmları,
  Grafana panosu ve Loki'ye log aktarımı (docs/operations.md).

## Henüz uygulanmayanlar
- Sihirbazda kaynak havuzu adımı (havuzlar Yönetim → Katalog'dan oluşturulur).
- TOTP ile iki adımlı doğrulama, e-posta doğrulama.
- Standalone ESXi üzerinde oluşturma, yeniden kurulum, snapshot, müşteri VM metrikleri, IPv6.
- Faturalama; GHCR imajlarıyla sürümlü kurulum paketi; dağıtık iz (tracing).

Paneldeki kapalı düğmeler bu işlevleri gerçekleştirmez.

## Boş bir sunucuda deneme
Desteklenen sistemler: Ubuntu 22.04, 24.04 veya 26.04 (amd64/arm64). En az 2 GB RAM ve 10 GB boş disk gerekir.

**1. Kaynağı alın.** Depo adresi bu belgede bilerek yazılmamıştır; kendi GitHub adresinizi kullanın:
```sh
git clone <DEPO_ADRESİ> lightning-vm
```
```sh
cd lightning-vm
```

**2. Kurun.** Root olarak çalıştırın; gerisini betik yapar:
```sh
sudo sh scripts/install.sh
```
Docker yoksa resmî deposundan kurulur. Sunucunun genel bir IPv4 adresi varsa panel
`https://<ip-tireli>.sslip.io` adresinde Let's Encrypt sertifikasıyla açılır. Kendi alan adınız için
`--domain panel.example.com` ekleyin (A kaydı sunucuyu göstermeli, 80/443 açık olmalı). Betik
sonunda panel adresini, yönetici e-postasını ve parolasını yazar; parola
`secrets/initial-admin.txt` dosyasında da bulunur. İlk girişten sonra parolayı değiştirip
dosyayı silin.

Yalnızca kontrol etmek için (hiçbir şeyi değiştirmez): `sh scripts/install.sh check`.
Diğer seçenekler (`--local`, `--admin-email`, `--setup-wizard`, `--no-monitoring`,
`--no-schedule`) docs/setup.md dosyasında.

**3. Genel IP yoksa (`--local`):** panel yalnızca sunucuda açılır. Kendi bilgisayarınızdan
SSH tüneliyle bağlanın:
```sh
ssh -L 8080:127.0.0.1:8080 KULLANICI@SUNUCU
```
Ardından http://127.0.0.1:8080 adresini açın.

Kurulum yarıda kalırsa aynı komutu tekrar çalıştırın. Mevcut sırlar, veriler ve yönetici hesabı
korunur.

**4. (İsteğe bağlı) Alan adını sonradan değiştirmek.** Alan adınızın A kaydı sunucuyu göstermeli ve 80/443
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

## Yedekleme, güncelleme ve izleme
```sh
sudo sh scripts/install.sh backup
```
```sh
sudo sh scripts/install.sh restore backups/DOSYA.tar.enc --yes-replace-data
```
```sh
sudo sh scripts/install.sh update
```
```sh
sudo sh scripts/install.sh schedule on
```
- **Yedek:** veritabanı, `.env`, şifreleme anahtarları ve sertifikalar `secrets/backup.key` ile
  şifrelenir. Bu anahtarı sunucu dışında saklayın.
- **Geri yükleme:** onay bayrağı olmadan yalnızca kontrol eder; onaylı çalıştırmada önce mevcut
  verinin yedeğini alır.
- **Güncelleme:** git etiketlerini izler. Önce yedek alır, migration uyumluluğunu kontrol eder ve
  worker'ı boşaltır. Başarısız olursa container'ları geri alır. Veritabanı otomatik geri alınmaz.
- **Zamanlayıcı:** `schedule on` günlük yedek kurar. Otomatik güncellemeyi `auto-update on` ile
  açarsınız (bakım penceresi ve kanal seçilir).
- **İzleme:** Prometheus, Alertmanager, Grafana panosu, Loki'ye log aktarımı, host metrikleri ve dış
  erişim probe'u:
  ```sh
  sudo docker compose --profile observability up -d
  ```

Ayrıntılar: docs/operations.md.

```sh
docker compose logs -f --tail=100 api worker
```
`down` verileri korur. `down -v` veritabanı dahil kalıcı verileri siler. Şema değişiklikleri
`apps/api/migrations` altındaki sürümlü SQL dosyalarıyla, her `up` sırasında `migrate` servisi
tarafından uygulanır.

## Dağıtım
Kaynak kurulum compose.yaml ile yerelde derlenir. v* etiketi GitHub Actions ile GHCR'ye
imajları yayımlar. GHCR imajlarını kullanan sürümlü üretim paketi henüz yoktur; güncelleme kaynak
checkout'u ile çalışır.

Detaylar: docs/setup.md, docs/operations.md, docs/catalog.md, docs/vmware.md, docs/console.md, docs/domain-https.md, docs/auth.md, docs/i18n.md, docs/architecture.md, docs/roadmap.md, docs/validation.md, CONTRIBUTING.md, SECURITY.md.
Lisans: Apache-2.0.
