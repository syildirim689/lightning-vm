# Doğrulama kayıtları

## Geliştirme makinesi — 2026-10-23
Windows Server 2025, Node 24.21, npm 11.19 (Docker yok).
- `npm ci` (api, web, worker): lock dosyalarıyla tutarlı.
- API `npm test`: 3/3 geçti — bağımlılık yokken `/health` 200; PostgreSQL ve Redis
  erişilemezken `/ready` 503; PostgreSQL erişilemezken `/system` 503.
- Web `npm run build` (Next.js 16.4.3, TypeScript strict): başarılı.
- Worker `npm run check`: başarılı.
- `npm audit --omit=dev`: üç uygulamada 0 açık. API'de Nest'in getirdiği eski fastify
  `overrides` ile 5.12.7'ye sabitlendi.

## 4. aşama: kurulum betiği ve sihirbaz — 2026-10-23
Geliştirme makinesi:
- API `npm test` 7/7; web `npm test` (176 anahtar; API kontrol sonuç kodları da taranıyor);
  `npm run build` geçti.

Docker test sunucusu (Ubuntu 24.04 arm64):
- `shellcheck -s sh scripts/install.sh`: temiz.
- `install.sh check` (boş sunucu): tüm ön kontroller OK, "kurulum yok", çıkış 0.
  İlk denemede `.env` olmadığında betiğin sessizce çıktığı bulundu ve düzeltildi
  (`set -e` altında `[ -f .env ] &&`).
- Port çakışması: 8080'de başka bir süreç dinlerken `install` `E_PORT_IN_USE` ile durdu;
  `.env` oluşturulmadı.
- Boş veriyle `install --lang tr`: çıkış 0, kurulum anahtarı yazıldı, `.env` 600.
- Kurulum sonrası `check`: kendi proxy'miz port çakışması sayılmadı; READY ve kurulum durumu doğru.
- Yarıda kalan kurulum: api, web ve proxy container'ları silindi, `install` tekrar çalıştırıldı.
  Çıkış 0, `.env` aynı (sha256), kullanıcı sayısı aynı, yeni anahtar üretilmedi.
- `update`: `E_NOT_IMPLEMENTED`, çıkış 20.
- `recover-setup`: sihirbaz yeniden açıldı, denetim kaydı `setup.reopened`.
- Geçersiz argüman: çıkış 2.
- API entegrasyon testleri 18/18 geçti (auth 11 + sihirbaz 7). Kapsam:
  - anahtar kapısı;
  - sunucu tarafı adım doğrulaması;
  - worker sinyali yokken `CHECKS_FAILED`;
  - erişim testinin `DNS_FAILED`, `CONNECTION_REFUSED`, `WRONG_TARGET`,
    `LOOPBACK_NOT_VERIFIABLE` ve gerçek bir HTTP sunucusu üzerinden `OK` sonuçlarını ayırması;
  - yönetici oluşunca anahtar çerezinin geçersizleşmesi;
  - eksik adımla tamamlamanın reddi;
  - tamamlanınca tüm uç noktaların kapanması;
  - kurtarma.

  Testte port 1 kullanılınca `fetch`'in kendi engelli port listesi devreye girdi; test yeni
  boşaltılmış bir porta çevrildi.
- Playwright (SSH tüneli, gerçek kurulum): 11/11 geçti. Kapsam:
  - sihirbazın 11 adımının Türkçe yürütülmesi ve yanlış anahtarın reddi;
  - ön kontrollerin gerçek sonuçları;
  - sayfa yenilenince kalınan adımdan devam edilmesi;
  - geçersiz adresin sunucuda reddi ve yerel adres uyarısı;
  - atlanan VMware/HTTPS uyarıları;
  - tamamlanınca `/setup` yönlendirmesi ve API'nin `SETUP_CLOSED` dönmesi.

