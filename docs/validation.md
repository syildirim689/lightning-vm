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
