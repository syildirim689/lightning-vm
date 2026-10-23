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

## 8. aşama: kaynak havuzları, paketler, kotalar — 2026-10-24
Envanter simüle vCenter'dan geldi; kapasite rakamları simülasyondur.

- API birim testleri 14/14 geçti. 5 yeni test kapasite katmanlarını, kuralları ve kotaları kapsıyor:
  - fiziksel, pay, satışa açılan, kullanılan ve kalan değerlerin elle hesaplanan beklenen değerlere
    eşit olması;
  - CPU, RAM ve depolama oranlarının birbirinden ayrı uygulanması;
  - şablonların kullanımda sayılmaması;
  - thin disklerde "yazılmış" ve "tahsis edilmiş" değerlerin ayrılması;
  - eksiye düşmeme;
  - düşük boş alan ve fazla tahsis uyarıları;
  - özel kaynakta aralık, adım ve vCPU başına RAM oranı;
  - kotada sınırsız (`null`) değer.
- API entegrasyon testleri 37/37 geçti. 8 yeni katalog testi:
  - envanterde olmayan kaynakların reddi ve kapasite katmanları;
  - kuralın bir bütün olarak doğrulanması;
  - imajın şablon olmasının zorunlu tutulması;
  - paket tutarının ondalık metin olarak saklanması;
  - IP havuzu: alt ağ dışı ve geçersiz adres reddi; aynı anda 3 çakışan istekten yalnızca 1'inin
    kaydedilmesi; hariç tutulan adresin sayıdan düşülmesi;
  - kullanımdaki havuz ve bağlantının silinememesi (`IN_USE`);
  - yönetici dışına 403;
  - proje sahipliği;
  - teklif: adım hatası, oran hatası, imaj minimum diski, tam fiyat (34,00), kullanıcı kotası,
    diğer kullanıcının varsayılan kotada kalması, müşteriye altyapı ayrıntısı verilmemesi.
- **Bulunan hata:** havuzu olan bir bağlantıyı silmek 500 dönecekti; artık `409 IN_USE`.
- Playwright 13/13 geçti (`https://49-12-109-190.sslip.io`):
  - yönetici havuz oluşturdu ve kapasite katmanlarını gördü, özel kural ekledi;
  - hatalı tutarla paket reddedildi;
  - Türkçe müşteri paket fiyatını `€12,10`, özel yapılandırmayı `€22,00` olarak gördü;
  - adım hatası Türkçe gösterildi; "ayrılmış CPU garantisi değildir" notu görünüyor;
  - sunucu oluşturmanın henüz olmadığı yazıyor.

Doğrulanmayanlar:
- Gerçek altyapıda kapasite rakamları.
- Rezerve kapasite ve kota kullanımı (9. aşamaya kadar 0).
- IPv6.
- Faturalama.

## 7. aşama: tarayıcı konsolu — 2026-10-24
**Gerçek ESXi, vCenter veya VMware HTML Console SDK kullanılmadı.** VMware tarafı, teste özel
simülatördeki sahte bir WebMKS ucudur: bilet verir, TLS WebSocket üzerinden selam verir ve gelen
veriyi geri yollar. Bu sonuçlar zinciri doğrular; VMware konsol protokolünü veya ekranı doğrulamaz.

- Go konsol geçidi testleri 6/6 geçti; 5 kez tekrar çalıştırıldı:
  - başka origin'den veya origin'siz bağlantı yükseltilmeden önce `403` alıyor;
  - bilinmeyen oturum `4401`;
  - aktarım (metin ve binary) ve oturumun ikinci kez kullanılamaması;
  - yanlış parmak izinde `4503`;
  - loopback hedef engelli;
  - kullanıcı başına sınır `4429`;
  - iptalde `4403`;
  - denetim olayları üretiliyor.
- Adaptör (`go vet`, `go test`): önceki 7 test geçiyor; konsol bileti uç noktası eklendi.
- API entegrasyon testleri 29/29 geçti; gerçek geçit, test worker'ı ve simülatör kullanıldı.
  Konsol testi şunları doğruladı:
  - yanıtta bilet veya `wss` adresi yok;
  - çerez `Max-Age=60; Path=/console/ws; HttpOnly; SameSite=Strict`;
  - Redis anahtarı token'ın kendisi değil özeti;
  - geçit üzerinden simüle VM'den selam alındı;
  - ikinci kullanım `4401`;
  - çıkış yapınca açık konsol `4403 CONSOLE_REVOKED` ile kapandı;
  - normal kullanıcı `403`, bilinmeyen VM `VM_NOT_FOUND`;
  - worker `console.opened`, `console.denied` ve `console.closed` olaylarını denetim kaydına yazdı.