Doğrulanmayanlar:
- 22.04 üzerinde çalışma.
- amd64 üzerinde çalışma.
- `--install-docker` yolu (sunucuda Docker zaten kuruluydu).
- Gerçek bir alan adıyla erişim testi.
- İzleme adımının gerçek Prometheus/Grafana/Loki testi (E2E'de atlandı).

## 3. aşama: kimlik doğrulama, roller, güvenli bootstrap — 2026-10-23
Geliştirme makinesi:
- API `npm test`: 7/7 geçti. Kapsam: CSRF başlığı yok veya Origin farklıysa 403; geçersiz girişte
  alan kodları; oturumsuz yönetici isteğinde 401; hata kodları.
- Web: `npm test` geçti (83 anahtar). Kontrol artık API'deki alan hata kodlarını da tarıyor;
  çevirisiz bırakılan iki kodu yakaladığı denendi. `npm run build` geçti.
- `npm audit --omit=dev`: api ve web için 0.

Docker test sunucusu (gerçek PostgreSQL 17 + Redis 7):
- `npm run test:integration` 11/11 geçti. Kapsam:
  - migration'lar ikinci çalıştırmada hiçbir şey yapmıyor;
  - yanlış ya da süresi dolmuş kurulum anahtarı reddediliyor;
  - aynı anda gelen 5 kurulum isteğinden tam 1 yönetici oluşuyor, sonra kurulum kapanıyor;
  - yanlış parola ile bilinmeyen e-posta aynı yanıtı alıyor;
  - cookie bayrakları doğru; HTTPS proxy arkasında `Secure` ekleniyor;
  - kayıt kapalı/açık durumları ve aynı e-postayla kayıt reddi;
  - kullanıcının yönetici API'lerine erişimi 403 ve ret denetim kaydına yazılıyor;
  - çıkış oturumu iptal ediyor; süresi dolan oturum ve devre dışı kullanıcı reddediliyor;
  - 11. hatalı girişte 429.
- Boş veriyle `install.sh`:
  - `migrate` servisi 0 çıkış koduyla bitti; api, worker ve web sağlıklı;
  - betik kurulum anahtarını yazdı.
- Playwright (SSH tüneliyle Caddy arkasındaki gerçek kurulum): 11/11 geçti. Kapsam:
  - kurulum anahtarı akışı ve kurulumun kapanması;
  - sunucu tarafı doğrulama mesajlarının çevrilmesi;
  - yönetici paneli ve kayıt ayarı;
  - kayıtlı kullanıcının yönetici sayfası ve API'sinde 403 alması;
  - çıkış;
  - dil seçimi ve kalıcılığı;
  - API hata kodu ve ağ hatası çevirisi;
  - konsol hatası olmaması.
- `install.sh` ikinci kez çalıştırıldı: "Yönetici hesabı zaten var", yeni anahtar üretilmedi.
  Veritabanında 1 admin + 1 user var; denetim kayıtları test akışıyla eşleşiyor.

## 2. aşama: Türkçe/İngilizce — 2026-10-23
Geliştirme makinesi:
- API `npm test`: 4/4 geçti. Yeni test: bilinmeyen yol `{code: 'NOT_FOUND'}` dönüyor;
  `/ready` 503 cevabı `DEPENDENCY_UNAVAILABLE` kodunu taşıyor.
- Web `npm test` (çeviri kontrolü): 45 anahtar, tr/en eşit.
  Bozuk bir kopyayla denendi: eksik anahtar, farklı değişken ve eksik hata kodu yakalandı.
- Web `npm run build`: başarılı. Kodda olmayan bir anahtar kullanılınca TypeScript hatası verdiği denendi.
- Playwright (Chromium, `next start`): 8/8 geçti.

Docker test sunucusu (Compose + Caddy, gerçek API):
- `Accept-Language: tr` → Türkçe; `en-US` → İngilizce.
- `NEXT_LOCALE=en` cookie'si Türkçe tarayıcıda İngilizce gösteriyor.
- Geçersiz cookie değeri yok sayılıyor.
- `/api/nope` → `{"code":"NOT_FOUND",...}`; Redis durdurulunca `/api/ready` → `DEPENDENCY_UNAVAILABLE`.
- Aynı Playwright paketi SSH tüneliyle Caddy arkasındaki standalone imaja karşı çalıştırıldı:
  8/8 geçti (`E2E_BASE_URL`).

Bulunan ve düzeltilen hata: kök `.dockerignore` web build context'i (`apps/web`) için
geçerli değildi. Yerel `node_modules` ve `.next` imaja kopyalanabiliyordu.
`apps/web/.dockerignore` eklendi.

## Docker test sunucusu — 2026-10-23
Ubuntu 24.04.5 LTS, aarch64, 8 vCPU, 15 GiB RAM. Docker Engine 29.9.2,
Compose v5.6.1 (resmî Docker apt deposundan kuruldu).

Gerçekten çalıştırılanlar:
- Boş veriyle `sh scripts/install.sh`: başarılı; tüm servisler healthy.
- `/api/ready` 200, `/admin` 200, `/api/metrics` dışarıdan 404, iç ağdan `api:4000/metrics` 200.
- `/api/system`: worker heartbeat'i `healthy: true`.
- İkinci `install.sh` çalıştırması: `.env` değişmedi (sha256 aynı), izin 600.
- Redis durdurulunca `/api/ready` 503; PostgreSQL durdurulunca `/api/ready` ve
  `/api/system` 503; servisler geri gelince `/api/ready` 200.
- `operations` kuyruğuna eklenen iş worker tarafından reddedildi (failed sayısı 1, log `operation_failed`).
- api+worker `stop` süresi 1 sn (SIGTERM ile düzgün kapanış).
- `--profile observability`: Prometheus API'yi kazıyor (`up=1`), `LightningApiUnavailable`
  kuralı yüklü, Grafana sağlıklı, OTLP HTTP ile gönderilen test logu Loki'de sorgulandı.

Bu testlerde bulunan ve düzeltilen hatalar:
- Worker hiç çalışmıyordu: BullMQ 6 `ioredis`'i isteğe bağlı yaptı; ESM'de hazır istemci
  verilmesi gerekiyor. `ioredis` eklendi ve istemci BullMQ'ya verildi.
- Heartbeat hep başarısızdı: `worker.client` BullMQ 6'da yok; Redis doğrudan ping'leniyor.
- `/system` PostgreSQL kesintisinde 500 dönüyordu; artık 503.

Doğrulanmayanlar:
- API ve worker logları henüz Loki'ye gönderilmiyor (Collector → Loki hattı çalışıyor).
- Alarm bildirimi (Alertmanager) yok.
- GitHub Actions iş akışları henüz GitHub üzerinde çalışmadı.
- amd64 imajları yalnızca CI'da derlenecek; sunucu testleri arm64'te yapıldı.
- VMware ve konsol henüz uygulanmadığı için gerçek ESXi/vCenter testi yapılmadı.
