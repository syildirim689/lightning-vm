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

## Yol haritasından beş iş: adres doğrulama, proje kotası, Stripe webhook'u, belgelerden istek, izleme anahtarı — 2026-11-21

Beş iş ayrı commit'lerle `main`'e girdi (`bff6553` adres doğrulama, `d667d76` proje kotası, `e0d078e` Stripe
webhook'u, `2b81e2b` API belgelerinden istek çalıştırma, `c5934dc` izleme anahtarı); altıncısı, çalışan sunucuya
sonradan ek IP, **yazılmadı** (`1a007c5` yalnızca nedenini ve eksikleri yazar: [ip-management.md](ip-management.md)).
Aynı saatlerde başka bir çalışma "akıllı özellikler"i ekledi; aşağıdaki sayılar iki işin toplamıdır.

- **Yerel çalıştırma (geliştirme makinesi, Docker yok):** PostgreSQL 18 ve Redis 8, WSL içinde geçici bir dizinden;
  testler Windows'taki Node 26 ile, dosya dosya. Yeni entegrasyon dosyaları: `email-verification` 8/8,
  `project-quota` 4/4, `stripe-webhook` 8/8, `api-try` 2/2, `monitoring-switch` 4/4. Dokunulan kodun eski
  dosyaları: `auth` 15/15, `security-auth` 21/21, `platform` 42/42, `security-billing` 18/18,
  `security-servers` 14/14, `saved-views` 9/9, `security-leftovers` 4/4. Aynı makinede birkaç dosya tek komutla
  çalıştırıldığında birbirinin şemasını sildiği görüldü (yalnızca bu makinede; CI'da sıralı çalışır); bu yüzden
  dosya dosya çalıştırıldı. API birim testleri 186/186, web birim testleri 131/131.
- **Yerel tarayıcı denemesi:** API ve üretim derlemesiyle web, küçük bir vekilin arkasında, hipervizörsüz bir
  katalogla; kurulu Edge ile. Yeni ve değişen beş tarayıcı testi tek tek geçti (adres doğrulama, proje kotası,
  ödemeler / Stripe adresi, belgelerden istek, izleme: ajan yokken ve varken). Paketin kurulumunda yapılamayan iki
  şey yalnızca burada, depoya girmeyen iki denemeyle görüldü: postayla gelen kodun ve bağlantının tarayıcıda adresi
  doğrulaması (bu makinede dinleyen sahte bir SMTP sunucusuyla) ve onaylanan izleme anahtarının ajan için doğru
  istek dosyasını bırakması (ajan çalışmıyordu; dosya okundu).
- **GitHub CI:** itmeden sonraki birim işleri her commit'te geçti. Elle tam çalıştırma `1a007c5` üzerinde
  (çalıştırma 44865023856): `api-integration` 247 testte 184 geçti, 0 başarısız, 63 atlandı; birim, adaptör, Go ve
  imaj derleme işleri geçti; `compose` işi (gerçek kurulum ve tarayıcı paketi) daha yeni bir itme yüzünden
  **iptal edildi**. Bu işlerin hepsini içeren `161d387` üzerinde diğer çalışmanın başlattığı elle tam çalıştırmada
  (çalıştırma 44865854195) bütün işler geçti; `compose` işindeki tarayıcı paketi 42/42 (14,1 dk).
- **Demo sunucusu:** `bff6553` ile güncelleme ve tarayıcı paketi: 34/34 (14,1 dk), testler boyunca demo
  `/api/ready` 44 yanıtın 44'ünde 200. `d667d76`: 10 geçti, 2 başarısız, 25 çalışmadı; iki başarısızlık da diğer
  çalışmanın eklediği metinlerin bir sayfada iki kez görünmesindendi (o çalışma `adc68f7` ile düzeltti).
  `1a007c5`: 42 testin 37'si geçti (`app.spec.ts`'in tamamı, bu işin dört yeni ve iki genişletilmiş testi
  dahil), 1 başarısız, 4 çalışmadı: başarısız olan `smart.spec.ts`'in ilk testiydi (yönetici girişi `/login`'de
  kaldı; diğer çalışma `161d387` ile düzeltti). Testler boyunca demo `/api/ready` 46 yanıtın 46'sında 200.
- **Denenmeyenler:** gerçek bir posta sunucusu; gerçek Stripe (olaylar testte bir test anahtarıyla imzalandı,
  Stripe'a istek gitmedi); ajanın `monitoring on|off` isteğini bir sunucuda çalıştırması; proje kotasıyla gerçek
  bir hipervizörde sunucu kurulması (testler siparişin kabul ya da reddine kadar gider).

## 0.4.0'dan sonra eklenenlerin gözden geçirilmesi, iki yeni yardımcı ve ölçümler — 2026-11-21

`v0.4.0` etiketinden sonra `main`'e giren her şey (adres doğrulama, proje kotası, Stripe webhook'u, belgelerden istek,
izleme anahtarı, beş akıllı yardımcı) yayımlanmadan önce başkasının işi gözüyle okundu; iki yardımcı daha eklendi
(bakım için en sakin saatler `d8d5490`, dönemsel özet `d85b6a3`). Bulunan her kusur kökünden düzeltildi ve aşağıda
yazılı; kullanıcıya görünenler `CHANGELOG.md` içinde "Fixed" başlığındadır.

### Bulunan kusurlar ve düzeltmeleri

Önem sırasıyla. "Önceden vardı" denenler 0.4.0'da da vardı; yeni eklenenler onlara yeni bir yol açtığı ya da aynı
kodu kullandığı için ele alındı.