- Bu testlerin bulduğu ve düzeltilen iki worker hatası:
  1. Yazılamayan konsol olayları yeniden denenmiyordu.
  2. Redis olay akışı veya tüketici grubu silindiğinde yeniden oluşturulmuyordu.
- Playwright 12/12 geçti; `https://49-12-109-190.sslip.io` üzerinden, gerçek Let's Encrypt
  sertifikası ve Caddy ile:
  - yönetici VM listesinden konsolu açtı; sayfa SDK'nın olmadığını ve işletim sistemi girişinin
    atlanmadığını gösterdi;
  - "Geçit bağlantısını test et" düğmesiyle tarayıcıdan `wss` → Caddy → geçit → simüle uç zinciri
    başarılı oldu;
  - çerez bayrakları doğru ve URL'de değil.
- Proxy, geçit, adaptör, API, web ve worker loglarında `/ticket/` ve çerez değeri sayısı 0.

Doğrulanmayanlar:
- Gerçek WebMKS ve gerçek SDK ile ekran, klavye ve fare.
- ESXi/vCenter'ın bilet biçimi (host, port, parmak izi türleri).
- Müşteri konsolu (sunucu sahipliği 9. aşamada).
- Birden fazla geçit örneği.
- Nginx/Cloudflare arkasında WebSocket.

## 6. aşama: ESXi/vCenter bağlantısı ve envanter — 2026-10-24
**Gerçek bir ESXi veya vCenter kullanılmadı.** Bütün VMware testleri govmomi v0.56.1'in simülatörüne
karşı yapıldı. Bunlar adaptörün ve API'nin mantığını kanıtlar, gerçek donanım davranışını değil.
Gerçek ortam kabul listesi: docs/vmware.md.

Geliştirme makinesi:
- API birim testleri 9/9 geçti (yeni: şifrelemede AES-GCM gidiş-dönüş, başka satıra taşınan ve
  bozulan şifreli metnin reddi).
- Web çeviri kontrolü: 339 anahtar. Kontrol artık Go adaptörünün hata kodlarını ve ICU tırnak
  hatasını da yakalıyor. `npm run build` geçti.

