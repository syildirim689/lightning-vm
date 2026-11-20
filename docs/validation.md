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

## 10. aşama: loglama, izleme, yedekleme ve güncelleme — 2026-10-24
Demo sunucuda (Ubuntu 24.04 arm64, Docker Compose) gerçek bileşenlerle denendi. VMware tarafı
yine simülatördür.

- **Yedek (gerçek koşu):**
  - Arşiv alındı ve şifresi çözülerek geri okundu.
  - `BACKUP_KEEP=2` ile 3 yedekten 2'si yerelde kaldı; `BACKUP_COPY_TO` hedefine 3'ü de kopyalandı.
  - Geçmiş dosyası ve panelde "son başarılı yedek" doğru göründü.
- **Geri yükleme (gerçek koşu):**
  - Yedekten sonra bir ayar değiştirildi ve yeni bir tablo eklendi.
  - Onaysız çalıştırma çıkış kodu 3 verdi ve hiçbir şeyi değiştirmedi.
  - Onaylı çalıştırma önce güvenlik yedeği aldı. Ardından ayar ve şema yedek anına döndü, eklenen
    tablo kayboldu, anahtarlar aynı kaldı ve servisler hazır oldu.
  - Alan adı modunda sertifika yedekten geldi ve yeniden istenmedi.
  - Bozuk dosya (`E_RESTORE_CHECKSUM`) ve yanlış anahtar (`E_RESTORE_DECRYPT`) reddedildi.
- **Güncelleme:** sunucudaki ayrı bir git checkout'unda, yalnızca orada oluşturulan test etiketleriyle denendi.
  - `v0.10.0 → v0.10.1`: yedek alındı, worker boşaltıldı, sağlık kontrolü geçti (2 dk 26 sn).
    Aynı komut tekrar çalışınca "güncel" dedi.
  - `v0.10.2` (kasıtlı bozuk migration): migration başarısız oldu, container'lar otomatik olarak
    `v0.10.1`'e döndü, API hazır (200). Geçmişe `rolledBack: true` yazıldı ve geri yükleme komutu
    gösterildi.
  - `--to v0.8.0`: uygulanmış `006_servers` migration'ı o sürümde olmadığı için hiç başlamadan
    reddedildi (`E_UPDATE_INCOMPATIBLE`).
  - Otomatik güncelleme: `schedule on` systemd zamanlayıcısını kurdu. Pencere dışındayken hiçbir
    şey yapmadı. Pencere içinde zamanlayıcı servisi beta kanalından `v0.11.0-rc.1`'e geçti.
    `schedule off` birimleri sildi; geçersiz pencere reddedildi.
- **Ek denemeler:**
  - Açık bir işlem varken otomatik güncelleme ertelendi (`W_UPDATE_BUSY`, sürüm değişmedi).
  - Yedek SSH üzerinden `rsync` ile uzak hedefe kopyalandı; sağlama tuttu.
  - Erişilemeyen hedefte yerel yedek kaldı ve sonuç `E_BACKUP_COPY` olarak kaydedildi.
- **İzleme:**
  - Prometheus hedeflerinin hepsi `up`: api, node, probe, prometheus.
  - Worker yaşam sinyali, bağımlılıklar, yedek yaşı, sürüm, kuyruk, DB bağlantıları, host RAM ve
    probe metrikleri gerçek değer döndürdü.
- **Alarm (gerçek koşu):**
  - Worker durduruldu. `LightningWorkerHeartbeatStale` Prometheus'ta başladı, Alertmanager'a ulaştı
    ve test webhook'una `firing` bildirimi gitti.
  - Worker başlatılınca `resolved` bildirimi geldi.
  - `promtool`: 16 kural geçerli. `amtool`: örnek yapılandırma geçerli.
- **Loglar:**
  - Container logları OTel Collector üzerinden Loki'ye ulaştı (`service_name`, `detected_level`,
    `event`). Servis başına sayımlar alındı.
  - Sahte bir `"password":"…"` ve `token=…` satırı Loki'de `***` olarak göründü; ham değer aranınca
    sonuç çıkmadı.
- **Grafana:** "Lightning VM" panosu (23 panel) otomatik yüklendi. Prometheus ve Loki sorguları
  Grafana üzerinden veri döndürdü.