| # | Önem | Kusur | Neden | Düzeltme (commit) |
|---|---|---|---|---|
| 1 | yüksek | Tek bir zamanlamanın saat dilimi bütün zamanlamaları durdurabiliyordu (güç, otomatik anlık görüntü, zamanlanmış yedek; herkes için, her dakika). | Zamanlayıcı saati tek SQL ifadesinde `AT TIME ZONE p.timezone` ile okur; saat dilimi yalnızca çalışma zamanına (Intl) soruluyordu. Node `AET`, `PNT` gibi kısa adları ve `Asia/Calcutta`, `Europe/Kiev` gibi eski adları tanır (Chrome'un Hindistan'da bildirdiği ad `Asia/Calcutta`'dır); PostgreSQL kısa adları hiç, eski adları yalnızca tzdata'sı onları taşıyorsa tanır. Önceden vardı; zamanlama önerisi ikinci bir giriş yolu ekledi. Bu makinedeki PostgreSQL 18.6 ile doğrulandı (Node'un 418 kanonik adından 18'ini tanımıyor); demo'daki `postgres:17-alpine` eski adları taşıyor, kısa adları taşımıyor. | Saklanan ad veritabanının kabul ettiği addır (`time-zone-db.ts`): verilen ad, yoksa dilimin öteki adı, o da yoksa 400. Zamanlayıcı saati yalnızca tanınan dilimler için okur (`CASE`), eski satırı yeniden adlandırır ya da atlayıp bir kez kaydeder. İstatistik sayfası UTC'ye düşer. (`567f55f`) |
| 2 | yüksek | Zamanlama önerisi hesaplanırken API'nin tek iş parçacığı sunucu başına yaklaşık çeyrek saniye (bu makinede 2,6 sn) kilitleniyordu; genel bakış 20 sunucuya kadar bunu art arda yapıyordu. | `slotOf` geçmişin her satırı (672) için yeni bir `Intl.DateTimeFormat` kuruyordu. | Saat dilimi başına tek biçimlendirici. (`d8d5490`) |
| 3 | orta | Kullanım takibi hafta içi çalışan sunucuyu her hafta sonu "olağandan çok düşük", haftalık işi her hafta "olağandan çok yüksek" buluyor ve sahibine her seferinde bildirim gidiyordu. | Taban "önceki günlerin aynı saatleri"ydi; haftanın günü hesaba katılmıyordu. Tohumlanmış geçmişle uçtan uca çalıştırılırken (cumartesi) görüldü. | Ayrılma, bir ve iki hafta önceki aynı pencereye göre de geçerli olmalı. (`1701d16`) |
| 4 | orta | Ölçümde birkaç saatlik boşluk (platform yanıt vermedi, worker durdu) bütün açık bulguları kapatıyor, ölçüm dönünce yeniden açıp sahiplere ikinci kez yazıyordu. | "Yargılanamıyor" da "kapandı" sayılıyordu. | Yargılanamayan bulgu 6 saat tutulur. (`1701d16`) |
| 5 | orta | Stripe webhook'u, panelin başarısız diye kapattığı bir ödeme için gelen imzalı "ödendi" bildirimini onaylayıp atıyordu: fatura ödenmemiş kalıyor, sonraki faturalama çalıştırması kartı ikinci kez çekiyordu. | Yalnızca `pending` ödemeler ele alınıyordu (yanıtı 30 sn içinde gelmeyen kayıtlı kart tahsilatı `PROVIDER_ERROR` ile kapanır). Önceki test bu davranışı "kapalı ödeme kapalı kalır" diye sabitliyordu. | Ödeme yeniden açılıp her ödeme gibi kaydedilir (faturaya; fatura bu arada ödendiyse bakiyeye). (`0105b32`) |
| 6 | orta | "Bu zamanlamaları oluştur" iki kez basılınca (ya da iki sekmede) çift iki kez oluşuyor; sınıra bir kalmış sunucuya açılışı olmayan kapanış yazılıyordu. | Denetimler kilidin dışında, iki ekleme ayrı işlemlerdeydi. | Tek işlem, sunucu kilidi altında, koşul içeride yeniden bakılıyor. (`567f55f`) |
| 7 | orta | Bütçe tahmini denetimi her çalışmada aynı ilk 500 hesaba bakıyordu; 500'den fazla bütçeli hesapta kalanlar hiç denetlenmiyordu. | `ORDER BY id LIMIT 500` ve bütçesinin altındaki hesabın işaretlenmemesi. | Kimlik sırasıyla sayfa sayfa hepsi. (`0105b32`) |
| 8 | orta | Genel bakıştaki içgörüler her dakika, açık her sayfa için hesabın her sunucusunun bir haftalık işlemci örneğini yeniden okuyordu; personel listesi çalışan her sunucu için (200 sunucuda 405 400 satır, tablodan satır satır). | `cpuStats` her çağrıda `server_cpu_samples` okur. Önceden vardı. | Haftalık rakamlar sunucu başına 10 dakika Redis'te. (`0d3430a`) |
| 9 | düşük | Kart uyarısı "kayıtlı kartlardan biri yetiyor mu"ya bakıyordu; faturalama yalnızca varsayılan kartı çeker. Varsayılanı yenilemeden önce biten, yedeği yeten hesap uyarılmıyordu. | Kural ile `chargeSavedCard` aynı kartı seçmiyordu. | Çekilecek kart yargılanır; metinler buna göre. (`0105b32`) |
| 10 | düşük | Müşterinin yarıda bıraktığı ya da süresi dolan ödeme sayfası personel listesinde "başarısız tahsilat" sayılıyordu. | `status = 'failed'` her ikisini de kapsar. | `EXPIRED` ve `CANCELLED_BY_CUSTOMER` sayılmaz. (`0105b32`) |
| 11 | düşük | Ayın son üç saatinde (UTC) saatlik sunuculu hesabın tahmini, gelecek ayın kullanımını bu ayın kalan saatleriyle gösteriyordu. | Kullanım faturalamanın ayıyla (İstanbul günü), oran ve kalan saat UTC ayıyla okunuyordu. | İkisi de UTC ayı. (`0105b32`) |
| 12 | düşük | Kullanım takibi gece yarısı (UTC) çevresinde iki gecelik geçmişi dört gün sayıyordu. | Günler takvim gününe göre sayılıyordu. | Pencereden geriye sayılır. (`1701d16`) |
| 13 | düşük | Aynı anda iki sunucuya istenen ek disk, aynı boş kotaya karşı ölçülüp ikisi de geçebiliyordu (hesap ya da proje kotası). | Denetim ile yazma ayrı adımlardı. Önceden vardı; proje kotası aynı kodu kullanıyor. | Sahibin kilidi altında tek işlem. Yeniden boyutlandırmadaki aynı pencere 0.5.0'da duruyordu, sonra kapatıldı: [sayfanın sonunda](#050dan-sonra-yeniden-boyutlandırmada-kota--2026-11-21). (`545b686`) |
| 14 | düşük | Adres doğrulamada, kod bulamayan bir onay ya da geç başarısız olan bir posta, başka bir isteğin az önce yazdığı kodu silebiliyordu. | Koşulsuz `DEL`. | Kod yalnızca sahibi olan istekçe silinir (Lua). (`545b686`) |
| 15 | düşük | Destek önerilerinin sayacı süresiz kalıp önerileri kalıcı susturabiliyordu; kota `PUT` isteği gövdesiz gelince 500 dönüyordu; içgörü gizleme anahtarı NUL karakteriyle 500 dönüyor ve sınırsız satır yazılabiliyordu; belgelerden çalıştırılan isteğin JSON yanıtında daha uzun bir değerin içindeki gizli değer gizlenmiyordu; her öneri oluşturmada Redis `KEYS` taraması yapılıyordu. | Ayrı küçük eksikler. | `545b686`, `1701d16`, `567f55f`. |
| 16 | düşük | Worker'ın saatlik çalışması, grubun bütün satırlarını her sunucu için yeniden tarıyordu (200 sunucu, iki haftalık saatler: 1,4 sn; bir kez dağıtınca 0,12 sn). | `hours.filter(...)` sunucu başına. | Satırlar sunucularına bir kez dağıtılır. (`1701d16`) |

**Doğrulanmayan şüpheler:** örneklerin zamanı üzerindeki blok aralığı dizininin (BRIN), eski satırlar silinip yerleri
yeniden kullanıldıkça işe yaramaz hale geleceği düşünüldü; ölçüldü ve öyle olmadığı görüldü (aşağıda). Tek eksik,
yeni aralıkların ancak bir sonraki vakumda özetlenmesiydi: migration 091 dizinde `autosummarize`'ı açar.

**Bilinip bu turda düzeltilmeyen (0.5.0 bununla çıktı; sonra düzeltildi):** yeniden boyutlandırmada kota, işlem
kabul edilirken ölçülüyor ve kullanım ancak worker işlemi bitirince artıyordu; aynı hesabın iki sunucusu aynı anda
büyütülürse ikisi de aynı boş kotaya karşı ölçülüyordu. 0.4.0'da da böyleydi. Düzeltmesi ve neyin denendiği:
[0.5.0'dan sonra: yeniden boyutlandırmada kota](#050dan-sonra-yeniden-boyutlandırmada-kota--2026-11-21).

**Sağlam bulunanlar:** yeni yolların hepsinde yetki ve sahiplik (içgörüler, bulgular, zamanlama önerisi, destek
önerileri ve benzer talepler, ödeme riski, proje kotaları, adres doğrulama, kullanım özeti, izleme anahtarı):
bir müşteri başka bir müşterinin verisini hiçbirinden okuyamıyor; salt okunur API anahtarı yazamıyor. Belgelerden
istek çalıştırma: yalnızca belgelenmiş panel yollarına gidebiliyor (yol parametreleri `encodeURIComponent` ile,
`.`/`..` reddedilir), başka siteden sürülemiyor (CSRF başlığı ve Origin denetimi `X-Lightning-Try`'dan bağımsız; CORS
yok), hız sınırını ve yetkileri aşmıyor (başlık yalnızca bir sayaç ekler). Sipariş kotası: denetim ve ekleme aynı
işlemde, proje ve hesap kotasının ortak kilidi altında. Doğrulama kodu denemeleri atomik sayılıyor, karşılaştırma
sabit süreli. Stripe'ta "bir kez kaydedilir" veritabanında sağlanıyor (ödeme satırı kilitli). Zamanlayıcılar Redis
kilidi altında; birden çok kopyada üst üste binen çalışma ya da yakalanmamış hata yolu yok. Migration 088-091 var
olan veride tablo yeniden yazmıyor.

### Ölçümler: 200 sunucu, 14 günlük örnek

`apps/api/test/integration/seeded-history.test.mjs` (`SEEDED=1`; tohumlama `seed-history.mjs` içinde bir test
yardımcısıdır, hiçbir gerçek veritabanına yazmaz): 20 müşterinin 200 sunucusu, beş kullanım biçimi (ofis, düz, gece
işi, boşta, günlük dalga), 14 gün × 5 dakikalık **806 600** işlemci örneği, dört haftalık **134 600** saatlik satır,
16 günlük trafik. Geliştirme makinesi, PostgreSQL 18.6 ve Redis 8.0.5 WSL içinde geçici bir dizinden; API ile
veritabanı arasında her sorgu yaklaşık 14 ms gidiş-dönüş tutuyor (WSL köprüsü), yani **süreler şişkindir ve
çalıştırmadan çalıştırmaya oynar**; sorgu ve sayfa sayıları taşınabilir olanlardır. "Önce" `467b939` derlemesidir.

| Ölçüm | Önce | Sonra |
|---|---|---|
| Zamanlama önerisi, tek sunucu (`GET /servers/:id/schedule-suggestion`) | 2 600 ms | 12 sorgu, 76-119 ms |
| `GET /insights`, 10 sunuculu müşteri, ilk çağrı (hiçbir şey saklı değil) | 10 983 ms | 56 sorgu, 483-3 540 ms (üç çalıştırma) |
| `GET /insights`, sonraki dakikaların çağrıları | her çağrıda bir haftalık örnek okunur (10 sunucu: 3 200 sayfa, 97-206 ms plan); 149-546 ms | 20 sorgu, örnek okunmaz; 66-350 ms |
| `GET /admin/insights`, liste yeniden hesaplanırken (pano açıkken dakikada bir, uyarılar için 10 dakikada bir) | 405 400 satır örnek okunur (410 013 sayfa erişimi, plan 1,3-3,7 sn); 7 397 ms | 24 sorgu, örnek okunmaz; 92-385 ms. Rakamlar da saklı değilken (10 dakikada en çok bir): 28 sorgu, 2,4-3,2 sn |
| `GET /admin/insights`, saklanan liste | 74 ms | 4 sorgu, 16-27 ms |
| Kullanım takibi, 200 sunucu (saatlik) | satır dağıtma 1 395 ms | 7 sorgu (3 bulguyla 10); satır dağıtma 121 ms; toplam 1,7-4,7 sn (çoğu 62 800 satırın okunması) |
| Saatlik toplama (yalnızca en yeni saat) | aynı | 2 sorgu, 14-46 ms; 5 931 sayfalık tablodan 49 sayfa (BRIN) |
| Aynı okuma, bir gün silinip yeri yeniden kullanıldıktan sonra | aynı | 173 sayfa (dizin işe yaramaya devam ediyor) |
| İlk toplama (14 günün tamamı, yükseltmeden sonra bir kez) | aynı | 2 sorgu, 13-22 sn |
| En sakin saatler, bütün kurulum (ilk / saklanan yanıt) | yoktu | 7 sorgu, 452-674 ms / 3 sorgu, 19-70 ms |
| En sakin saatler, bağlantı ve 4 host | yoktu | 7 sorgu, 1,3 sn (yanıt 30 dakika saklanır) |
| Migration 088-091, 748 800 örnek ve 21 kullanıcı yerindeyken | | 1,0-3,7 sn; satır kaybı yok, her biri bir kez kayıtlı, ikinci çalıştırma hiçbir şey uygulamıyor |

**Sonuçlar anlamlı mı (aynı veriyle uçtan uca):**

- **Toplama:** 200 sunucunun her biri için 14 günün her saati (67 400 satır), tam saatlerde 12 örnek; ikinci
  çalıştırma hiçbir şeyi ikilemiyor.
- **Kullanım takibi:** olağan kullanımda **0 bulgu** (ofis sunucuları hafta sonu boşta, gece işi her gece, günlük
  dalga: hiçbiri bulgu değil; düzeltme 3'ten önce cumartesi günü ofis sunucuları "düşük" çıkıyordu). Üç gerçek
  ayrılma eklenince tam o üçü: son üç saatte %97'ye çıkan boş sunucu (`cpu_pinned` notuyla), susan düz sunucu,
  78 GB giden trafiği olan sunucu (`outbound`). Sahiplere birer kez yazılıyor; sonraki çalıştırma yenisini açmıyor.
- **Zamanlama önerisi:** ofis sunucusu için 19:00 kapanış / 07:00 açılış, pazartesi-cuma, haftada 108 saat; boşta
  sunucu `always_idle`, düz, dalgalı ve gece işi olan sunucular `no_window`. Üç saat %97'de çalıştırılan boş sunucu
  artık "her zaman boş" sayılmıyor.
- **En sakin saatler:** gece işi 01:00-03:59, ofisler 08:00-17:59, dalganın dibi 02:00: en sakin iki saat işin
  hemen öncesi (23:00-01:00) ya da hemen sonrası (04:00-06:00); ikisi 32,9 meşgul vCPU ile neredeyse eşit (haftanın
  ortalaması 62,1, en yoğun saat 93,6). Bağlantı aynı sonucu, dört host 50'şer sunucuyla kendi sonucunu veriyor.
- **İçgörüler:** müşteriye iki ofis sunucusu için `SCHEDULE_SUGGESTED`, iki boş sunucu için `IDLE_SERVER`.

### Demo sunucusu (yalnızca okuma, SSH)

`467b939` ile yerinde güncellenmiş hali, güncellemeden yaklaşık bir saat sonra:

- 24 kapsayıcının hepsi çalışıyor, sağlık denetimi olanlar `healthy`, **yeniden başlatma sayısı hepsinde 0**, OOM yok.
- Bellek: API 91 MiB, web 69 MiB, worker 34 MiB, PostgreSQL 35 MiB; sunucuda 15,6 GiB'ın 13,9'u kullanılabilir.
  Disk %37. Yük ortalaması 0,6.
- API günlüğü (son dağıtımdan beri 6 768 satır, 3 383 istek): `error` / `warn` düzeyinde satır **yok**, 5xx yanıt yok,
  2 saniyeyi aşan istek yok. Worker günlüğü: başlangıç ve yarım saatlik port taramaları, hata yok. Web günlüğü:
  dışarıdan gelen dört geçersiz Next.js "server action" denemesi (tarayıcı botları), başka bir şey yok.
- PostgreSQL günlüğü (24 saat): kilit bekleme ya da deadlock yok. İki sözdizimi hatası elle yazılmış inceleme
  sorgularına ait (biri önceki çalışmanın, biri bu incelemenin; hiçbiri bir şey değiştirmedi). 20 Kasım 20:40'taki
  "terminating connection" satırları sunucunun planlı yeniden başlatılmasıdır.
- `schema_migrations`: 89 satır, 89 ayrı sürüm; `088_usage_anomalies` ve `089_budget_forecast` birer kez (03:24 UTC).
- Sunucu ajanı: bakım zamanlayıcısı saatte bir sorunsuz bitiyor; son yedi güncellemenin hepsi `ok`, her birinden
  önce yedek alınmış.
- Demo'da hiç sunucu ve örnek yok (`server_cpu_samples` ve `server_cpu_hourly` boş): akıllı yardımcılar orada
  yalnızca "yeterli veri yok" halleriyle çalışıyor. Koda yansıyan bir anormallik bulunmadı.

### Tarayıcı paketi, iki tema ve 390 px

- **Genişlik testi** (390, 768, 1920 px) 0.4.0'dan sonra eklenen ekranları da geziyor: kotalar (proje kotalarıyla),
  projeler, ödeme ayarları (Stripe adresi), olağan dışı kullanım, risk altındaki hesaplar, profil (adres doğrulama),
  faturalar. Zamanlama önerisi, kullanım takibi, en sakin saatler ve dönemsel özet kendi testlerinde 390 px'te,
  içleri doluyken ölçülüyor.
- **Tema testi** yeni blokları iki temada, içleri doluyken açıyor (yeni bir kurulumda geçmiş olmadığı için ilgili
  tek rotanın yanıtı hazır verilir): yardımcıların içgörüleri, en sakin saatler (Sistem ve bağlantının host'ları),
  izleme kartı, dönemsel özet, olağan dışı kullanım, risk altındaki hesaplar, kotalar, projeler, ödeme ayarları,
  belgelerden istek çalıştırma, sunucu sayfasında kullanım takibi ve zamanlama önerisi. Her blokta **her metnin rengi
  arkasındakiyle ölçülür** (sayfadan aşağı arka planlar saydamlıklarıyla üst üste boyanır; WCAG kontrast oranı;
  taban 3:1). Ölçümün kendisi önce bilinen örneklerle sınanır (koyu zeminde koyu yazı ve beyaza yakın katmanda
  soluk yazı bulunmalı, okunaklı yazı bulunmamalı). **İki temada da 3:1'in altında metin bulunmadı.**
- **Çalıştırmalar (test sunucusunda, her biri atılabilir kendi yığınında; demo'nun verisine dokunulmaz):**
  - `e758595`, demo güncellemesiyle: 44 testin 40'ı geçti, 2'si başarısız, 2'si çalışmadı; demo `/api/ready` 34
    yanıtın 34'ünde 200. Aynı commit'te GitHub'daki elle tam çalıştırmanın (`44884186309`) `compose` işi **aynı iki
    testte** durdu (40 geçti, 2 başarısız, 2 çalışmadı): rastgele değil, iki gerçek hata.
    1. Dönemsel özetin önizlemesi ekranda hesabın diliyle (Türkçe) yazılıyordu, sayfa İngilizceyken de. Mesaj hesabın
       diliyle gitmeye devam ediyor; yanıt artık iki dili de taşıyor ve sayfa kendi dilini gösteriyor (`a4c65b9`).
    2. Tema testi, belgelerdeki bir rotayı açmadan "isteği çalıştır" bölümünü arıyordu (testin hatası; `a4c65b9`).
  - `a4c65b9`, demo'ya dokunmadan: **44/44** (17,0 dk); demo `/api/ready` 53 yanıtın 53'ünde 200.
  - Aynı elle çalıştırmanın diğer işleri geçti: `api-integration` (yeni entegrasyon dosyaları dahil, PostgreSQL 17
    ile), birim işleri (API, web ve derlemesi, worker), altı adaptör, iki Go servisi (`gofmt`, `go vet`,
    `go test`), 11 imaj derlemesi, `node scripts/audit.mjs` (yüksek ve kritik bağımlılık uyarısı yok).
  - Sürüm commit'inin art arda iki tam çalıştırması ve karşılaştırması sayfanın sonundaki sürüm bölümündedir.

### Yerelde çalıştırılanlar

Geliştirme makinesinde (Docker yok; PostgreSQL 18.6 ve Redis 8.0.5 WSL içinde geçici dizinden, iş bitince silindi),
dosya dosya:

- API birim testleri 206/206, worker 66/66 (`npm run check`), web 131/131 ile ileti ve simge denetimleri;
  `tsc` (API) ve `tsc --noEmit` (web) temiz.
- Entegrasyon: `smart-maintenance-hours` 4/4, `smart-digest` 8/8, `smart-schedule` 6/6, `smart-anomalies` 5/5,
  `smart-forecast` 4/4, `smart-payment-risk` 3/3, `stripe-webhook` 8/8, `email-verification` 8/8,
  `project-quota` 4/4, `platform` 42/42, `security-servers` 14/14, `security-billing` 18/18,
  `seeded-history` 6/6 (`SEEDED=1`). Makine yük altındayken iki kez "connection timeout" görüldü (havuzun 3
  saniyelik bağlantı süresi, WSL köprüsü); aynı dosyalar tek başına yeniden çalıştırıldığında geçti.

### Çalıştırılmayanlar ve doğrulanmayanlar

- Süreler küçük bir gerçek sunucuda ölçülmedi; yalnızca geliştirme makinesinde, PostgreSQL 18 ile. Panelin
  PostgreSQL'i 17'dir: planlar farklı olabilir (18'in birincil anahtarda "skip scan"i 17'de yok; BRIN okuması bu
  yüzden ayrıca, dizin taraması kapatılarak ölçüldü).
- Dönemsel özetin e-posta ve mesajlaşma uygulaması teslimatı gerçek bir posta sunucusu ya da uygulamayla denenmedi;
  gelen kutusu teslimatı entegrasyon testinde ve tarayıcı testinde görüldü. Sessiz saatler özet için ayrıca
  sınanmadı: özet sıradan bir bildirimdir ve tüketicinin var olan kuralından geçer (`quiet-hours.test.mjs`).
- Saat dilimi düzeltmesinin "yeniden adlandırma" yolu yalnızca eski adları tanımayan yerel PostgreSQL 18'de
  çalıştı; panelin `postgres:17-alpine` imajı eski adları tanıdığı için orada o yol hiç çalışmaz (kısa adların
  reddi ve zamanlayıcının korunması CI'da, PostgreSQL 17 ile çalıştı).
- Stripe'ın geç gelen "ödendi" bildirimi burada imzalanan olaylarla sınandı; gerçek Stripe ile denenmedi.
- Kurulum betiğindeki ad yenileme (`install.sh update`, sonradan etiketlenen commit) 103 denetimlik kurulum
  düzeneğiyle denenmedi; `sh -n`, `dash -n` ve CI'daki `shellcheck` ile, sonra demo sunucusunda gerçek
  çalıştırmayla doğrulandı (sürüm bölümü).
- `servers.test.mjs` (worker ve simülatör ister) yerelde ve CI'da çalışmaz; `compose` işi ve tarayıcı paketi aynı
  yolları uçtan uca geçer.
- Proje sitesi (lightningvm.app) bu turda güncellenmedi; `scripts/get.sh` değişmedi.

### 0.5.0 (beta) sürümü

`v0.5.0` etiketi `b176948` commit'indedir (açıklamalı etiket). Etiket, o commit denendikten sonra kondu:

- **GitHub CI, elle tam çalıştırma `44888461456` (`b176948`):** bütün işler geçti. `api-integration` 269 testte 200
  geçti, 0 başarısız, 69 atlandı (63'ü simülatör isteyen `servers.test.mjs` ve benzerleri, 6'sı yalnızca istenince
  çalışan `seeded-history`); `compose` işi (`shellcheck`, gerçek kurulum, yedek / geri yükleme, izleme, tarayıcı
  paketi) 44/44 (15,4 dk); API birim testleri 206, altı adaptör, iki Go servisi, 11 imaj derlemesi.
- **Demo sunucusu, aynı commit, art arda iki tam tarayıcı çalıştırması (atılabilir yığın):**
  1. demo `b176948`'e güncellendi (`OK UPDATED`, derleme ve başlatma 2 dk 37 sn), ardından **44/44** (17,0 dk);
     testler boyunca demo `/api/ready` 52 yanıtın 52'sinde 200;
  2. demo'ya dokunmadan yeniden: **44/44** (16,6 dk); `/api/ready` 51 yanıtın 51'inde 200.
  İki çalıştırmada aynı 44 test çalıştı, hiçbiri yeniden denenmedi, sonuçlar aynı: bir kez geçip bir kez kalan test
  yok. (Bu commit'ten önceki iki çalıştırmada görülen iki hata yukarıda yazılıdır; ikisi de her çalıştırmada ve
  CI'da aynı yerde kaldı, rastgele değildi.)
- **Etiket:** `origin`'e ve test sunucusunun deposuna yalnızca `refs/tags/v0.5.0` gönderildi. Test sunucusunun
  deposundaki eski iç test etiketleri (`v0.1.1`-`v0.3.0`) ve `v0.1.0`, `v0.4.0` gönderimden önce ve sonra
  karşılaştırıldı: değişmedi; hiçbiri GitHub'a gitmedi (GitHub'daki etiketler `v0.1.0`, `v0.4.0`, `v0.5.0`).
- **Yayın iş akışı `44892152768`:** birim işleri, 11 imaj (`ghcr.io/syildirim689/lightning-vm/*:v0.5.0`) ve sürüm
  sayfası geçti. Sayfa "Lightning VM v0.5.0 (beta)" adıyla ve **pre-release** işaretiyle oluştu; notları
  `CHANGELOG.md` dosyasının 0.5.0 bölümüdür.
- **Kimliksiz yeni bir kopya:** etiketler `v0.1.0`, `v0.4.0`, `v0.5.0`; kurulumun seçtiği en yeni düz etiket
  `v0.5.0` (`b176948`).
- **Demo `v0.5.0` gösteriyor:** etiket konduktan sonra aynı commit için güncelleme yeniden çalıştırıldı; yapacak bir
  şey yoktu (`OK UP_TO_DATE Up to date: v0.5.0`) ve betiğin bu sürümle gelen yolu adı yeniledi: `.env` içinde ve
  API ile web kapsayıcılarında `APP_VERSION=v0.5.0`, `git describe` `v0.5.0`, servisler sağlıklı, `/api/ready` 200.
  (Etiketten önce panel `v0.4.0-30-gb176948` gösteriyordu.) Demo `stable` kanalında ve otomatik güncellemesi açık:
  kanalın en yeni etiketi çalışan commit'in kendisidir.
- **Çalıştırılmayanlar:** temiz bir makinede `curl … | sudo sh` ile 0.5.0 kurulumu (CI'daki `compose` işi aynı
  commit'i `--local` ile kurar); 0.4.0 kurulu gerçek bir panelin, verisi olan bir veritabanıyla 0.5.0'a
  güncellenmesi (demo yerinde güncellendi ama orada sunucu ve örnek yok; migration'lar verili veritabanında yalnızca
  yerel ölçümde çalıştı); yayımlanan `ghcr.io` imajlarının çekilip çalıştırılması; proje sitesinin güncellenmesi.

## 0.5.0'dan sonra: yeniden boyutlandırmada kota — 2026-11-21

0.5.0'ın "bilinip düzeltilmeyen" tek maddesi kapatıldı. 0.5.1 sürümündedir (`CHANGELOG.md`).

**Kusur.** `POST /api/servers/:id/resize` kotayı kilitsiz okuyup işlemi ayrı bir adımda yazıyordu ve kullanım
(`usageOf`) sunucu satırlarından toplandığı için ancak worker boyutu değiştirince artıyordu. Aynı hesabın (ya da
kendi kotası olan aynı projenin) iki sunucusu aynı anda, hatta biri ötekinden dakikalar sonra ama ilki bitmeden
büyütülürse, ikisi de aynı boş yere karşı ölçülüp kabul ediliyordu. Aynı sunucunun iki isteği zaten
`OPERATION_IN_PROGRESS` ile ayrılıyordu; kusur farklı sunucular arasındaydı.

**Düzeltme** (`apps/api/src/servers.ts`, `apps/api/src/catalog.ts`), ek diskteki (`545b686`) kilidin aynısıyla:

- Boyut büyütme, işlem satırını yazan işlemin içinde ve **sahibin satırı kilitliyken** (`users … FOR UPDATE`;
  siparişin ve ek diskin saydığı kilit) kotaya karşı yeniden ölçülür (`startOperation`'ın `admit` adımı,
  `admitGrowth`). Proje bir hesabındır, yani proje kotası da aynı kilidin altındadır.
- **Kabul edilmiş, bitmemiş büyütme kullanıma sayılır:** `usageOf`, açık (`pending` / `running`) bir `resize`
  işlemi olan sunucuyu büyüyeceği boyutla toplar. Satır yeni boyutu alınca fark sıfırlanır (iki kez sayılmaz);
  işlem başarısız olunca yer geri döner. Aynı sayım siparişte, ek diskte, fiyat teklifinde, proje listesinde ve
  personelin Kotalar listesinde kullanılır; yani bekleyen bir büyütmenin yerini sonraki sipariş de alamaz.
- Sığmayan istek kotanın kendi koduyla reddedilir (`409 QUOTA_EXCEEDED` ya da `409 PROJECT_QUOTA_EXCEEDED`), 500
  değil; hiçbir şey yazılmaz (fiyat, paket, fatura). Aynı sunucuya ikinci istek eskisi gibi
  `409 OPERATION_IN_PROGRESS` alır, kota dolu olsa bile.

**Boyut değiştiren yollar ve hangisinin kapsandığı:**

| Yol | Durum |
|-----|-------|
| Müşteri, bayi (müşterisi adına), personel ve API anahtarı: `POST /api/servers/:id/resize` (tek uç nokta) | Kilitli denetimden geçer |
| Personelin başarısız bir büyütmeyi yeniden denemesi: `POST /api/admin/operations/:id/retry` | Artık aynı kilit altında yeniden kabul edilir; yer başka şeye verildiyse `QUOTA_EXCEEDED` (önceden hiç ölçülmüyordu) |
| Faturalama entegrasyonu: `POST /api/admin/external/:source/servers/:reference/resize` | Bilerek kota dışı (siparişi de öyle); değişmedi. Yaptığı büyütme, açıkken hesabın kullanımına sayılır |
| Ek disk (`545b686`), sipariş | Zaten aynı kilidin altındaydı; artık bekleyen büyütmeleri de sayarlar |
| Sanal veri merkezindeki sunucu | `VDC_SERVER` ile reddedilir; VDC'nin kendi sınırı ayrı bir konudur |
| "Boşta sunucu" / küçültme önerileri (içgörüler) | Yalnızca öneridir; uygulayan bir yol yok, kullanıcı aynı uç noktayı çağırır |
| İçe aktarma (`import.ts`, disk boyutunu VM'den okur) | Personel işi, kota ölçmez; değişmedi |

**Bu commit'te (`04212c3`) kapsanmayan, aynı türden iki pencere (sonraki commit'te kapatıldı):** konumun boş
kapasitesi (`capacityOf` / `reservedFor`) ve bayinin tahsisi (`checkResellerRoom`) boyut büyütmede kilitsiz
okunuyor ve bekleyen büyütmeleri saymıyordu; aynı anda iki büyütme konumun ya da bayinin son yerini birlikte
alabiliyordu. Düzeltmesi: [konum kapasitesi ve bayi tahsisi](#050dan-sonra-boyut-büyütmede-konum-kapasitesi-ve-bayi-tahsisi--2026-11-21).

**Denenenler.**

- Yeni entegrasyon dosyası `apps/api/test/integration/resize-quota.test.mjs` (4 test, gerçek PostgreSQL ve Redis,
  worker yok):
  1. 20 vCPU kotalı hesapta dört küçük sunucu (8 vCPU) aynı anda büyük pakete (+6) istenir: her biri tek başına,
     ikisi birlikte sığar, üçü sığmaz. **Tam iki** `202`, iki `409 QUOTA_EXCEEDED` (`vcpu`); iki açık işlem;
     reddedilenin fiyatı ve paketi aynı; kullanım 20 görünür (satırlar hâlâ 2'şer vCPU); sonraki büyütme ve
     sipariş reddedilir.
  2. Başarısız olan büyütmenin yeri geri gelir (14), başka sunucu o yeri alır, personelin yeniden denemesi
     `409 QUOTA_EXCEEDED` alır ve işlem `failed` kalır; biten büyütme iki kez sayılmaz; kota genişleyince yeniden
     deneme kabul edilir.
  3. Kendi kotası (10 vCPU) olan projenin iki sunucusu aynı anda: bir `202`, bir `409 PROJECT_QUOTA_EXCEEDED`;
     aynı hesabın proje dışındaki sunucusu hesabın kotasıyla büyür.
  4. Aynı sunucuya aynı anda iki istek, kota yalnızca birine yeterken: bir `202`, bir `409 OPERATION_IN_PROGRESS`.
- **Düzeltmeden önceki kodla** (yalnızca `apps/api/src` geri alınarak, aynı test dosyası): 4 testin 4'ü kaldı;
  birincide dört isteğin dördü de `202` döndü, üçüncüde ikisi de.
- **Yerelde, düzeltilmiş kodla** (geliştirme makinesi, Docker yok; PostgreSQL 18.6 ve Redis 8.0.5 WSL içinde geçici
  dizinden, iş bitince silindi): API birim testleri 206/206, `tsc` temiz; entegrasyon paketinin tamamı
  (`npm run test:integration`, 27 dosya) 273 testte **204 geçti, 0 başarısız, 69 atlandı** (63'ü simülatör isteyen
  `servers.test.mjs` ve benzerleri, 6'sı `seeded-history`); içinde `resize-quota` 4/4, `project-quota` 4/4,
  `security-servers` 14/14. `security-servers` içindeki "yeniden denenen boyut değişikliği" testi ilk çalıştırmada
  kaldı: hesabı önceki testlerden varsayılan kotanın üstünde sunucu taşıyordu ve yeniden deneme artık kotaya
  tabi; teste, dosyanın başka bir testinin de yaptığı gibi sınırsız hesap kotası eklendi. Worker ve web'e
  dokunulmadı, testleri yerelde yeniden çalıştırılmadı.
- **GitHub CI, elle tam çalıştırma `44911238990` (`04212c3`):** bütün işler geçti. `api-integration` 273 testte
  204 geçti, 0 başarısız, 69 atlandı (`resize-quota`'nın dört testi içinde); `compose` işindeki tarayıcı paketi
  44/44 (15,3 dk).
- **Demo sunucusu (`04212c3`):** `/root/demo-e2e.sh` demo'yu bu commit'e güncelledi (`OK UPDATED`), atılabilir
  yığında tarayıcı paketi **44/44** (17,7 dk); testler boyunca demo `/api/ready` 55 yanıtın 55'inde 200, sonrasında
  200; test yığınından geriye 0 kapsayıcı, 0 birim kaldı. Demo `v0.5.0-2-g04212c3` gösterdi. Etiket ya da sürüm
  oluşturulmadı; `stable` kanalındaki gece güncellemesi, çalışan commit `v0.5.0`'ın ilerisinde olduğu için yerinde
  kalır ("kanalın son sürümü bundan eski").

**Çalıştırılmayanlar:** gerçek bir hipervizörde (ya da simülatörde worker ile) iki büyütmenin sonuna kadar
gitmesi; testte işlemler açık kalır ve worker'ın yaptığı (satırı güncellemek, başarısızlıkta fiyatı geri almak)
SQL ile taklit edilir. Simülatör isteyen `servers.test.mjs` yerelde atlandı (Docker yok), CI'da çalışır.

## 0.5.0'dan sonra: boyut büyütmede konum kapasitesi ve bayi tahsisi — 2026-11-21

Bir önceki bölümün açık bıraktığı iki pencere kapatıldı. 0.5.1 sürümündedir (`CHANGELOG.md`).

**Kusur.** Konumun boş kapasitesi ve bayinin tahsisi hesaplar arasında sayılır. Boyut büyütme ikisini de kilitsiz
okuyordu ve ikisi de (`reservedFor`, `resellerUsage`) sunucu satırlarından toplandığı için kabul edilmiş, bitmemiş
büyütmeyi saymıyordu. `04212c3`'ün sahip kilidi yalnızca aynı hesabın isteklerini sıraya sokar: iki ayrı hesabın
(ya da bir bayinin iki müşterisinin) aynı anda istediği iki büyütme aynı boş yere karşı ölçülüp ikisi de kabul
ediliyordu.

**Önceden hangi yol neyi kilitliyordu.**

| Yol | Konum kapasitesi | Bayi tahsisi |
|-----|------------------|--------------|
| Sipariş | Konum satırı (`resource_pools … FOR UPDATE`) kilitliyken sayıyordu: sağlam | Yalnızca siparişi verenin hesabı ve konum kilitliydi; bayinin iki müşterisi **iki ayrı konumda** aynı anda sipariş verince tahsis kilitsiz sayılıyordu |
| Ek disk | Kilitsiz | Kilitsiz |
| Boyut büyütme, personelin yeniden denemesi | Kilitsiz, bekleyen büyütme sayılmıyor | Kilitsiz, bekleyen büyütme sayılmıyor |

**Düzeltme** (`apps/api/src/servers.ts`, `catalog.ts`, `reseller.ts`, `disks.ts`):

- **Tek kilit sırası**, yer sayıp sonra o yeri alan her işlem için (sipariş, ek disk, kabul edilen boyut büyütme,
  personelin yeniden denemesi): **1. sahibin hesabı** (`users`), **2. sunucunun satırı** (`servers`),
  **3. konum** (`resource_pools`), **4. bayinin satırı** (`resellers`). Bir işlem gerekenleri alır, hiçbirini
  sıradaki bir sonrakinden sonra almaz; iki işlem birbirini bekleyemez. Sipariş zaten 1 → 3 alıyordu, 4 eklendi
  (tek satır); ek disk 1 → 2 alıyordu, 3 ve 4 eklendi; boyut büyütme ve yeniden deneme dördünü de alır
  (`admitGrowth` / `admitRoom`). VDC oluşturma ve değiştirme yalnızca 3'ü alır; bayiden ayrılma müşterilerin
  hesaplarını, sonra sunucularını kilitler (1 → 2), sıraya uyar.
- **Bekleyen büyütme iki yerde de sayılır:** konumun "rezerve"si ve bayinin kullanımı, açık (`pending` /
  `running`) `resize` işlemi olan sunucuyu büyüyeceği boyutla toplar (kotadaki sayımın aynısı, `openResize`).
  Satır yeni boyutu alınca iki kez sayılmaz; başarısız olunca yer geri döner.
- **Gösterilen sayılar kabulün kullandığı sayılardır:** konum listesindeki "rezerve" ve "kalan satılabilir",
  `lightning_pool_capacity` ölçümleri, içgörüler, müşterinin paket uygunluğu, bayinin özeti ve personelin bayi
  listesindeki kullanım aynı işlevlerden gelir; ayrı bir "gösterim" toplamı yoktur.
- Sığmayan istek mevcut kodlarla reddedilir (`409 CAPACITY_EXHAUSTED`, `409 RESELLER_ALLOCATION_EXCEEDED`), 500
  değil; hiçbir şey yazılmaz. Aynı sunucuya ikinci büyütme eskisi gibi `409 OPERATION_IN_PROGRESS` alır.
- Faturalama entegrasyonunun büyütmesi kota dışıdır ama konum kapasitesine ve bayi tahsisine eskisi gibi tabidir;
  artık o da kilitli sayılır. Personelin yeniden denemesinde faturası dışarıda kesilen sunucu da kapasiteye tabidir.

**Denenenler.**

- Yeni entegrasyon dosyası `apps/api/test/integration/resize-capacity.test.mjs` (4 test, gerçek PostgreSQL ve
  Redis, worker yok; üç konum):
  1. 14 vCPU'luk konumda **iki ayrı hesabın** birer küçük sunucusu (4 vCPU) aynı anda +6 ister: bir `202`, bir
     `409 CAPACITY_EXHAUSTED`; reddedilenin fiyatı ve paketi aynı; konum listesi rezerveyi 10, kalanı 4
     gösterir (satırlar hâlâ 2'şer vCPU); sonraki büyütme ve 8 vCPU'luk sipariş reddedilir; büyüyen sunucuya
     ikinci istek `OPERATION_IN_PROGRESS`; büyütme başarısız olunca yer geri gelir, öteki sunucu alır, personelin
     yeniden denemesi `409 CAPACITY_EXHAUSTED` alır ve işlem `failed` kalır.
  2. 10 vCPU tahsisli bayinin iki müşterisi, **iki ayrı konumda**, aynı anda +6 ister: bir `202`, bir
     `409 RESELLER_ALLOCATION_EXCEEDED` (`vcpu`); bayinin özeti ve personelin bayi listesi kullanımı 10 gösterir;
     başarısızlıkta yer geri gelir, öteki müşteri alır, yeniden deneme tahsise takılır.
  3. Bayinin iki müşterisi iki ayrı konumda aynı anda sipariş verir, tahsiste bir sunucu yeri varken: bir `202`,
     bir `409 RESELLER_ALLOCATION_EXCEEDED`.
  4. İki ayrı hesap, 150 GB yeri kalan konumda aynı anda 100 GB'lık ek disk ister: bir `202`, bir
     `409 CAPACITY_EXHAUSTED`; tek disk satırı.
- **Düzeltmeden önceki kodla** (`04212c3`; yalnızca `apps/api/src` geri alınarak, aynı test dosyası): 4 testin 4'ü
  kaldı, dördünde de iki istek birden `202` döndü.
- **Yerelde, düzeltilmiş kodla** (geliştirme makinesi, Docker yok; PostgreSQL 18.6 ve Redis 8.0.5 WSL içinde geçici
  dizinden, iş bitince silindi): API birim testleri 206/206, `tsc` temiz; entegrasyon paketinin tamamı
  (`npm run test:integration`, 28 dosya) 277 testte **208 geçti, 0 başarısız, 69 atlandı** (63'ü simülatör isteyen
  `servers.test.mjs` ve benzerleri, 6'sı `seeded-history`); içinde `resize-capacity` 4/4, `resize-quota` 4/4,
  `project-quota` 4/4, `security-servers` 14/14. Var olan hiçbir testin değişmesi gerekmedi. Worker ve web'e
  dokunulmadı, testleri yerelde yeniden çalıştırılmadı.
- **GitHub CI, elle tam çalıştırma `44928387319` (`fdb2b04`):** üçüncü denemede yeşil. İlk iki denemede `compose`
  işindeki tarayıcı paketinden birer test kaldı, ikisi de bu commit'in dokunmadığı `apps/web` içinde: 1. denemede
  "tour of the newer screens" (saat dilimi seçeneği tıklanırken DOM'dan ayrıldı; 42 geçti, 1 kaldı, 1 çalışmadı),
  2. denemede "every page fits 390 px" (`/admin/stats` 202 px taştı; 37 geçti, 1 kaldı, 6 çalışmadı). Öteki işler
  her denemede geçti. İkisinin nedeni ve düzeltmesi bir sonraki bölümdedir.
- **Demo sunucusu (`fdb2b04`):** `/root/demo-e2e.sh` demo'yu bu commit'e güncelledi; atılabilir yığında tarayıcı
  paketi **44/44** (17,3 dk); testler boyunca demo `/api/ready` 54 yanıtın 54'ünde 200. Etiket ya da sürüm
  oluşturulmadı.

**Bilinen ve dokunulmayan:** bayinin kullanımındaki disk toplamı (`resellerUsage`) sunucuların sistem diskini
sayar, **ek diskleri saymaz** (bu değişiklikten önce de böyleydi). Ek disk eklenirken tahsise karşı ölçülür ama
eklendikten sonra kullanımda görünmez; yani bayinin disk tahsisi ek disklerle aşılabilir. Düzeltmek, ek diski olan
bayilerin gösterilen kullanımını yükseltir ve bazılarını tahsisin üstüne çıkarabilir; ayrı bir karar olduğu için
yapılmadı.

**Çalıştırılmayanlar:** gerçek bir hipervizörde ya da simülatörde worker ile büyütmenin sonuna kadar gitmesi
(testte worker'ın yaptığı SQL ile taklit edilir); kilit sırasının yük altında, çok sayıda eşzamanlı istekle
denenmesi (testler ikişer istekle çalışır; kilitlenme olmadığı sıranın kendisinden çıkarılır, ölçülmedi).

## 0.5.0'dan sonra: istatistik sayfasının telefonda taşması ve iki kararsız tarayıcı testi — 2026-11-21

CI çalıştırması `44928387319` (`fdb2b04`) ilk iki denemesinde birer tarayıcı testinden kaldı, üçüncüde geçti; demo
sunucusundaki paket aynı commit'te 44/44 geçti. Commit `apps/web` altında hiçbir şeyi değiştirmediği için ikisi de
aralıklıydı. İkisinin de nedeni bulundu; biri arayüzde gerçek bir kusur, öteki testin kendisinde. 0.5.1 sürümündedir
(`CHANGELOG.md`).

**1. `/admin/stats` 390 px'te 202 px taşıyor: arayüz kusuru, ve onu göremeyen test.**

- *Kusur* (`apps/web/app/(panel)/admin/stats/stats.tsx`, son ızgara): "En büyük müşteriler" ve "İnsanlar ne zaman
  işlem yapıyor" kartları dar ekranda tek sütunlu bir ızgaradadır. Sütun tanımsızdı (`xl:` altında `grid-cols` yok),
  tanımsız sütun da en geniş içeriği kadar genişler. Isı haritası 34rem (544 px) genişliğindedir ve kendi kartının
  içinde yana kaysın diye `overflow-x-auto` içine konmuştur; ama kaydırma kutusu kartın içinde, ızgara öğesinin
  kendisinde değildir, bu yüzden sütunu 544 + 32 px'e genişletti: 16 px kenar boşluğuyla 592 px, yani 390 px'lik
  ekranda **202 px** taşma. Sayfa veri gelir gelmez her seferinde taşıyordu; aralıklı olan sayfa değil testti.
- *Test neden görmüyordu* (`apps/web/e2e/app.spec.ts`, `expectNoOverflow`): "every page fits" testi her sayfada
  yalnızca başlığı (`h1`) bekleyip ölçüyordu. Başlık sunucunun gönderdiği HTML'dedir; kartlar, grafikler ve
  tablolar API yanıtlarıyla gelir. Arada ölçülen genişlik yer tutucuların genişliğidir (istatistik sayfasında beş
  gri kutu, taşma 0). Test ancak yanıt ölçümden önce yetiştiğinde kalıyordu; 2. denemede olan budur.
- *Düzeltme, arayüz:* ızgaraya `grid-cols-1` (`minmax(0, 1fr)`: sütun içeriğinden dar olabilir; geniş ekranın iki
  sütunu zaten böyleydi). Isı haritası artık kartının içinde kayar. Aynı sayfanın grafik ve döküm ızgaralarına da
  aynı sütun verildi (uzun bir konum ya da imaj adı aynı yoldan taşırabilirdi). Geniş ekranlarda görünüm aynıdır.
- *Düzeltme, test:* `watchApi(page)` sayfa bir şey yüklemeden önce çağrılır ve her belgenin kendi API çağrılarını
  (`fetch`) saydırır; `expectNoOverflow` ölçmeden önce sayfanın dinlemeye başlamasını, açık çağrı kalmamasını ve
  400 ms boyunca yenisinin başlamamasını bekler (bir yanıt çoğu kez bir sonraki çağrıyı başlatır). Hiç bitmeyen
  canlı olay akışı `fetch` olmadığı için sayılmaz. Bekleme 15 sn'de bitmezse test açık kalan çağrıların adıyla
  kalır. Ölçülen genişlik sınırı (1 px) değişmedi. Test artık 57 sayfanın her birinde içeriği beklediği için
  uzadı (geliştirme makinesinde 66 sn → 90-118 sn); süre sınırı 200 sn'den 300 sn'ye çıkarıldı. Bu, bir kararsızlığı
  örtmek için değil, eklenen işin süresi içindir.
- *Yeniden üretme* (geliştirme makinesi, Docker yok: PostgreSQL 18.6 ve Redis 8.0.5 WSL içinde geçici dizinden,
  API ve `next build`/`next start` Windows'ta, önlerinde Caddy'nin yaptığını yapan küçük bir vekil; simülatör ve
  worker yok, veritabanı neredeyse boş; kurulu Chrome ile):
  - Düzeltmeden önce, yalnızca bu sayfa: 5 çalıştırmanın 5'inde başlık göründüğünde taşma 0 (5 yer tutucu), veri
    geldikten sonra **202 px**. Düzeltmeden sonra: 20 çalıştırmanın 20'sinde 0.
  - Paketin kendi testi, yeni bekleyişle, **eski** arayüze karşı: `/admin/stats at 390 px … Received: 202`, CI'daki
    iletinin aynısı (üç çalıştırmadan sayfaya ulaşan birinde; öteki ikisi daha önce, oturum açma adımında kaldı,
    aşağıya bakın). Eski test aynı (düzeltilmiş) derlemede 66 sn'de geçiyordu.
  - Yeni test, düzeltilmiş arayüze karşı: 390 px beş kez art arda 5/5; 390, 768 ve 1920 px birlikte iki kez 3/3.
    Yerelde ölçülen öteki 56 sayfanın hiçbiri içeriğiyle taşmadı; ama bu veritabanı neredeyse boştur, CI ve demo
    önceki testlerin bıraktığı veriyle ölçer.

**2. "tour of the newer screens": saat dilimi seçeneği tıklanırken DOM'dan ayrılıyor: test kusuru.**

- *Neden:* saat dilimi alanı yazdıkça süzen bir listedir (React Aria `ComboBox`). Listesi 150 ms'lik bir girişle
  açılır ve bir seçim kutusununkinden farklı olarak arkasındaki sayfanın kaymasını engellemez; React Aria böyle
  bir listeyi, sayfa kayar kaymaz kapatır ve yazılanı geri alır (`useCloseOnScroll`). Test yazıp hemen seçeneğe
  tıklıyordu. Liste hâlâ girerken tıklanan seçenek Playwright için "not stable"dır; Playwright yeniden dener ve
  üçüncü denemesinde seçeneği önce pencerenin ortasına kaydırır (`scrollIntoView({ block: 'center' })`). Sayfa
  kaydı (ölçülen: `scrollY` 0 → 156), liste kapandı, alan eski değerine döndü, seçenek DOM'dan ayrıldı ve onu
  yeniden açan bir şey olmadığı için tıklama 20 sn sonra zaman aşımına uğradı. Liste girişini bitirmişse ilk
  deneme tutar ve hiçbir şey kaymaz; bu yüzden aralıklıdır.
- *Arayüzde kusur var mı:* hayır. Şüphelenilen iki şey ölçüldü ve hiçbiri listeyi kapatmıyor: sunucudan gelen
  yeniden çizim (`router.refresh`, liste açıkken gelsin diye 2,2 sn geciktirilerek) ve "kaydedildi" bildiriminin
  kapanması: 3 çalıştırmanın 3'ünde liste ikisinden sonra da açık ve yazılan yerinde kaldı. Sayfa kayınca listenin kapanması React Aria'nın
  bütün açılır listelerde bilinçli davranışıdır. Bir kişi listeyi görmeden tıklayamaz; yarış yalnızca listenin
  açıldığı anda tıklayan bir otomasyonda vardır.
- *Düzeltme* (`apps/web/e2e/app.spec.ts`, `pick`): yazar, seçeneğin görünmesini ve listenin girişinin bitmesini
  (`[data-trigger="ComboBox"][data-entering]` kalmaması) bekler, sonra tıklar. Aynı adımı atan iki kota testi
  ("Scope" alanı) de bunu kullanır. Yeniden deneme, zaman aşımı ya da atlama eklenmedi.
- *Yeniden üretme* (aynı yerel yığın, testin kendi adımlarıyla): düzeltmeden önce 20 çalıştırmanın **4'ü** kaldı
  (3'ü "Automatic", 1'i "Istanbul" tıklamasında), hepsi CI'daki izle: iki kez "element is not stable", sonra
  "element was detached from the DOM"; bir başka 10 çalıştırmada 2.'si aynı biçimde kaldı. Düzeltilmiş adımlarla
  30 çalıştırmanın 30'u geçti.
- *Doğrulanamayan:* CI'daki kayıtta üçüncü denemenin kaydırması görünmüyor (seçenek, üçüncü deneme daha
  beklerken ayrılmış). Yerelde her kalışta kapanmayı başlatan Playwright'ın kendi kaydırmasıydı; CI'da sayfayı
  neyin kaydırdığı (ya da listeyi başka neyin kapattığı) o çalıştırmanın izleri yüklenmediği için görülemedi.
  İşlemci dört kat yavaşlatıldığında 12 çalıştırmanın hiçbiri kalmadı (yavaş makinede yazma, girişten uzun
  sürüyor). Düzeltme yerelde görülen yolu kapatır; CI'daki kalışın tam olarak aynı yol olduğu **doğrulanmadı**.

**Bu sırada görülen, dokunulmayan:** yerel tekrarlarda bir test kaldıktan sonra yeni işçi yeniden oturum açarken
iki kez `/login`'de kaldı ya da oturum açıldıktan sonra sayfa değişti (3 çalıştırmanın 2'si). Paketin olağan
akışında yönetici bir kez oturum açar ve çerezi paylaşılır; CI'da görülmedi, nedeni araştırılmadı.

**Çalıştırılmayanlar:** tarayıcı paketinin tamamı yerelde çalıştırılamadı (Docker yok: kurulum sihirbazı,
simülatörler ve worker gerektirir); yerelde yalnızca "every page fits" testleri ve saat dilimi adımları koştu.
"Scope" alanını kullanan iki kota testi ve "tour" testinin tamamı yalnızca CI'da ve demo sunucusunda çalışır.

**CI'da ve demo sunucusunda (`d02008c`, bu bölümün commit'i):**

- **GitHub CI, elle tam çalıştırma `44948792934` (`d02008c`):** ilk denemede yeşil, bütün işler geçti; `compose`
  işindeki tarayıcı paketi 44/44 (15,2 dk). Yeniden deneme yapılmadı.
- **Demo sunucusu (`d02008c`):** `/root/demo-e2e.sh` demo'yu bu commit'e güncelledi; atılabilir yığında tarayıcı
  paketi **44/44** (19,2 dk); testler boyunca demo `/api/ready` 59 yanıtın 59'unda 200.
- Tek bir yeşil çalıştırma, aralıklı bir kalışın bittiğini kanıtlamaz: iki kalışın yerelde görülen yolu kapatıldı,
  CI'da aynı testler bu commit'te bir kez çalışıp geçti.

## 0.5.1 (beta) sürümü — 2026-11-22

`v0.5.1` etiketi `da84d05` commit'indedir (açıklamalı etiket). İçinde 0.5.0'dan sonraki üç düzeltme vardır
(yukarıdaki üç bölüm); `da84d05` yalnızca sürüm numaralarını ve belgeleri değiştirir. Etiket, o commit denendikten
sonra kondu:

- **GitHub CI, elle tam çalıştırma `45060050005` (`da84d05`):** ilk denemede yeşil, bütün işler geçti; yeniden
  deneme yapılmadı. `api-integration` 277 testte 208 geçti, 0 başarısız, 69 atlandı; `compose` işindeki tarayıcı
  paketi 44/44 (14,5 dk); birim işleri, altı adaptör, iki Go servisi, 11 imaj derlemesi. (Aynı commit'in `push` ile
  başlayan çalıştırması `45060048822` iptal edildi: bir saniye sonra başlatılan elle çalıştırma onun yerini aldı.)
- **Demo sunucusu (`da84d05`), etiketten önce:** `/root/demo-e2e.sh` demo'yu bu commit'e güncelledi (`OK UPDATED`,
  derleme ve başlatma 2 dk 41 sn), atılabilir yığında tarayıcı paketi **44/44** (18,5 dk); testler boyunca demo
  `/api/ready` 57 yanıtın 57'sinde 200, sonrasında 200; test yığınından geriye 0 kapsayıcı, 0 birim kaldı. 0.5.0'dan
  farklı olarak paket bu commit'te demo'da bir kez çalıştırıldı, art arda iki kez değil.
- **Etiket:** `origin`'e ve test sunucusunun deposuna yalnızca `refs/tags/v0.5.1` gönderildi. Test sunucusunun
  deposundaki öteki etiketler (`v0.1.0`-`v0.5.0`, eski iç test etiketleri dahil) gönderimden önce ve sonra
  karşılaştırıldı: değişmedi; hiçbiri GitHub'a gitmedi (GitHub'daki etiketler `v0.1.0`, `v0.4.0`, `v0.5.0`,
  `v0.5.1`).
- **Yayın iş akışı `45062729099`:** ilk denemede geçti: birim işleri, 11 imaj
  (`ghcr.io/syildirim689/lightning-vm/*:v0.5.1`) ve sürüm sayfası. Sayfa "Lightning VM v0.5.1 (beta)" adıyla ve
  **pre-release** işaretiyle oluştu; notları `CHANGELOG.md` dosyasının 0.5.1 bölümüdür (satır satır karşılaştırıldı).
  GitHub'daki üç sürümün üçü de pre-release olduğu için hiçbiri "latest" işaretli değildir; liste en üstte 0.5.1'i
  gösterir.
- **Demo `v0.5.1` gösteriyor:** etiket konduktan sonra aynı commit için `install.sh update --to v0.5.1`
  çalıştırıldı; yapacak bir şey yoktu (`OK UP_TO_DATE Up to date: v0.5.1`) ve ad yenilendi: `.env` içinde ve API ile
  web kapsayıcılarında `APP_VERSION=v0.5.1`, `git describe` `v0.5.1`, `/api/ready` 200, öncesindeki gibi 24
  kapsayıcı çalışıyor. (Etiketten önce panel `v0.5.0-5-gda84d05` gösteriyordu.) Yedek, derleme ya da migration
  çalışmadı; veritabanına dokunulmadı.
- **Çalıştırılmayanlar:** temiz bir makinede `curl … | sudo sh` ile 0.5.1 kurulumu ve kimliksiz yeni bir kopyada
  kurulumun `v0.5.1`'i seçtiğinin denenmesi; 0.5.0 kurulu, verisi olan gerçek bir panelin 0.5.1'e güncellenmesi
  (demo yerinde güncellendi ama orada açık boyut büyütme yok); yayımlanan `ghcr.io` imajlarının çekilip
  çalıştırılması; panele tarayıcıdan oturum açıp gösterilen sürümün gözle görülmesi (ad kapsayıcıların ortam
  değişkeninden okundu); proje sitesinin güncellenmesi (site sürüm numarası yazmaz). Üç düzeltmenin kendi
  bölümlerindeki "çalıştırılmayanlar" aynen geçerlidir.

## Yönetim → Sistem: sürüm listesi, servislerin ayrıntısı ve yeniden başlatma, hareketli grafikler — 2026-11-23

Sahibin bildirdiği üç kusur (`b467a5f`, test düzeltmesi `e9bd7bc`). 0.6.0 sürümündedir (`CHANGELOG.md`).

**Bulunan nedenler:**
- *Sürümler eksikti:* `scripts/install.sh` `do_releases` etiketleri `head -n 10` ile en yeni ona kesiyordu; daha
  önemlisi liste (`data/maintenance/releases.json`) yalnızca panelden istenen "denetle" ya da güncelleme sonrasında
  yazılıyordu. Demo komut satırından (`install.sh update --to <commit>`) güncellendiği için listesi
  2026-11-16'dan kalmıştı ve `v0.3.0`'ı anlatıyordu (`current: v0.3.0-384-gfc25fdd`): `v0.4.0`, `v0.5.0`, `v0.5.1`
  hiç görünmüyordu. Kararlı kanalın `-rc` etiketlerini göstermemesi bilinçlidir.
- *`migrate Exited (0)`:* hangi servisin tek seferlik olduğu bilinmiyordu; sayfa Docker'ın ham durum metnini
  gösteriyor ve sınıflandırmayı ad ve metin üzerinden düzenli ifadeyle tarayıcıda yapıyordu. Ayrıntı, yeniden
  başlatma ve sürüm hiç yoktu; ajan sürüm, çıkış kodu, yeniden başlatma politikası ve bağlantı noktalarını
  toplamıyordu.
- *Grafikler:* her yoklamada çizgi yerinde yeniden çiziliyordu; giriş, geçiş ve üzerine gelme yoktu.

**Çalıştırılanlar:**
- **API birim testleri:** 214/214 (yeni `host-services.test.mjs` 8/8: tek seferlik işin tanımdan anlaşılması, durum
  sınıflandırması, eski anlık görüntüyle geriye uyum, sürümler, servis başına kurallar, izin listesi ve
  reddedilenler, günlük maskeleme). **Web birim testleri** 131/131, `check-messages` (TR/EN anahtarları eşit),
  `next build` başarılı. `shellcheck -s sh scripts/install.sh` temiz (demo sunucusundaki shellcheck'e stdin ile).
- **Entegrasyon (geliştirme makinesi, Docker yok; PostgreSQL 18.6 ve Redis 8.0.5 WSL içinde geçici dizinden, iş
  bitince silindi):** yeni `service-restart` 5/5 (izin, istek dosyası, denetim kaydı, izin listesi, postgres/redis/
  tek seferlik/compose dışı reddi, aynı anda tek iş, ayrıntı uç noktası ve maskeleme, eski liste uyarısı);
  dokunulan kodun `monitoring-switch` 4/4 ve `monitoring` 2/2.
- **Yerel tarayıcı denemesi** (API ve `next start`, önünde küçük bir vekil, elle yazılmış ajan anlık görüntüsü,
  kurulu Chrome): yeni tarayıcı testi tek başına geçti; "her sayfa 390 px'e sığar" ve izleme testleri geçti.
  Grafikler bu makinede ölçülemediği için (`/proc` yok) uydurulmuş bir geçmişle ayrıca bakıldı: ilk açılışta
  soldan çizim, her yoklamada çizgi grubunda tek adımlık kayma (`translateX`), üzerine gelince değer ve saat,
  azaltılmış hareket isteyen tarayıcıda hiç animasyon yok; her iki temada ekran görüntüsüne gözle bakıldı.
- **GitHub CI, elle tam çalıştırma `45073488387` (`b467a5f`):** **başarısız.** Yeni "Services snapshot, restart and
  refusals" adımı gerçek Docker'da geçti (anlık görüntüde migrate `exitCode 0`, `restartPolicy no`, `awaited 1`;
  simülatör `managed 0`; postgres, redis, migrate restart, worker run, compose dışı ve olmayan servis reddedildi;
  `service restart worker` ve `service run migrate` başarılı). Tarayıcı paketinde yeni test kaldı: onay iptal
  edildikten hemen sonra basılan Escape çekmeceye ulaşmadı (odak henüz dönmemişti), 30 geçti, 1 başarısız, 14
  çalışmadı. Test çekmeceyi kendi kapatma düğmesiyle kapatacak biçimde düzeltildi (`e9bd7bc`); düğme artık panelin
  dilinde adlandırılır. Escape'in onaydan hemen sonra çekmeceyi kapatmaması klavye için küçük bir kusur olarak
  kaldı, düzeltilmedi.
- **GitHub CI, elle tam çalıştırma `45075449200` (`e9bd7bc`):** ilk denemede yeşil, bütün işler geçti.
  `api-integration` 282 testte 213 geçti, 0 başarısız, 69 atlandı; `compose` işinde servis adımı yine geçti ve
  tarayıcı paketi **45/45** (14,6 dk).
- **Demo sunucusu:** `/root/demo-e2e.sh b467a5f`: güncelleme `OK UPDATED`, atılabilir yığında **45/45** (18,7 dk;
  yeni test burada geçti), demo `/api/ready` 58 yanıtın 58'inde 200, geriye 0 kapsayıcı, 0 birim. Sonra
  `/root/demo-e2e.sh e9bd7bc`: **45/45** (18,5 dk), `/api/ready` 57/57 200, sonrasında 200, geriye 0 kapsayıcı.
  İlk güncelleme henüz eski betikle çalıştığı için sürüm listesini yeniden yazmadı; ikincisi yeni betikle yazdı:
  `releases.json` artık `v0.5.1`, `v0.5.0`, `v0.4.0`, `v0.3.0`, `v0.2.3`, `v0.2.2`, `v0.2.1`, `v0.2.0`, `v0.1.1`,
  `v0.1.0` (on etiketin onu, yeniden eskiye), `base: v0.5.1`, `current: v0.5.1-3-ge9bd7bc`. `v0.1.1`-`v0.3.0`
  demo deposundaki eski iç test etiketleridir, GitHub'da yayımlanmadılar; panel sunucunun güncellendiği depodaki
  bütün `vX.Y.Z` etiketlerini listeler ve ada göre süzmez, bu yüzden demoda görünürler. Demo'da `install.sh state`
  elle bir kez çalıştırıldı: migrate `exitCode 0`, `restartPolicy no`, `awaited 1`; simülatörler `managed 0`;
  proxy `caddy:2-alpine`, sürüm etiketi `v2.11.7`. **Demo'da yalnızca bir servis yeniden başlatıldı:** `blackbox`
  (izlemenin dış erişim yoklayıcısı), `install.sh service restart blackbox` ile; `SERVICE_RESTARTED`, başlama
  zamanı 2026-11-20'den 2026-11-22T22:34'e değişti, `/api/ready` 200. `service restart postgres` aynı yerde
  `E_SERVICE_PROTECTED` ile reddedildi (hiçbir şey yapılmadı).
- **Proje sitesi** (`lightningvm-web-app`, ayrı worktree'den `9c0fabb`): "Yönetim paneli" ve "Kurulum, güncelleme ve
  yedek" sayfaları iki dilde; dört adres 200 ve yeni metni içeriyor.
- **Çalıştırılmayanlar:** panele tarayıcıdan oturum açıp yeniden başlatma isteğinin **ajan tarafından** alınıp
  yürütülmesi (ajan yolu komut satırından ve CI'da `install.sh service` ile denendi; panelin bıraktığı istek
  dosyası entegrasyon testinde okundu; ikisi arasındaki `run-requests` ayrıştırması gerçek bir sunucuda
  denenmedi); api, web ya da proxy'nin panelden yeniden başlatılıp sayfanın yeniden bağlanması; yeniden başlama
  döngüsü, `unhealthy` ve `paused` durumlarının gerçek bir kapsayıcıda görülmesi (yalnız birim testi ve
  hazırlanmış yanıtla tarayıcı testi); günlük maskelemenin gerçek servis günlüklerinde gözden geçirilmesi;
  saatlik zamanlayıcının listeyi günde bir yenilemesi (kod okundu, beklenmedi); grafiklerin Linux'taki gerçek
  geçmişle gözle görülmesi (CI ve demoda tarayıcı testi grafiğin üzerine gelip değeri okudu, ekrana bakılmadı).

## Önerilen adlar (passkey, TOTP etiketi, API anahtarı, SSH anahtarı ve diğerleri) — 2026-11-23

Ne değişti: [proposals.md](proposals.md). Formlar boş ad alanı yerine panelin önerisini yazar; doğrulama uygulaması ve
passkey yöneticisi panelin kendi adını ve hesabın e-postasını gösterir. 0.6.0 sürümündedir (`CHANGELOG.md`).

**Çalıştırılanlar:**
- **Web birim testleri** 142/142 (yeni `lib/proposals.test.ts` 11/11: gerçek kullanıcı ajanı tablosu, bilinmeyen
  ajanlar, `userAgentData` öncelikli, iPad'in Mac gibi görünmesi, güvenlik anahtarı/telefon, benzersizlik, Türkçe büyük
  harf karşılaştırması, uzunluk sınırları ve vekil çiftlerin bölünmemesi, sunucu adı kuralı, anlık görüntü adı kuralı,
  SSH parmak izi `ssh-keygen -lf` çıktısıyla aynı, iki dilde kelimelerin varlığı ve karışmaması),
  `check-messages` (TR/EN eşit), `message-scope` (yeni `Proposals` ad alanı genel sayfalara eklendi), `tsc` ve
  `next build` başarılı.
- **API birim testleri** 218/218 (yeni `labels.test.mjs` 4/4: yayımcı adının temizlenmesi, URI'nin etiket ve
  `issuer` parametresinde yüzde kodlaması, `+` olmaması, better-auth'un URI'sinin gizli anahtar/basamak/süre korunarak
  yeniden etiketlenmesi, WebAuthn seçeneklerinde `rp`/`user` değişip challenge ve kimliklerin kalması).
- **Entegrasyon** (geliştirme makinesi, Docker yok; PostgreSQL 18.6 ve Redis 8.0.5 WSL içinde geçici dizinden, iş
  bitince silindi): `platform.test.mjs` 42/42. Yeni denetimler: etkinleştirilen TOTP URI'si
  `otpauth://totp/Lightning%20VM:ayse%40example.test?secret=…&issuer=Lightning%20VM&digits=6`; markalama "Acme Cloud"
  yapıldıktan sonra passkey kayıt seçeneklerinde `rp.name` "Acme Cloud", `user.name` e-posta (istekte passkey adı
  gönderilse de); `update-passkey` sahibine açık ve adı değiştiriyor, başka bir hesap değiştiremiyor.
- **Yerel tarayıcı denemesi** (API, worker ve `next start`, önünde küçük bir vekil, kurulu Chrome, Windows): yeni
  "names are proposed…" testi (passkey önerisi ve ipucu; sahte bir USB güvenlik anahtarıyla kayıt: sunucunun gerçek
  seçeneklerinde `rp.name`/`user.name`, kayıttan sonra adın "Security key · Chrome · Windows" olması; API anahtarı
  adının erişimi izlemesi ve yazılınca durması; SSH anahtarı adının açıklamadan gelmesi; talep konusunun
  doldurulmayıp tek tıkla önerilmesi, 390 px), TOTP etiketi ve yedek kod dosya adı eklenen "second step at sign-in"
  testi, "a registered user gets…", güvenlik duvarı testi (elle eklenen kuralın "SSH" adını alması), "every page fits
  390 px" ve "a session that ends while something is typed…" geçti. Kurulum sihirbazı testi bu makinede izleme
  bileşenleri olmadığı için ilerleyemedi (değişiklikle ilgisiz); yönetici sihirbazın önceki adımlarıyla oluştu ve
  kayıt açma doğrudan veritabanından yapıldı.
- **GitHub CI, elle tam çalıştırma `45084842733` (`10dbe2e`):** ilk denemede yeşil, bütün işler geçti
  (`api-integration`, `compose` içindeki tarayıcı paketi dahil).
- **Demo sunucusu:** `/root/demo-e2e.sh 10dbe2e`: demo güncellendi (`/opt/lightning-vm` `10dbe2e`), atılabilir
  yığında **46/46** (18,6 dk; yeni test dahil), demo `/api/ready` testler sırasında 57 yanıtın 57'sinde 200, sonrasında
  200, geriye 0 kapsayıcı. Betiğin ekran çıktısı yanlışlıkla `/dev/null`'a yönlendirildi; sonuç `/opt/e2e/result.txt`
  ve `/opt/e2e/demo-ready.log`'dan okundu.
- **Çalıştırılmayanlar:** gerçek bir doğrulayıcıyla (Windows Hello, Touch ID, YubiKey, telefon) passkey kaydı —
  tarayıcı testinde `navigator.credentials` taklit edildi, doğrulama ve yeniden adlandırma çağrıları yakalandı; telefon
  ("hybrid") durumu yalnızca birim testinde; bir doğrulama uygulamasının (Google Authenticator vb.) QR kodunu okuyup
  adı nasıl gösterdiği gözle denenmedi (URI biçimi test edildi); macOS, iOS ve Android tarayıcılarında öneri metni;
  yönetim katalog formlarındaki (havuz, paket, imaj, IP havuzu, konum, ISO kaynağı, hazır yanıt, bağlantı) önerilere
  tarayıcıda ayrıca bakılmadı (mevcut testler bu formlara ad yazıyor ve geçti); TR arayüzde passkey önerisi yalnızca
  birim testinde.

## Canlı ekranlar (Sistem, İstatistikler, Enerji) — 2026-11-23

Ne değişti: [live-walls.md](live-walls.md). Yönetim → Sistem, İstatistikler ve Enerji'den açılan tam ekran, gerçek
zamanlı 3B ekranlar (three.js 0.187.0), aynı veriyle tasarlanmış bir 2B ekran, kalite katmanları ve çalışırken kare
süresi denetleyicisi; API'de `GET /admin/power` yanıtına `hosts[].lastAt`. 0.6.0 sürümündedir (`CHANGELOG.md`).

**Makine:** Windows 11 sanal makinesi, Intel Xeon E5-2699 v4 (4 vCPU), 16 GB; ekran bağdaştırıcısı "VMware SVGA 3D".
**Gerçek bir GPU yok:** Chrome 157 burada WebGL'i yalnız yazılımla çiziyor — bayraksız başsız modda SwiftShader
(bağlamı yalnız "ciddi performans uyarısıyla" veriyor), `--use-angle=d3d11 --ignore-gpu-blocklist` ile Microsoft
Basic Render Driver (WARP). Ekranın kendi seçimi iki durumda da doğru olarak **2B** (`software`). Aşağıdaki 3B ölçümleri
`?quality=…&hold=1` ile elle seçilmiş katmanlarda, WARP üzerinde alındı; bir GPU'daki kare hızını **göstermez**.

**Çalıştırılanlar:**
- **Web birim testleri** 166/166 (yeni: `wall-quality` 5, `wall-governor` 8, `wall-state` 7, `wall-poller` 4 —
  katman seçimi ve yazılım çizicisi tanıma, merdivenin yalnız eksiltmesi, 4K piksel sınırı; kayıtlı kare süresi
  dizileriyle denetleyici: 60 fps'ye dokunmaz, ısınma ve gizli sekme sayılmaz, 40 fps'de adım adım iner ve tutunur,
  saniyede 8 karede her pencerede bir adım iner sonra 2B'ye geçer, saniyede 1 karede doğrudan son adıma ve birkaç
  saniyede 2B'ye geçer, 30 fps katmanında 30 fps'ye dokunmaz, son adımda 25 fps'de 3B kalır, sekerek geri çıkarken
  bekleme iki katına çıkar; veri → sahne: arıza renk dışında da işaretli, bitmiş tek seferlik iş arıza değil, eski ve
  eksik veri canlı gibi çizilmez, Linux olmayan hostta sıfır yerine "yok", eski anlık görüntü; istatistik sırası kendi
  en yükseğine göre; enerji akışı gerçek watt'la ölçekli, son 15 dakikada örneği olmayan host akmaz, 24'ten fazla host
  toplanır; yoklayıcı: kaynak başına kendi hızı ve tek istek, gizliyken hiç istek yok, 2/4/8 kat geri çekilme, ret
  durdurur, durdurma iptal eder ve susturur), `check-messages` (TR/EN eşit, yeni `Wall` ad alanı), `icons --check`,
  `session-end` (üç yeni tercih anahtarı listede), `tsc` ve `next build` başarılı.
- **API birim testleri** 218/218, `tsc` temiz. `servers.test.mjs`'ye `lastAt` denetimi eklendi (simülatör ister;
  CI'da ve burada atlanır — aşağıda demo tarayıcı testi API'den okuyup denetler).
- **Paket boyutları** (`next build`, her rotanın istemci başvuru bildiriminden ilk JS'i; değişiklikten önceki commit
  `489ba52` ayrı bir çalışma ağacında aynı yolla derlendi):
  - three.js ve sahneler **hiçbir rotanın ilk JS'inde yok**; yalnız 3B çizilecekse yüklenen iki parça: 381 KB
    (91 KB gzip) ve 217 KB (57 KB gzip), enerji sahnesi ayrıca 12 KB.
  - `/wall/[scene]` ilk JS'i 822 KB (245 KB gzip); bunun yalnız ekrana ait kısmı 2 parça, 43,5 KB (14,4 KB gzip).
  - Diğer bütün rotalar: ham boyut **−317 bayt**, parça başına gzip toplamı +1,1…+1,25 KB (Turbopack ortak kök kodunu
    farklı parçalara böldü; içlerinde ekran kodu yok; `icons.json`'a 5 simge eklendi). Giriş düğmesi olan
    üç sayfa ayrıca ~+0,85 KB ham (/admin/system 377,0 → 378,6, /admin/stats 493,3 → 494,9, /admin/energy 476,2 →
    477,9 KB gzip).
- **Yerel yığın** (Docker yok; PostgreSQL 18.6 ve Redis 8.0.5 WSL içinde geçici dizinden; API WSL içinde Node 22 ile —
  `host/live` gerçek `/proc` okur —, `next start` ve küçük bir vekil Windows'ta; host ajanı anlık görüntüsü
  hazırlanmış bir `state.json`): giriş düğmesi Yönetim → Sistem'de "2 uyarı" yazısının 12 px solunda ve aynı satırda,
  İstatistikler ve Enerji'de başlık düğmelerinin başında; üç sayfa da 1920'de yatay kaymasız.
- **Tarayıcı testleri, yerelde** (`e2e/wall.spec.ts`, kurulu Chrome 157 başsız, SwiftShader): 4/4, iki kez üst üste
  (son kodla; daha önceki iki çalıştırma bulunan hataları gösterdi, aşağıda). Testler: düğmenin yeri ve etiketi üç sayfada; ekranın değerleri hazırlanmış `host/live` yanıtıyla
  (%42,5 / %75 / %60 / 1,25, 2 uyarı, iki arıza); WebGL'siz tarayıcıda 2B ekran nedeniyle ve **aynı değerlerle**,
  rafta ARIZA etiketi, migrate'in arıza sayılmaması; istatistik ve enerjinin gerçek yanıtı, enerjide örnek yoksa
  söylemesi, 503'te "Panel yanıt vermedi" ve "Yeniden dene"; 390 px'de yatay kayma yok, sahne üstte rakamlar altta;
  azaltılmış harekette `data-motion="still"`, karelerin çizilmesi ve kameranın 1,5 sn'de kıpırdamaması, Tur
  düğmesinin kapalı olması; → ile sonraki ekran ve yeni sahnenin **kendi bağlamıyla** çizmesi, Esc ile sayfasına
  dönüş ve ekranın açtığı **bütün WebGL bağlamlarının geri verilmiş** olması; müşteri hesabının üç ekranda da 403
  görmesi ve hiçbir şey çizilmemesi, API'nin üç okumayı 403 ile reddetmesi.
- **Kare süreleri** (WARP, yazılım; `hold=1`, örnek İstatistik/Enerji verisi, Sistem gerçek `/proc`; son 60 karenin
  ortalaması):

  | Boyut | Sahne | yüksek | orta | düşük |
  |---|---|---|---|---|
  | 1920×1080 | Sistem | 0,7 fps (1412 ms; 118 çağrı, 25 bin üçgen) | 1,2 fps (817 ms) | 1,8 fps (566 ms; 47 çağrı) |
  | 1920×1080 | İstatistik | 0,7 fps (1402 ms) | 1,3 fps (758 ms) | 2,0 fps (506 ms) |
  | 1920×1080 | Enerji | 0,8 fps (1178 ms; 43 bin üçgen) | 1,7 fps (586 ms) | 3,2 fps (309 ms) |
  | 390×844 | Sistem | 6,5 fps (154 ms) | 11,6 fps (86 ms) | 16,2 fps (62 ms) |
  | 390×844 | İstatistik | 6,1 fps (165 ms) | 10,8 fps (93 ms) | 16,6 fps (60 ms) |
  | 390×844 | Enerji | 7,4 fps (136 ms) | 16,2 fps (62 ms) | 32,3 fps (31 ms) |

  Denetleyici açıkken (elle `medium`, 1280×720) WARP'ta ilk saniyelerde son adıma iniyor (piksel oranı 0,55, bloom ve
  gölge yok) ve orada 11–15 fps'de kalıyor; elle seçilen katmanda 2B'ye geçmediği doğrulandı. Kendiliğinden seçimde
  bu makine hiç 3B'ye girmiyor.
- **10 dakikalık çalışma** (Sistem, elle `medium`, 1280×720, WARP, 5 sn'lik yoklama; her dakika zorla çöp toplamadan
  sonra): JS yığını 10,6 → 11,6 MB, DOM düğümü 241 → 245, dinleyici 434 → 443; three'nin GPU nesneleri baştan sona sabit
  (26 geometri, 13 doku, 33 gölgelendirici), 7 758 kare. Ekranlar arasında 12 geçiş (→; her geçişte bir motor kurulup bırakılıyor; azaltılmış hareket, düşük katman, SwiftShader): her an tek bir canlı WebGL bağlamı, açılan 26 bağlamın 25'i geri verilip çöp toplayıcıyla gitti; JS yığını 10,4 → 11,7 → 12,4 MB (geçiş başına ~170 KB; kaynağı bulunmadı), DOM düğümü 358 → 374. On dakikalık ölçümdeki +1 MB ve geçişlerdeki artışın saatler içinde durup durmadığı ölçülmedi.
- **Ekran görüntüleri:** `docs/screenshots/walls/` (10 dosya, liste [live-walls.md](live-walls.md)'de).
- **GitHub CI, elle tam çalıştırma `45104033887` (`ea4ba50`):** ilk denemede `compose` işi kaldı: ilk testte kurulum sihirbazının "Panel adresi" denetimi beklenen "Yerel adres; doğrulanamaz" satırını göstermedi, yönetici oluşmadığı için sonraki 11 test girişte kaldı (ekranlarla ilgisiz; aynı commit demoda geçti). Yalnız kalan iş yeniden çalıştırıldı: ikinci denemede 50/50, bütün işler yeşil. Neden kaldığı araştırılmadı.
- **Demo sunucusu:** `/root/demo-e2e.sh ea4ba50`: demo güncellendi (`/opt/lightning-vm` `ea4ba50`), atılabilir yığında **50/50** (19,4 dk; 4 yeni ekran testi dahil), demo `/api/ready` testler sırasında 60 yanıtın 60'ında 200, sonrasında 200, geriye 0 test kapsayıcısı.

**Bulunan ve düzeltilen hatalar** (bu iş sırasında, yayımlanmadan):
- three r187'de `PCFSoftShadowMap` kaldırılmış (uyarı veriyordu): tek filtreli gölge türü, "yumuşak" daha geniş yarıçap
  ve daha çok örnek.
- Azaltılmış hareket sunucuda bilinmediği için ilk HTML'de "hareketli" yazıyordu ve hidrasyon özniteliği düzeltmiyordu:
  tercih tarayıcıda yüklendikten sonra uygulanıyor.
- Sahne değiştirince (→) yeni motor, bir öncekinin geri verdiği bağlamla aynı tuvali kullanıyordu (çizemezdi; 5 sn
  sonra kendini yeniliyordu): her motora yeni tuval; tarayıcı testi yeni sahnenin bağlamının kayıp olmadığını denetliyor.
- Bir kalite adımı çizim tamponunu yeniden boyutlandırıp temizliyordu; yavaş cihazda bir kare boyunca siyah görünüyordu:
  adımdan hemen sonra çiziliyor.
- Çizim çağrısı sayacı yalnız son geçişi (ekrana kopya) sayıyordu: kare başına sayılıyor.
- Yazılım çizicisinde sahnenin kurulması (ortam haritası, gölgelendiriciler) sayfayı birkaç saniye tutabiliyor: ekrandan
  çıkarken önce sahne kaldırılıyor, sonra sayfaya gidiliyor.

**Çalıştırılmayanlar / doğrulanamayanlar:**
- **Gerçek bir GPU'da** hiçbir 3B ölçüm yapılmadı: 60 fps hedefi, yüksek katmanın 1080p ve 4K'da tutup tutmadığı,
  denetleyicinin gerçek bir GPU'da hangi adımda dengeye geldiği, ısınma süresi, bağlam kaybı ve geri gelişi (yalnız kod
  okundu; olay işleyicileri test edilmedi), uzun süre (saatler) açık kalan bir TV'de bellek ve sıcaklık. Görüntüler
  yazılım çizicisiyle, saniyede 1 karenin altında alındı; gerçek bir ekranda yumuşak bölgeler, bloom ve alan derinliği
  farklı görünebilir.
- **Gerçek bir TV**: 3 metreden okunabilirlik, 4K TV tarayıcıları, uzaktan kumandayla gezinme, ekran uyku kilidinin
  (Wake Lock) bir TV'de gerçekten tuttuğu, ekran yanığı. Wake Lock yalnız başsız Chrome'da istendi ve alındı.
- Tam ekran (Fullscreen API) başsız tarayıcıda denenmedi; F tuşu ve düğme yalnız kod olarak var.
- Safari/iOS, Firefox ve Android tarayıcıları; dokunmatik telefonda orta katmanın kendiliğinden seçilmesi (yalnız birim
  testi).
- Enerji ekranı yerelde gerçek güç örneğiyle görülmedi (yerel yığında VMware yok; ekran görüntüsü örnek veriyle). Demo'da
  simülatör örnekleriyle tarayıcı testi `hosts[].lastAt`'ı API'den okuyup denetler.
- 1920 px'de ekranlar "every page fits" döngüsüne eklenmedi (o test panelin menüsünü ölçüyor); 390 px ekran testinde
  ve yerel ekran görüntülerinde yatay kayma 0.

## 0.6.0 (beta) sürümü — 2026-11-23

`v0.6.0` etiketi `48cf206` commit'indedir (açıklamalı etiket). İçinde 0.5.1'den sonraki üç iş vardır (yukarıdaki üç
bölüm: Yönetim → Sistem'de sürümler, servisler ve grafikler; önerilen adlar; canlı ekranlar); `48cf206` yalnızca
sürüm numaralarını ve belgeleri değiştirir. Etiket, o commit denendikten sonra kondu:

- **GitHub CI, elle tam çalıştırma `45119101458` (`48cf206`):** ilk denemede yeşil, bütün işler geçti; yeniden
  deneme yapılmadı. `api-integration` 282 testte 213 geçti, 0 başarısız, 69 atlandı; `compose` işindeki tarayıcı
  paketi 50/50 (17,5 dk); birim işleri, altı adaptör, iki Go servisi, 11 imaj derlemesi. (Aynı commit'in `push` ile
  başlayan çalıştırması `45119089465` iptal edildi: elle çalıştırma onun yerini aldı.)
- **Kurulum sihirbazı testinin geçmişi:** `45104033887` (`ea4ba50`) ilk denemesinde `compose` işi, kurulum
  sihirbazının "Panel adresi" denetimi beklenen "Yerel adres; doğrulanamaz" satırını göstermediği için kalmış,
  yönetici oluşmadığından sonraki 11 test girişte kalmıştı; yeniden denemede geçmişti. Bu sürümün çalıştırmasında
  aynı test ilk denemede geçti. Neden araştırılmadı ve bulunmadı; bir yeşil çalıştırma aralıklı kalışın bittiğini
  göstermez.
- **Demo sunucusu (`48cf206`), etiketten önce:** `/root/demo-e2e.sh` demo'yu bu commit'e güncelledi (`OK UPDATED`,
  derleme ve başlatma 2 dk 41 sn), atılabilir yığında tarayıcı paketi **50/50** (19,2 dk; 4 canlı ekran testi
  dahil); testler boyunca demo `/api/ready` 59 yanıtın 59'unda 200, sonrasında 200; test yığınından geriye 0
  kapsayıcı, 0 birim kaldı.
- **Etiket:** `origin`'e ve test sunucusunun deposuna yalnızca `refs/tags/v0.6.0` gönderildi. Test sunucusunun
  deposundaki öteki etiketler (`v0.1.0`-`v0.5.1`, eski iç test etiketleri dahil) gönderimden önce ve sonra
  karşılaştırıldı: tek fark yeni `v0.6.0`; hiçbiri GitHub'a gitmedi (GitHub'daki etiketler `v0.1.0`, `v0.4.0`,
  `v0.5.0`, `v0.5.1`, `v0.6.0`).
- **Yayın iş akışı `45122269033`:** ilk denemede geçti: birim işleri, 11 imaj
  (`ghcr.io/syildirim689/lightning-vm/*:v0.6.0`) ve sürüm sayfası. Sayfa "Lightning VM v0.6.0 (beta)" adıyla ve
  **pre-release** işaretiyle oluştu (taslak değil); notları `CHANGELOG.md` dosyasının 0.6.0 bölümüdür (satır satır
  karşılaştırıldı), altında iş akışının her sürüme eklediği kurulum ve güncelleme satırları.
- **Demo `v0.6.0` gösteriyor:** etiket konduktan sonra `install.sh update --to v0.6.0` çalıştırıldı; yapacak bir
  şey yoktu (`OK UP_TO_DATE Up to date: v0.6.0`) ve ad yenilendi: `.env` içinde ve API ile web kapsayıcılarında
  `APP_VERSION=v0.6.0`, `git describe` `v0.6.0`, `/api/ready` 200, öncesindeki gibi 24 kapsayıcı çalışıyor.
  Sistem sayfasının okuduğu `data/maintenance/releases.json` aynı komutla yeniden yazıldı: `current` ve `base`
  `v0.6.0`, listede ilk sırada `v0.6.0` çalışan sürüm olarak işaretli, güncelleme yok. (Liste demo deposundaki eski iç
  test etiketlerini de içerir; GitHub'dan kurulan bir panelde onlar yoktur.) Etiketten önce panel
  `v0.5.1-11-g48cf206` gösteriyordu. Yedek, derleme ya da migration çalışmadı; veritabanına dokunulmadı.
- **Çalıştırılmayanlar:** temiz bir makinede `curl … | sudo sh` ile 0.6.0 kurulumu; 0.5.1 kurulu, verisi olan
  gerçek bir panelin 0.6.0'a güncellenmesi (demo bu commit'e etiketten önce, dalın ucundan güncellendi);
  yayımlanan `ghcr.io` imajlarının çekilip çalıştırılması; panele tarayıcıdan oturum açıp gösterilen sürümün ve
  sürüm listesinin gözle görülmesi (ad kapsayıcıların ortam değişkeninden, liste dosyadan okundu).
- **Canlı ekranlar için açık kalanlar:** gerçek bir GPU'da ve gerçek bir TV'de hiç ölçülmedi; bütün ölçümler grafik
  kartı olmayan bir sanal makinede, yazılım çizicisiyle yapıldı (60 fps hedefi, 4K, saatlerce açık kalan bir ekran,
  uzaktan kumanda, Safari/iOS, Firefox ve Android denenmedi). Ekranlar arasındaki her geçişte JS yığını yaklaşık
  170 KB büyüyor; kaynağı bulunmadı ve saatler içinde durup durmadığı ölçülmedi. Üç işin kendi bölümlerindeki
  "çalıştırılmayanlar" aynen geçerlidir.

## Kullanım incelemesi ve günlük işi kolaylaştıranlar — 2026-11-23

İnceleme: [ux-review.md](ux-review.md) (34 bulgu: 5 yüksek, 17 orta, 12 düşük). Ne yapıldığı:
[smart-features.md](smart-features.md#günlük-işi-kolaylaştıranlar). Commit'ler `b6fcd67` … `fb4bce9`. 0.7.0 sürümündedir (`CHANGELOG.md`).

- **Birim testleri (geliştirme makinesi, Node 26):** API `npm test` 238/238 (önceden 218; 20 yeni: `eta-rules` 5,
  `session-rules` 8, `onboarding-rules` 7); web `npm test` 203/203 (önceden 166; 37 yeni: `eta`, `undo`, `reconnect`,
  `session-clock`, `setup-checklist`, `paste`, `last-order`, `error-key`; `session-end` yeni tarayıcı anahtarıyla),
  `check-messages` (8093 anahtar, iki dil), `icons --check`, `tsc` (web, API), `next build`.
- **Paket boyutları** (`next build`, her rotanın istemci başvuru bildirimindeki giriş JS dosyaları; değişiklikten önceki
  `33b9a10` aynı makinede aynı yolla derlendi):
  - Herkese açık sayfalar (giriş, kayıt, kurulum, durum, 404, canlı ekran): +4,2 KB ham / +1,6 KB gzip (ortak
    `TextInput`'a giren SSH anahtarı ve yapıştırma kuralları).
  - Panelin her sayfası: +9,3 KB ham / +3,2 KB gzip (bağlantı şeridi, oturum uyarısı, süre tahmini, hata metni).
  - En çok büyüyenler: `/order` +13,8 KB / +4,7 KB gzip, `/account` +12,1 / +4,3, `/admin/servers` +12,0 / +4,2,
    `/`, `/servers/[id]`, `/vdc` +12,0 / +4,2, `/admin` +11,7 / +4,0, `/firewalls/[id]` +10,8 / +3,8.
  - Yeni bağımlılık yok. Yeni yoklama yok: süre tahmini 10 dakikada bir en çok bir okuma (Redis'te 10 dakika),
    oturum uyarısı zaten dakikada bir okunan `/auth/me` yanıtından; panel yanıt vermezken listeler duruyor.
- **GitHub CI, elle tam çalıştırma:**
  - `45156095351` (`2cde7b0`): iptal edildi; e2e testi güç zamanlaması silmede hâlâ onay penceresini bekliyordu
    (test güncellendi, `a2bb5ff`). İptalden önce birim işleri, adaptörler, Go servisleri ve imaj derlemeleri geçmişti.
  - `45156522153` (`a2bb5ff`): `api-integration` kaldı (`platform.test.mjs` kurulum listesinde tam 9 adım
    bekliyordu → başlangıç adımlarını sayıyor, `678a5b9`); `compose` işi, aynı dala yapılan push'un başlattığı
    çalıştırma tarafından (eşzamanlılık kuralı) iptal edildi.
  - `45158922100` (`678a5b9`): `api-integration` kaldı: yeni `ux-helpers` testinde dizin hesabının sabit bitişi bir
    kez "uzatılabilir" çıktı. **Gerçek hata:** saklanan bitiş, oturum satırının oluşma zamanından birkaç milisaniye
    önce hesaplanıyor; eşit sayılması gereken bitişlerden saklanan oturumunki önde kalıyordu → bir dakika içindeki
    bitişler aynı an sayılıyor, sabit olan söyleniyor (`fcf84db`, birim testi). `compose` 51/57: iki e2e testi proje
    satırını sayfa yerine "kaldırıldı" iletisinde de buldu (iletiler de liste öğesi) → `main` içinde aranıyor (`fb4bce9`).
  - **`45162396637` (`fb4bce9`): yeşil, bütün işler geçti.** `api-integration` 287 testte 218 geçti, 0 başarısız, 69
    atlandı (yeni `ux-helpers` 5/5); `compose` tarayıcı paketi **57/57** (17,6 dk; 7 yeni `ux` testi dahil).
  - Push ile başlayan çalıştırmalar (`45156080847`, `45156471398`, `45158406144`, `45162347499`) elle çalıştırma
    lehine iptal edildi.
- **Kurulum sihirbazı testi** (önceki aralıklı kalış): bu işin dört tarayıcı koşusunda (iki CI, iki demo) ilk testte
  hep geçti; kalış görülmedi, kanıt toplanamadı, neden bulunmadı. Kodu okununca bir olasılık: erişim adımı açılınca
  denetim kendiliğinden çalışıyor (`wizard.tsx`); test aynı anda adresi değiştirip "Kontrol et"e basarsa sonradan
  dönen eski yanıt `result`'u ezebilir. Doğrulanmadı.
- **Demo sunucusu:** `/root/demo-e2e.sh fb4bce9`: demo güncellendi (`/opt/lightning-vm` `fb4bce9`), atılabilir
  yığında **57/57** (20,5 dk), testler boyunca demo `/api/ready` 63 yanıtın 63'ünde 200, sonrasında 200, geriye 0 test
  kapsayıcısı. Önceki iki demo koşusu (`2cde7b0`, `678a5b9`) yukarıdaki iki test hatasıyla kaldı (1 başarısız; ux
  testleri ikisinde de geçti).

**Çalıştırılmayanlar / doğrulanamayanlar:**
- Yerel tarayıcı testi yok (bu makinede Docker ve VMware simülatörü yok); tarayıcı testleri yalnız CI'da ve demo'nun
  atılabilir yığınında koştu. WSL'de PostgreSQL/Redis kurulmadı; entegrasyon testleri yalnız CI'da koştu.
- Oturum uyarısı gerçek bir 12 saatlik oturumun sonunda görülmedi: tarayıcı testi `/auth/me` yanıtındaki kalan süreyi
  değiştiriyor; çerezin yeniden yazılması ve sabit bitişlerin reddi entegrasyon testinde gerçek istekle denendi.
  Gerçek bir dizin/SSO hesabıyla ve rol oturum süresiyle denenmedi.
- "Panel yanıt vermiyor" şeridi tarayıcıda istekleri reddederek denendi; gerçek bir API yeniden başlatması
  sırasında gözle bakılmadı. Canlı olay akışı (EventSource) bu sürede tarayıcının kendi yeniden bağlanmasıyla sürüyor.
- Süre tahmini demo'nun kendi geçmişiyle gözle görülmedi (tarayıcı testi hazırlanmış yanıt kullanıyor; gerçek uçtan
  yalnız biçim ve en az 5 kuralı denetleniyor).
- Geri alma iletisinin klavye ile (F6 ile ileti bölgesi) kullanılması ve ekran okuyucuyla dinlenmesi elle denenmedi.
- 44 px dokunma alanları dokunmatik bir cihazda denenmedi (`pointer: coarse` medya sorgusu).
- Safari, Firefox ve gerçek telefonlar denenmedi; 390 px yalnız Chromium'da.

## 0.7.0 (beta) sürümü — 2026-11-23

`v0.7.0` etiketi `47df01d` commit'indedir (açıklamalı etiket). İçinde 0.6.0'dan sonraki tek iş vardır (yukarıdaki
"Kullanım incelemesi ve günlük işi kolaylaştıranlar" bölümü, `b6fcd67` … `fb4bce9`); ondan sonraki commit'ler
yalnızca belgeleri, `47df01d` de yalnızca sürüm numaralarını ve belgeleri değiştirir. Etiket, o commit denendikten
sonra kondu:

- **GitHub CI, elle tam çalıştırma `45177311336` (`47df01d`):** ilk denemede yeşil, bütün işler geçti; yeniden
  deneme yapılmadı. `api-integration` 287 testte 218 geçti, 0 başarısız, 69 atlandı; `compose` işindeki tarayıcı
  paketi **57/57** (18,3 dk); birim işleri, altı adaptör, iki Go servisi, 11 imaj derlemesi. (Aynı commit'in `push`
  ile başlayan çalıştırması `45177292896` iptal edildi: elle çalıştırma onun yerini aldı.) Kurulum sihirbazı testi
  bu çalıştırmada da ilk denemede geçti.
- **Demo sunucusu (`47df01d`), etiketten önce:** `/root/demo-e2e.sh` demo'yu bu commit'e güncelledi (`OK UPDATED`,
  derleme ve başlatma 2 dk 41 sn), atılabilir yığında tarayıcı paketi **57/57** (20,3 dk); testler boyunca demo
  `/api/ready` 63 yanıtın 63'ünde 200; test yığınından geriye 0 kapsayıcı, 0 birim kaldı.
- **Etiket:** `origin`'e ve test sunucusunun deposuna yalnızca `refs/tags/v0.7.0` gönderildi. Test sunucusunun
  deposundaki etiketler gönderimden önce ve sonra karşılaştırıldı: tek fark yeni `v0.7.0`; eski iç test etiketleri
  (`v0.1.1`-`v0.3.0`) yerinde kaldı ve hiçbiri GitHub'a gitmedi (GitHub'daki etiketler `v0.1.0`, `v0.4.0`, `v0.5.0`,
  `v0.5.1`, `v0.6.0`, `v0.7.0`).
- **Yayın iş akışı `45182422439`:** ilk denemede geçti: birim işleri, 11 imaj
  (`ghcr.io/syildirim689/lightning-vm/*:v0.7.0`; iş akışının günlüğünde her birinin gönderildiği görüldü) ve sürüm
  sayfası. Sayfa "Lightning VM v0.7.0 (beta)" adıyla ve **pre-release** işaretiyle oluştu (taslak değil); notları
  `CHANGELOG.md` dosyasının 0.7.0 bölümüdür (satır satır karşılaştırıldı), altında iş akışının her sürüme eklediği
  kurulum ve güncelleme satırları.
- **Demo `v0.7.0` gösteriyor:** etiket konduktan sonra `install.sh update --to v0.7.0` çalıştırıldı; yapacak bir
  şey yoktu (`OK UP_TO_DATE Up to date: v0.7.0`) ve ad yenilendi: `.env` içinde ve API ile web kapsayıcılarında
  `APP_VERSION=v0.7.0`, `git describe` `v0.7.0`, `/api/ready` 200, öncesindeki gibi 24 kapsayıcı çalışıyor.
  `data/maintenance/releases.json`: `current` ve `base` `v0.7.0`, listede ilk sırada `v0.7.0`. Etiketten önce panel
  `v0.6.0-12-g47df01d` gösteriyordu. Yedek, derleme ya da migration çalışmadı; veritabanına dokunulmadı.
- **Çalıştırılmayanlar:** temiz bir makinede `curl … | sudo sh` ile 0.7.0 kurulumu; 0.6.0 kurulu, verisi olan
  gerçek bir panelin 0.7.0'a güncellenmesi (demo bu commit'e etiketten önce, dalın ucundan güncellendi);
  yayımlanan `ghcr.io` imajlarının çekilip çalıştırılması (imajlardan `api`, `web`, `worker`, `console` ve `vmware`
  oturumsuz çekilemiyor, 0.6.0'ınkiler de öyle; öteki altısı oturumsuz çekilebiliyor); panele tarayıcıdan oturum
  açıp gösterilen sürümün gözle görülmesi. Kullanım incelemesi bölümündeki "çalıştırılmayanlar" (Safari, Firefox,
  gerçek telefonlar, dokunmatik ekran, ekran okuyucu, gerçek bir oturum sonu) aynen geçerlidir.