Test sunucusu (Go 1.27.3; resmî `vmware/vcsim` imajı yalnızca amd64 olduğu için simülatör
govmomi'nin simulator paketinden derlendi):
- `go vet` ve `gofmt` temiz. `go test` 7/7 geçti:
  - kendinden imzalı sertifikanın reddi ve parmak izinin gösterilmesi;
  - sabitlenmiş sertifika ve uyuşmazlık;
  - loopback ve metadata adresinin engellenmesi;
  - hatalı giriş;
  - ESXi ve vCenter ayrımı (3 host, 1 küme, farklı donanım UUID'leri);
  - servis token'ı.
- **Bulunan güvenlik hatası:** govmomi'nin kendi `DialTLSContext` fonksiyonu adres engelini
  atlıyordu; loopback'e bağlanılabiliyordu. Düzeltildi ve test bunu kanıtlıyor.
- Kurulum betiği `secrets/master.key` ve `secrets/vmware.token` dosyalarını oluşturdu (uid 1000, 400).
  `vmware` container'ı sağlıklı.
- API entegrasyon testleri 28/28 geçti. VMware için 9 yeni test, Go adaptörü ve iki simülatör
  üzerinden çalıştı:
  - güvenilmeyen sertifika reddedilip PEM ve parmak iziyle gösteriliyor;
  - sunucu tarafı doğrulama;
  - `INVALID_LOGIN`, `TLS_PIN_MISMATCH` ve `ENDPOINT_BLOCKED` (`postgres`, `169.254.169.254`,
    `127.0.0.1`) ayrı kodlar;
  - vCenter ve ESXi ayrımı;
  - parola `v1:` biçiminde şifreli ve hiçbir yanıtta yok;
  - envanter ve fiziksel kapasite;
  - aynı vCenter'ın IP ile tekrar eklenemesi (`CONNECTION_EXISTS`);
  - aynı hostun iki bağlantıda sayılmaması (`HOSTS_ALREADY_MANAGED`; yarım kayıt kalmıyor);
  - yenileme hatasının bağlantıya kaydedilmesi;
  - normal kullanıcıya 403;
  - denetim kayıtları.
- `vmware` container logunda parola geçmiyor.
- Playwright, `https://49-12-109-190.sslip.io` üzerinden 12/12 geçti:
  - sihirbazda simüle vCenter'ın sertifikası önce reddedilip gösterildi, sonra açıkça sabitlenerek
    bağlantı kuruldu; keşif adımı 2 host gösterdi; özet ekranında VMware uyarısı yok;
  - yönetim sayfasında kapasite, işlemler, yenileme ve adı yazarak onaylanan kaldırma.

E2E'nin bulduğu ve düzeltilen hatalar:
- Arayüz, hata yanıtındaki sertifika ve çakışma bilgisini atıyordu (`apiFetch`).
- `'{name}'` biçimindeki çeviriler ICU kaçışı yüzünden ad yerine `{name}` metnini gösteriyordu.

Doğrulanmayanlar:
- Gerçek ESXi 7/8 ve vCenter 7/8.
- Ücretsiz lisansın gerçek davranışı (`writeApi` tespiti yalnızca lisans adına dayalı bir çıkarım).
- Gerçek yetki kısıtlı hesaplar.
- Büyük envanterde performans.
- amd64 simülatör imajı.
- GitHub Actions'ta Go işi.

## 5. aşama: alan adı, reverse proxy ve HTTPS — 2026-10-23
Test sunucusu: Ubuntu 24.04 arm64, genel IP 49.12.109.190. Gerçek bir alan adı verilmediği için
herkese açık sslip.io servisi kullanıldı: `49-12-109-190.sslip.io` → 49.12.109.190.

- `shellcheck`: temiz. Yerelde API birim testi 7/7; web çeviri kontrolü (201 anahtar) ve build geçti.
- API entegrasyon testleri 19/19 geçti. Yeni testler:
  - geçersiz alan adı biçimleri `INVALID_DOMAIN` alıyor;
  - çözülmeyen ad yalnızca `DNS_FAILED` döndürüyor ve HTTP/TLS denenmiyor;
  - başarısız kontrolle adım kaydedilemiyor; adım atlanabiliyor.
- `install.sh domain ... --acme-staging`:
  - 80/443 boş, DNS bu sunucuyu gösteriyor;
  - HTTP 308 ile HTTPS'e yönlendiriyor;
  - sertifika "Let's Encrypt staging" olarak ayrı raporlandı (`W_CERT_STAGING`).
  - Sunucu dışından (geliştirme makinesi): doğrulamasız HTTPS 200, doğrulamalı HTTPS beklendiği
    gibi başarısız, HTTP → 308.
- `install.sh domain ...` (gerçek sertifika, tek deneme):
  - sertifikayı Let's Encrypt YE2 verdi, bitiş tarihi 21 Ocak 2027;
  - sunucu dışından doğrulamalı HTTPS 200.
- Playwright, doğrudan `https://49-12-109-190.sslip.io` üzerinden (tünel yok, rastgele yönetici
  parolası) 11/11 geçti. Sihirbazda:
  - erişim adresi testi `OK`;
  - alan adı adımında DNS `OK`, HTTP "HTTPS'e yönlendiriyor", sertifika `OK`; adım tamamlandı;
  - özet ekranında HTTPS ve erişim uyarıları yok.
- Gerçek HTTPS üzerinden kayıt:
  - çerez `HttpOnly; Secure; SameSite=Lax`;
  - `X-Frame-Options: DENY` var, `Server` başlığı yok;
  - istemcinin gönderdiği sahte `X-Forwarded-For: 6.6.6.6` yok sayıldı; denetim kaydına gerçek
    istemci IP'si yazıldı.
- `install.sh behind-proxy`:
  - `TRUSTED_PROXY_CIDRS` otomatik olarak Docker ağ geçidi (172.18.0.1/32) bulundu.
  - Sunucuda 80. porta konan test Nginx'i (`X-Forwarded-Proto: https`) üzerinden: çerez `Secure`
    aldı, gerçek IP kaydedildi, sahte XFF yok sayıldı.
  - Güvenilmeyen bir container'dan Caddy'ye doğrudan sahte `X-Forwarded-For`/`Proto`
    gönderildiğinde: çerez `Secure` almadı, IP olarak container'ın kendi adresi kaydedildi.
- Alan adı moduna geri dönüş: sertifika `caddy_data` biriminden yeniden kullanıldı, yeni sertifika
  istenmedi. `install.sh check` DNS, HTTP ve sertifikayı ayrı ayrı `OK` gösterdi.

Doğrulanmayanlar:
- Gerçek bir kullanıcı alan adı.
- NAT arkası kurulum ve port yönlendirme.
- Çalışan IPv6 (sunucuda genel IPv6 yok).
- Cloudflare proxy modu.
- Traefik ve harici Caddy (yalnızca Nginx test edildi).
- WebSocket: konsol geçidi henüz yok. Nginx örneğinde Upgrade başlıkları belgelendi ama denenmedi.
- Sertifika yenilemesi (süre dolmadan gözlemlenemez).

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