- **Testler:**
  - API birim 14/14.
  - API entegrasyon 51/51. 2 yeni test: metrik değerleri; rota şablonuyla sınırlı etiket; yedek ve
    güncelleme özetinin yalnızca yöneticiye açık olması; bozuk geçmiş satırının atlanması.
  - Go testleri geçti (gofmt ve go vet temiz).
  - Playwright 14/14 (yönetim sayfasında "son başarılı yedek" kontrolü eklendi).
  - shellcheck temiz.
- **Bulunan ve düzeltilen hatalar:**
  - Güvenlik yedeği, geri yüklemenin çalışma klasörünü siliyordu (paylaşılan sh değişkeni).
  - Yedek, güncellemenin hedef sürüm değişkenini eziyordu.
  - `set --`, yedeğin sebep bilgisini eziyordu.
  - Depo başka bir kullanıcıya aitken `sudo` ile git "dubious ownership" veriyordu; git yalnızca bu
    klasöre güvenecek şekilde çağrılıyor.
  - OTel'deki bir `remove` adımı alan yokken hata veriyordu.
  - Yönetim sayfasındaki ikinci canlı bölge, E2E seçicisini belirsiz yapıyordu.

Doğrulanmayanlar:
- E-posta alıcısı (yalnızca webhook denendi).
- GitHub Actions'ta yeni CI adımları henüz çalışmadı (depoya push yapılmadı).
- GHCR imajlarıyla kurulum, imzalı paket ve tracing yok.

## 9. aşama: otomatik sunucu oluşturma ve uzlaştırma — 2026-10-24
Tüm VMware tarafı govmomi simülatörüdür (vcsim motoru). Bu testler orkestrasyonu, idempotency'yi,
kilitlemeyi, kurtarmayı ve kaynak bırakma kurallarını kanıtlar; gerçek vCenter davranışını kanıtlamaz.

- Go adaptör testleri geçti (gofmt ve go vet temiz). 3 yeni provisioning testi:
  - aynı adla ikinci klon yeni VM üretmez, cloud-init IP'si misafirde görünür;
  - yalnızca `lvm-` adlı VM'ler silinir;
  - standalone ESXi'de oluşturma `PROVISIONING_NOT_SUPPORTED` ile reddedilir.
- API birim testleri 14/14 geçti.
- API entegrasyon testleri 49/49 geçti. Gerçek worker, adaptör ve simüle vCenter kullanıldı.
  12 yeni sunucu testi:
  - Idempotency-Key zorunlu; aynı anahtar aynı sunucuyu döndürür, farklı istek
    `IDEMPOTENCY_MISMATCH` alır;
  - aynı anda verilen siparişler aynı IP'yi alamaz ve havuzu aşamaz;
  - başka müşterinin sunucusu görünmez (404);
  - güç işlemleri sırayla çalışır (aynı anda gelen ikincisi 409);
  - kaybolan yanıttan sonra yeniden deneme ikinci VM oluşturmaz;
  - kuyruktan kaybolan iş PostgreSQL'den kurtarılır;
  - iptal VM'yi siler ve IP'yi bırakır;
  - kalıcı hata (`INVALID_LOGIN`) tek denemede başarısız olur; yönetici yeniden deneyince tamamlanır;
  - kota oluşturmada uygulanır;
  - uzlaştırma dışarıdan silinen VM'yi (`vm_missing`) ve kaydı olmayan VM'yi (`orphan_vm`)
    raporlar, hiçbir şeyi silmez;
  - silmede IP ve rezervasyon, VM'nin yokluğu doğrulandıktan sonra bırakılır.
- Playwright 14/14 geçti (`https://49-12-109-190.sslip.io`). Yeni test Türkçe müşteriyle şunları yapar:
  - SSH anahtarı ekler;
  - hatalı ad (`Web_1`) için Türkçe hatayı görür;
  - sipariş verir, "Hazır · açık" durumunu ve IP'yi görür;
  - metrik boş durumunu görür;
  - onayla zorla kapatır, sonra açar;
  - işlem geçmişini görür;
  - sunucuyu adını yazarak siler.
- **Bulunan ve düzeltilen hatalar:**
  - Oluşturması başarısız olmuş, VM'si olmayan sunucuda güç işlemi kabul ediliyor ve sürekli
    yeniden deneniyordu. Artık API `INVALID_SERVER_STATE` döner. Adaptör `ManagedObjectNotFound`
    hatasını `VM_NOT_FOUND` olarak sınıflar ve bu hata kalıcı sayılır.
  - Sipariş formunda bir React hook'u erken dönüşün altındaydı. Katalog yüklenince form çöküyordu;
    bunu E2E yakaladı.
  - Kurtarma taraması, hâlâ çalışan işleri de "kurtarıldı" diye logluyordu.
  - Panel bandı hâlâ "sunucu oluşturma yok" diyordu.
- **Simülatör sınırları** (yalnızca test aracında telafi edildi):
  - vcsim'de şablon yok; ilk VM kapalı bir şablona çevrildi.
  - vcsim, klonlanan VM'lerde VMware Tools'u hiç başlatmıyor. Test simülatörü, açık VM'lerde
    Tools'u "çalışıyor" gösterir.

Doğrulanmayanlar:
- Gerçek vCenter 7.0 U3+/8 ve gerçek bir Ubuntu cloud-init şablonu (docs/provisioning.md, kabul testleri).
- Gerçek ağda SSH erişimi, DVS port group, datastore'un dolması ve yetkisi kısıtlı servis hesabı.
- Müşterinin kendi sunucusuna konsol: yalnızca API yetki kontrolü test edildi; simülatörde klonların
  konsol bileti yok.
- CI'de `servers.test.mjs` atlanır (worker ve simülatör gerekir). CI'de yaşam döngüsünü compose
  işindeki E2E kapsar.

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

## Otomatik kurulum, HeroUI arayüzü ve better-auth — 2026-10-24
Ubuntu 24.04 arm64 demo sunucusu, genel IPv4 ile.

Gerçekten çalıştırılanlar:
- Boş veriyle `sudo sh scripts/install.sh` (seçeneksiz): yaklaşık 1 dakikada bitti. Erişim
  `49-12-109-190.sslip.io` olarak seçildi, Let's Encrypt sertifikası alındı, izleme açıldı,
  yönetici oluşturuldu, yedek zamanlayıcısı kuruldu ve ilk yedek alındı. Özetteki parolayla
  giriş 200, Grafana 200. İkinci çalıştırma yöneticiyi ve sırları değiştirmedi.
- API entegrasyon testleri (better-auth dahil): 53/53.
- Playwright E2E (`--setup-wizard` kurulumuna karşı, HTTPS): 14/14.
- Ekran kontrolü: koyu/açık tema, 1440 px ve 390 px genişlikte giriş, genel bakış, katalog,
  sunucular, bağlantılar, sistem, sipariş ve hesap sayfaları.
- `npm audit` (api, web): 0; `govulncheck` v1.9.0 (console, vmware): bulgu yok.

Bu testlerde bulunan ve düzeltilen hatalar:
- Kullanıcının sistemi açık temadaysa bile panel koyu açılıyordu; tema artık sistemi izliyor.
- Koşullu ikonlar (sihirbaz kontrolleri, oturum cihaz türü) ikon alt kümesine girmiyordu.
- Koyu temada form alanları ve seçilmemiş radyo düğmeleri kart zemininden ayırt edilmiyordu.
- Açık temada amber bağlantı metninin kontrastı yetersizdi.

Doğrulanmayanlar:
- Passkey'ler gerçek bir doğrulayıcıyla, parola sıfırlama gerçek bir SMTP sunucusuyla,
  Turnstile gerçek anahtarlarla denenmedi.
- Gerçek ESXi/vCenter yerine govmomi simülatörü kullanıldı.

## Akıllı özellikler, ayarlar, roller, bildirimler ve VMware sürüm uyumu — 2026-10-24
Demo sunucusu (Ubuntu 24.04 arm64), `install.sh --setup-wizard` + `compose.simulator.yaml`.

Gerçekten çalıştırılanlar:
- API birim testleri: 22/22 (SMS sağlayıcı istek/yanıt biçimleri dahil).
- API entegrasyon testleri (gerçek PostgreSQL ve Redis): 65/65. Yeni `platform` dosyası 12/12:
  roller, kişiye özel izinler, yetki yükseltme reddi, kullanıcı adına giriş, yasaklama,
  TOTP + yedek kodla 2FA, marka dosyaları, SMTP testi, CAPTCHA (Cloudflare'in test anahtarlarıyla),
  SMS (yerel sahte sağlayıcıyla), bildirim kuyruğu ve içgörüler.
- Go adaptörü (simülatör): tüm testler geçti. Metrikler, sürüm uyumu tablosu ve guestinfo ile
  klonlama da dahil.
- Playwright E2E (HTTPS, gerçek kurulum): 17/17. Görev yöneticisi, kullanıcılar ve roller, ayarlar,
  bildirim kutusu, komut paleti ve 390 px genişlikte yatay kaydırma olmaması da dahil.
- `npm audit --omit=dev` (api, web, worker): 0. `govulncheck` (golang:1.27; console, vmware):
  bulgu yok. Açık Dependabot uyarıları yalnızca `main`'deki eski iç içe fastify için; bu dalda yok.

Bu testlerde bulunan ve düzeltilen hatalar:
- Simülatör API 6.5 bildirdiği için guestinfo yöntemi seçiliyor, VM hazır olmuyordu. Simülatör
  artık `-api-version` ile (varsayılan 8.0.3.0) başlıyor.
- Görev yöneticisi düğmesinin erişilebilir adı yoktu: içindeki `role=status` öğesi ad hesabına
  girmiyordu, Spinner da "Loading" adını veriyordu.
- `users_role_check` kısıtı özel ve çoklu rolleri reddediyordu (008'de değiştirildi).
- Bildirim işçisinin Redis bağlantısı kapanmadığı için test süreci bitmiyordu.

Bilinçli davranış: uygulama içi bildirimler gönderildiği anda hesabın kayıtlı dilinde yazılır
(e-posta ve SMS gibi). Arayüz dili sonradan değişirse eski bildirimler eski dilde kalır.

Doğrulanmayanlar:
- Gerçek SMS sağlayıcıları. İstek biçimleri belgelerden alındı, her sağlayıcının güven etiketi
  panelde görünür.
- Gerçek SMTP sunucusu, reCAPTCHA ve hCaptcha'nın gerçek anahtarları.
- Gerçek ESXi/vCenter 6.x–9.x. Sürüm tablosu VMware belgelerinden alındı; testler simülatörle yapıldı.
- Gerçek cihazlarda passkey ve Web Push teslimi.

## Firewall — 2026-10-24
- Go (simülatör): kural çevirisi, uygulama/düzenleme/kaldırma, port grubunda override izni, `FIREWALL_NEEDS_DVS` ve `FIREWALL_NO_PORT` geçti.
- API entegrasyonu: tam paket 66/66, bunların içinde gerçek worker, adaptör ve simülatörle firewall akışı da var:
  - sipariş anında ilk açılıştan önce uygulama;
  - kural değişikliği ve bağlantı kaldırmada yeniden uygulama;
  - standart switch'te hata kodu.
- E2E: firewall sayfası (şablondan oluşturma, hatalı port, kaydetme, silme) ve 390 px kontrolü geçti.
- Önceki koşuda çıkan hatalar düzeltildi:
  - jsonb anahtar sırası yüzünden kayıttan sonra hep "kaydedilmemiş değişiklik" görünüyordu;
  - müşteri izni (`firewalls.manage`) yönetici alanını açıyordu (`isStaff`);
  - destek rolü müşteri adına giriş yapamıyordu;
  - konsol testi simülatörün klonladığı VM'i seçebiliyordu.
- CI: ayar sırları için geçici bir master key eklendi (önceden runner'da 503 veriyordu).
- Gerçek vCenter'da doğrulanmadı: trafik yönü eşlemesi ve paketlerin gerçekten düştüğü.

## Ödeme yöntemleri — 2026-10-24
- Birim: 10 test (`payment-providers.test.mjs`).
  - İmzaları doğrulananlar: iyzico IYZWSv2, PayTR token, Moka CheckKey, Garanti HashData.
  - Sınıflandırma: "sipariş bulunamadı" kabul, "kullanıcı bulunamadı" ret, kimlik hatası ret, IP kısıtı ağ hatası sayılıyor.
  - Gizli değerler mesajlarda geri gösterilmiyor.
- Entegrasyon (platform 13/13):
  - canlı ve test bilgileri ayrı tutuluyor, şifreli saklanıyor ve gizli alanlar geri dönmüyor;
  - test edilmeden etkinleştirme reddediliyor;
  - gizli alan değişince sağlayıcı devre dışı kalıyor;
  - iç adresler reddediliyor.
- E2E: kaydet → etkinleştirme reddi → test → etkinleştir → listede görünme → kaldır akışı ve 390 px kontrolü geçti.
- Gerçek üye işyeri hesaplarıyla hiçbir sağlayıcı denenmedi.

## Panelden güncelleme ve get.sh — 2026-10-24
Demo sunucuda gerçek bir akışla denendi. Kod deposu olarak sunucudaki çıplak (bare) bir git deposu ve
yalnızca orada oluşturulan test etiketleri kullanıldı.

- **get.sh ile kurulum:** boş sunucuda `sh get.sh --repo /opt/lightning-repo.git` komutu `v0.1.0`'ı kurdu.
  HTTPS, yönetici, yedek zamanlayıcısı ve panel ajanı (systemd path) kuruldu; istek dizini uid 1000'e ait ve 700 izinli.
- **Panelden güncelleme (Playwright, gerçek tarayıcı):**
  - "Güncellemeleri denetle" yeni sürümü ve etiket notlarını gösterdi.
  - "Şimdi güncelle" sırasıyla şunları yaptı: yedek, worker'ı durdurma, yeni sürüm, sağlık kontrolü.
  - Panel yeniden başlarken sayfa beklemeye devam etti ve yeni sürümü bildirdi.
  - `v0.2.0 → v0.2.1` yaklaşık 2,5 dk, `v0.2.1 → v0.2.2` yaklaşık 3,5 dk sürdü; kenar çubuğu ve durum yeni sürümü gösterdi.
- **Komut satırından güncelleme:** `v0.1.0 → v0.2.0` geçti.
- **API entegrasyonu:**
  - geçersiz işlem, sürüm ve pencere değerleri reddediliyor;
  - ajan yokken ve iş sürerken istek reddediliyor;
  - istek dosyasının biçimi ve ilerlemenin geri okunması doğrulandı.
- **Testte bulunan kritik hata (düzeltildi):** ajanın çalıştırdığı alt `install.sh`, kopyadan çalıştığını
  sanıp kendi dosyasını siliyordu (`LVM_REEXEC` ortam değişkeni sızıyordu). İlk denemede güncelleme
  `E_UPDATE_LOCAL_CHANGES` ile durdu ve hiçbir şey değişmedi.
- **Doğrulanmayanlar:**
  - GitHub'dan özel depo ile `--token` ve SSH deploy key ile kurulum;
  - başarısız bir güncellemede otomatik geri dönüş (önceki aşamada komut satırından denenmişti, panel üzerinden denenmedi).

## IP yönetimi ve ters DNS — 2026-10-24
- Entegrasyon testleri tam paket 69/69 geçti; bunlara gerçek worker, simülatör ve gerçek PowerDNS 4.x ile yapılan IP testi dahil.
  - Ek IPv4 ve IPv6 içeren siparişin fiyatı doğru hesaplanıyor.
  - Varsayılan PTR'lar PowerDNS'e yazılıyor; müşterinin ileri doğrulamasız adı reddediliyor; yönetici değiştirebiliyor.
  - Silmede PTR'lar kaldırılıyor, adresler karantinaya alınıyor ve yeni sipariş karantinadaki adresi almıyor.
- Birim testleri: ters ad (IPv4 ve IPv6 nibble) ve PTR şablonu.
- Yeni davranış nedeniyle değiştirilen test: iki adresli test havuzu artık karantinasız (`quarantineHours: 0`).
  Aksi halde silinen adres 24 saat beklediği için sonraki testler `IP_EXHAUSTED` alıyordu.
- Gerçek colocation bloğunda ve gerçek bir konuk işletim sisteminde (IPv6 ile ek IPv4 için netplan) denenmedi.

## Kurulum ekranı ve 0.4.0 (beta) sürümü — 2026-11-21

Kurulum betiklerinin yeni çıktısı (`scripts/get.sh`, `scripts/install.sh`) ve `v0.4.0` etiketi için yapılan
denemeler. Etiket `46508f2` commit'indedir.

- **Sözdizimi ve lint:** `sh -n`, `dash -n`, `busybox ash -n`; `shellcheck -s sh` 0.9.0 ve 0.10.0: bulgu yok
  (önceki betikte 7 not vardı).
- **Test düzeneği (test sunucusunda, iki atılabilir kapsayıcı; Docker ve curl yerine taklitleri):** Ubuntu 24.04'te
  (`sh` = dash) ve Alpine 3.20'de (`sh` = busybox ash) 103'er denetim, hepsi geçti:
  - uçbirim olmayan kurulum: kaçış kodu ve satır başı karakteri yok, hiçbir şey sorulmuyor, son satır değişmedi,
    kayıt dosyası 600;
  - `script(1)` ile kaydedilen uçbirimde kurulum (iki dilde), `NO_COLOR`, UTF-8 olmayan yerel (yalnızca ASCII),
    `TERM=dumb`;
  - başarısız derleme ve başarısız başlatma: çıkış kodu 18 korunuyor, komutun son satırları gösteriliyor, geride
    süreç kalmıyor; dönen işaret sırasında Ctrl-C: çıkış 130, imleç geri geliyor, geride süreç kalmıyor;
  - planın reddi (çıkış 3, `.env` yok), dil sorusunun 30 saniyede varsayılanı seçmesi;
  - `get.sh`: boruyla `sh`'e verildiğinde uçbirim yokken hiçbir şey sormuyor, uçbirimde tuşu `/dev/tty`'den okuyor;
    kurulu dizinde ikinci çalıştırma güncelleme yoluna gidiyor; başarısız `git clone` kaydını saklıyor;
  - güncelleme (`v0.2.0 → v0.2.1`, düzeneğin kendi etiketleri) ve hazır olmayan güncelleme (çıkış 23, geri dönüş,
    son satır eskisi gibi); `backup`, `check`, `releases` ve olmayan bir dosyanın `restore` çıktısı önceki betikle
    bayt bayt aynı; panel ajanı üzerinden iki istek (`status.json` içinde `BACKUP` ve `UPDATED`);
  - derleme ilerlemesi derleme sürerken artıyor (taklit, test sunucusundaki gerçek `docker compose build`
    çıktısının biçimini yazar).
- **Temiz bir makinede gerçek kurulum (GitHub Actions, elle başlatılan `compose` işi):** Ubuntu 26.04, x86_64,
  Docker 29.4.2, Compose 5.1.3. `b0fb02a` üzerinde `install.sh --local --setup-wizard` uçbirimsiz biçimde sekiz
  adımı tamamladı (2 dk 26 sn), ardından `check`, `backup`, onaysız `restore` (çıkış 3) ve gerçek `restore` geçti.
  Bu çalıştırma iki şeyi buldu ve `46508f2` ile düzeltildi: derleme ilerlemesi derleme bitene kadar `0/12`'de
  kalıyordu; özetin üç yeri İngilizce çıktıda Türkçeydi. Aynı işin tarayıcı testleri ilk yönetici testinde durdu
  (4 geçti, 1 başarısız, 28 çalışmadı): geri yüklemeden sonraki bekletme şeridi "System" bağlantısını üçe
  çıkarıyordu; iş artık `restore --no-hold` kullanıyor. İkinci elle çalıştırmada (`46508f2`) kurulum, yedek / geri yükleme ve izleme
  adımları yine geçti; tarayıcı testlerinin 21'i geçti, biri başarısız oldu (API başvurusu testi,
  `connect ECONNREFUSED ::1:443`: test koşucunun kendi 443 portuna bağlanmaya çalışıyor), 11'i çalışmadı.
  Nedeni testin kendisiydi: `E2E_BASE_URL` verilmediğinde iki yerde `https://localhost` varsayıyordu, paketin geri
  kalanı ise `playwright.config.ts` içindeki `http://127.0.0.1:8080` adresini kullanıyordu; `--local` kurulumda 443'te
  dinleyen yoktur (demo sunucusunda `E2E_BASE_URL` verildiği için görünmüyordu). İki yer artık paketin adresini
  kullanıyor. `818f075` üzerinde elle çalıştırmada (çalıştırma 44830397971) bütün işler geçti: tarayıcı testleri
  33/33 (11,5 dk), `api-integration` 204 testte 141 geçti, 0 başarısız, 63 atlandı.
- **Demo sunucusunda gerçek güncelleme:** `b0fb02a` eski betikle kuruldu (33/33 tarayıcı testi, testler boyunca
  demo `/api/ready` 43 yanıtın 43'ünde 200). `46508f2` **yeni** betiğin `update` yoluyla kuruldu: yedek, worker'ın
  durdurulması, derleme ve başlatma (1 dk 6 sn), `OK UPDATED`; kayıt `data/logs/update-…log` (izin 600, 652 satır).
  Demo `git describe` ile `v0.4.0` gösteriyor; web ve API kapsayıcılarında `APP_VERSION=v0.4.0`. Ardından 33/33 tarayıcı testi geçti; testler boyunca demo `/api/ready` 44 yanıtın 44'ünde 200.
  Demo `stable` kanalında ve otomatik güncellemesi açık: kanalın en yeni etiketi artık çalışan commit'in kendisi
  olduğundan gece çalışması `UP_TO_DATE` ile biter (denetlendi: hedef `v0.4.0` = `HEAD`). Test sunucusunun
  deposundaki eski iç test etiketlerine (`v0.1.1`-`v0.3.0`) dokunulmadı; hepsi `v0.4.0`'dan küçüktür.
- **Sürüm:** `v0.4.0` etiketi GitHub'a gönderildi; yayın iş akışı (birim işleri, 11 imaj, sürüm sayfası) geçti.
  Sürüm sayfası "Lightning VM v0.4.0 (beta)" adıyla ve pre-release işaretiyle oluştu, notları `CHANGELOG.md`
  dosyasının 0.4.0 bölümüdür. Kimliksiz yeni bir kopyada etiketler `v0.1.0` ve `v0.4.0`; `get.sh`'in seçtiği
  `v0.4.0`. `https://lightningvm.app/install.sh` adresindeki betiğin sha256'sı depodaki `scripts/get.sh` ile aynı
  (`d94f0488…6de2`). GitHub'ın `releases/latest` uç noktası yalnızca pre-release olduğu için 404 döner; kurulum ve
  panel bu uç noktayı kullanmaz.
- **Çalıştırılmayanlar:** gerçek Docker ile uçbirimde (etkileşimli) kurulum; Docker'ın apt ile kurulduğu adım;
  yeni çıktıyla `domain`, `behind-proxy`, `local-only`, `monitoring`, `terminal`, `uninstall`; gerçek sunucuda
  `curl … | sudo sh` ile baştan sona kurulum (lightningvm.app adresindeki kopya yeniden eşitlendikten sonra
  denenmeli).
- **`api-integration` işindeki 403 (çözüldü, API değişmedi):** `security-auth.test.mjs:217` başka siteye giden bir
  `callbackURL` için 400 bekliyordu, GitHub'da 403 geldi. İkisi de rettir: POST isteklerinde önce better-auth'un kendi
  denetimi (güvenilen origin'ler, 403), ardından panelin denetimi (yalnızca panel yolları, 400) çalışır. Kütüphane
  kendi denetimini `NODE_ENV=test` iken kapatır; `run.sh` bunu ayarlar, CI ayarlamaz (API orada kurulumdaki gibi
  çalışır). Test artık `NODE_ENV=test` iken yalnızca 400'ü, değilken 400 veya 403'ü kabul ediyor ve yanıtta
  `Location` olmadığını da denetliyor; GET isteğinde beklenti 400 olarak kaldı. Bu değişiklikten sonra `run.sh` ile
  (`NODE_ENV=test`) yerelde yeniden çalıştırılmadı: bu makinede Docker yok.
