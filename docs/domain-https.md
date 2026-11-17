# Alan adı, reverse proxy ve HTTPS

Panel üç erişim modundan biriyle çalışır. Mod `scripts/install.sh` ile seçilir. Seçilen değerler
`.env` dosyasına yazılır ve yalnızca Caddy (`proxy` servisi) yeniden başlatılır. Bu işlem
güvenlik duvarına, SSH'ye veya sunucudaki diğer web sunucularına dokunmaz.

| Mod | Komut | Dinlediği adres | TLS |
|---|---|---|---|
| Yalnızca yerel | `sh scripts/install.sh local-only` (kurulumda `--local`) | `127.0.0.1:8080` | Yok; SSH tüneli kullanılır |
| Alan adı | `sh scripts/install.sh domain panel.example.com [--acme-staging]` | `0.0.0.0:80` ve `:443` | Caddy, Let's Encrypt |
| Mevcut proxy arkasında | `sh scripts/install.sh behind-proxy --public-url https://panel.example.com [--port 8080] [--trusted-cidr CIDR]` | `127.0.0.1:8080` | Önünüzdeki Nginx/Caddy/Traefik |

İlk kurulumda mod kendiliğinden seçilir: `--domain` verildiyse o ad; verilmediyse ve sunucunun genel bir IPv4 adresi
varsa `<ip>.sslip.io` adıyla alan adı modu; genel adres yoksa ya da `--local` verildiyse yalnızca yerel mod.

## 1. Alan adı ve DNS
- **Ad seçimi:** ana alan adı (`example.com`) yerine bir alt alan adı kullanın, örneğin `panel.example.com`.
- **A kaydı:** DNS sağlayıcınızda sunucunun **genel** IPv4 adresini gösteren bir A kaydı oluşturun:
  ```
  panel.example.com.  300  IN  A  203.0.113.10
  ```
  `203.0.113.10` yalnızca bir örnek adrestir.
- **AAAA kaydı:** yalnızca sunucuda gerçekten çalışan genel bir IPv6 adresi varsa ekleyin. Çalışmayan
  bir AAAA kaydı, IPv6 kullanan ziyaretçilerin ve sertifika doğrulamasının başarısız olmasına yol açar.
  Kurulum betiği bu durumu `W_AAAA_NO_IPV6`, sihirbaz ise ayrı bir uyarıyla bildirir.
- **Genel ve özel IP:** özel adresler (`10.x`, `172.16–31.x`, `192.168.x`) internetten erişilemez;
  DNS'e yazılmaz.
- **NAT arkasında:** modeminizin genel adresini A kaydına yazın ve 80/443 portlarını bu sunucuya
  yönlendirin. Betik, DNS adresi bu sunucunun kendi adreslerinden biri değilse `W_DNS_NOT_LOCAL`
  uyarısı verir ama devam eder.
- **Yayılma:** kaydın görünmesi TTL'e göre birkaç dakika ile birkaç saat sürebilir. Kontrol için:
  ```sh
  getent ahostsv4 panel.example.com
  ```
  Kendi bilgisayarınızda `dig +short panel.example.com A` da kullanılabilir.

## 2. Caddy ile otomatik HTTPS
```sh
sudo sh scripts/install.sh domain panel.example.com --acme-staging
```
```sh
sudo sh scripts/install.sh domain panel.example.com
```
1. Betik alan adını doğrular, 80/443 port çakışmasını kontrol eder (`E_PORT_IN_USE`) ve A kaydını arar.
   A kaydı yoksa sertifika alınamayacağı için durur (`E_DNS_NO_A`).
2. `.env` dosyasına şu değerleri yazar: `PANEL_SITE`, `LISTEN_ADDRESS=0.0.0.0`, `HTTP_PORT=80`,
   `HTTPS_PORT=443`, `ACME_CA` ve `PANEL_PUBLIC_URL=https://<alan adı>` (postayla gönderilen bağlantıların adresi).
   Ardından yalnızca Caddy'yi yeniden başlatır.
3. Sertifika gelince üç sonucu **ayrı ayrı** yazar: DNS, HTTP ve sertifika.

**Staging (`--acme-staging`):** denemelerde Let's Encrypt'in test ortamını kullanır. Bu sertifikalara
tarayıcılar güvenmez (`W_CERT_STAGING`), ancak tekrarlanan denemeler gerçek sertifika limitlerine
takılmaz. Çalıştığını gördükten sonra komutu seçenek olmadan tekrar çalıştırın.

**Doğrulama:** Let's Encrypt doğrulaması 80 (HTTP-01) veya 443 (TLS-ALPN-01) portu üzerinden yapılır.
Bu nedenle iki port da internetten bu sunucuya ulaşmalıdır. Bulut sağlayıcınızın güvenlik duvarını
siz açmalısınız; betik bunu yapmaz.

**Yenileme:** Caddy sertifikayı süresi dolmadan kendisi yeniler. Sertifikalar ve ACME hesabı
`caddy_data` biriminde saklanır, yeniden başlatma ve güncellemelerde korunur. Bu birim silinirse
(`docker compose down -v`) sertifika yeniden alınır; bunu sık yapmak gerçek limitlere takılmanıza yol açar.

**HTTP'den HTTPS'e yönlendirme:** Caddy, 80 portuna gelen istekleri 308 koduyla HTTPS'e yönlendirir.

**HSTS:** varsayılan olarak eklenmez. Staging sertifikasıyla HSTS kullanmak tarayıcıyı kilitler.
Gerçek sertifikayla kalıcı olarak çalıştığınızda eklenmesi önerilir; ileride bir ayar olarak gelecek.

## 3. Mevcut Nginx / Caddy / Traefik arkasında
Sunucudaki 80/443 portlarını başka bir web sunucusu kullanıyorsa:
```sh
sudo sh scripts/install.sh behind-proxy --public-url https://panel.example.com
```
Panel `127.0.0.1:8080` üzerinde düz HTTP dinler; TLS'i önünüzdeki proxy sonlandırır.

**Panelin dış adresi (`--public-url`, `.env` içinde `PANEL_PUBLIC_URL`):** başka bir proxy arkasında panel kendi
adresini bilemez; isteğin `Host` başlığı, o proxy ne geçirirse odur. Parola sıfırlama ve giriş bağlantıları bu
yüzden istekten değil, bu ayardan kurulur.
- Değer, insanların paneli açtığı adrestir: şema ve host (gerekirse port), yol olmadan
  (`https://panel.example.com`). Başka bir biçim `E_PUBLIC_URL_INVALID` ile reddedilir.
- `--public-url` verilmezse ve `.env` içinde `PANEL_PUBLIC_URL` yoksa komut `E_PUBLIC_URL_MISSING` ile durur ve
  hiçbir şeyi değiştirmez. Değer bir kez yazıldıktan sonra komut bayraksız da çalışır.
- **Bu ayardan önce kurulmuş behind-proxy kurulumları** komutu bir kez `--public-url` ile çalıştırmalıdır. Kayıtlı
  adresi olmayan bir kurulum, herkese açık bir host adıyla gelen isteklere bağlantı postası **göndermez** (API
  günlüğünde `auth_mail_not_sent_panel_address_unknown`); bir yönetici bir kez giriş yaptığında ya da değişken
  yazıldığında gönderim başlar.
- `domain` komutu değeri kendisi yazar (`https://<alan adı>`), `local-only` boşaltır.

**Güvenilen proxy sınırı:**
- Caddy, `X-Forwarded-For` ve `X-Forwarded-Proto` başlıklarına yalnızca `TRUSTED_PROXY_CIDRS`
  içindeki kaynaklardan güvenir.
- Varsayılan değer, Docker ağının geçidi olarak otomatik bulunur. Sunucudaki proxy panele Docker'ın
  port yayını üzerinden bağlandığı için Caddy bağlantıyı bu adresten gelmiş görür.
- `trusted_proxies_strict` açıktır: başlık sağdan sola okunur. Bu yüzden istemcinin kendisinin
  eklediği sahte değerler kullanılmaz.
- **Caddy içeriye tek istemci adresi gönderir.** API'ye, web'e ve konsol geçidine giden isteklerde
  `X-Forwarded-For` başlığı Caddy'nin kendi bulduğu adresle (`{client_ip}`) **değiştirilir**; gelen zincir ve onunla
  birlikte istemcinin başa yazdığı değerler içeriye ulaşmaz. `Forwarded` ve `X-Real-IP` başlıkları silinir. Bunun
  için **Caddy 2.7 ya da yenisi** gerekir (`docker compose exec proxy caddy version`; eskiyse
  `docker compose pull proxy`). Yükseltmeden sonra proxy'yi yeniden başlatın: `docker compose restart proxy`.
- Parola sıfırlama ve giriş bağlantıları isteğin `Host` / `X-Forwarded-Host` başlığını değil, panelin ayarlı adresini
  (`PANEL_PUBLIC_URL`) taşır; önünüzdeki proxy yabancı bir host adını içeriye geçirse bile postadaki bağlantı
  değişmez.
- `--trusted-cidr` değeri denetlenir: adres ya da ağ (`172.18.0.1/32`, `2001:db8::/32`), birden çoksa aralarında
  birer boşlukla. Geçersiz bir değer `E_CIDR_INVALID` ile reddedilir ve hiçbir şey yazılmaz.
- Caddy `/api/*` isteklerinin gövdesini 10 MB ile sınırlar (API'nin kendi rota sınırları daha küçüktür). Önünüzdeki
  proxy'de daha küçük bir sınır varsa (Nginx'in varsayılan `client_max_body_size` değeri 1 MB'tır) 9 MB'a kadar olan
  talep ekleri orada reddedilir; gerekiyorsa yükseltin.

Önemli: bu ayarla, aynı sunucuda çalışan herhangi bir süreç de güvenilen kaynak sayılır.

Nginx örneği (TLS sertifikası Nginx'te):
```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name panel.example.com;
    # ssl_certificate / ssl_certificate_key: kendi sertifikanız

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Tarayıcı konsolu (WebSocket) için:
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }
}
```

Bu ayarların doğru olması gerekir, çünkü:
- **`Host`:** iletilmezse Next.js Server Action'ları ve API'nin Origin kontrolü istekleri reddeder.
- **`X-Forwarded-Host`:** tek oturum açma (OAuth) yönlendirme adresleri ve passkey'lerin bağlandığı origin bu
  başlığı izler. `$host` ile kendiniz yazın; böylece istemcinin gönderdiği bir değer içeriye geçmez.
- **`X-Forwarded-Proto: https`:** iletilmezse oturum çerezleri `Secure` bayrağı almaz.
- **`X-Forwarded-For`:** iletilmezse denetim kayıtları ve hız sınırı istemcinin IP'sini değil,
  proxy'nin IP'sini görür.

Traefik veya başka bir Caddy kullanıyorsanız aynı başlıkları iletin ve WebSocket desteğini açın.

Panelin kendi Caddy'sini atlayıp API'nin önüne doğrudan başka bir proxy koyarsanız (desteklenen kurulum değildir), o
proxy de API'ye **tek** istemci adresi göndermeli ve `.env` içindeki `TRUSTED_PROXIES` yalnızca o proxy'yi
listelemelidir.

## 4. Cloudflare (isteğe bağlı)
Cloudflare zorunlu değildir.
- **En basit yol:** kaydı "DNS only" (gri bulut) yapın. Caddy sertifikayı doğrudan alır.
- **Proxy açık (turuncu bulut):** SSL/TLS modunu mutlaka **Full (strict)** yapın.
  - "Flexible" modu kullanmayın: Cloudflare ile sunucu arası trafiği şifresiz bırakır.
  - "Full" (strict olmayan) modu kullanmayın: sertifikayı doğrulamaz.
  - WebSocket'in açık olduğundan emin olun.
  - Gerçek istemci IP'si için `behind-proxy --trusted-cidr` ile Cloudflare'in IP aralıklarını
    vermeniz gerekir. Bu kurulum bu senaryoda test edilmedi.

## 5. Alan adı veya IP olmadan: SSH tüneli
Kendi bilgisayarınızda:
```sh
ssh -L 8080:127.0.0.1:8080 KULLANICI@SUNUCU
```
Ardından http://127.0.0.1:8080 adresini açın. Trafik SSH ile şifrelenir. Sihirbazdaki adres testi
bu durumda "yerel adres; doğrulanamaz" der; bu beklenen bir sonuçtur.

## 6. Kontroller birbirinden ayrıdır
Hem `install.sh domain/check` hem de sihirbazdaki "Alan adı ve HTTPS" adımı şu üç sonucu ayrı verir:

| Kontrol | Başarılı | Başarısızlık kodları |
|---|---|---|
| DNS | A kaydı var (AAAA ayrıca uyarılır) | `DNS_FAILED`, `NO_ADDRESS_RECORDS` |
| HTTP (80) | 2xx veya HTTPS'e yönlendirme | `CONNECTION_REFUSED`, `TIMEOUT`, `HTTP_ERROR` |
| HTTPS (443) | Sertifika sistem CA'ları ile doğrulandı **ve** yanıt bu kurulumdan geliyor | `TLS_ERROR`, `CERT_STAGING`, `WRONG_TARGET`, `TIMEOUT` |

Bir kontrolün başarılı olması diğerlerinin de başarılı olduğu anlamına gelmez. Sertifika hatasında
çözüm hiçbir zaman doğrulamayı kapatmak değildir; adı, DNS'i ve `docker compose logs proxy`
çıktısını kontrol edin.

## 6b. Panelden alan adı ve sertifika değiştirme

**Ayarlar → Alan adı ve SSL** sekmesi şunları yapar:
- Şu anki adresi, sertifikayı veren kurumu, kapsadığı adları, geçerlilik süresini (kalan gün) ve SHA-256
  parmak izini gösterir. Bunlar proxy'den TLS ile okunur.
- Yeni adın DNS kaydını denetler. A/AAAA kayıtlarını ve şu anki adla aynı sunucuyu gösterip göstermediğini
  bildirir.
- Sertifika için üç seçenek sunar:
  - **Let's Encrypt:** otomatik alınır ve yenilenir.
  - **Let's Encrypt test:** staging ortamı.
  - **Kendi sertifikam:** PEM tam zincir ve şifresiz özel anahtar, dosyadan da yüklenebilir. Uygulanmadan
    önce hem API'de hem de sunucudaki betikte denetlenir (karar veren betiktir; komut satırından verilen sertifika
    da aynı denetimden geçer):
    - Anahtar sertifikaya ait olmalı (`E_CERT_KEY_MISMATCH`).
    - Sertifikanın süresi dolmamış ve başlamış olmalı (`E_CERT_DATES`).
    - Sertifika ve anahtar okunabilmeli; parolayla korunan anahtar kullanılamaz (`E_CERT_UNREADABLE`).
    - Alan adı sertifikanın SAN listesinde olmalı.
    - Uyarı verilir: kendinden imzalı sertifika, eksik ara sertifika, hatalı zincir sırası, 30 günden kısa
      süre.
- Değişikliği sunucudaki ajan uygular (`sh scripts/install.sh agent on` gerekir). Ajanın çalıştırdığı komut
  komut satırındakiyle aynıdır:

```bash
sudo sh scripts/install.sh domain panel.example.com                       # Let's Encrypt
sudo sh scripts/install.sh domain panel.example.com --acme-staging        # Let's Encrypt test
sudo sh scripts/install.sh domain panel.example.com --tls custom --cert fullchain.pem --key key.pem
```

Kendi sertifikanız `data/tls/` altına kopyalanır (yalnızca root okur). Caddy bu klasördeki `site.caddy`
parçasını site bloğuna aktarır (`tls /etc/caddy/site.d/cert.pem …`). Let's Encrypt kullanıldığında parça
boştur.

Başarısızlıkta önceki ayar otomatik geri yüklenir: `.env`, `data/tls` ve proxy önceki haline döner, eski adres
çalışmaya devam eder. Başarısızlık sayılan durumlar:
- Proxy başlamazsa.
- Let's Encrypt sertifika veremezse.
- Yüklenen sertifika 443'te sunulmuyorsa (parmak izi karşılaştırılır).

Kendi sertifikanızın yenilenmesi sizdedir. Süresi dolmadan aynı ekrandan yenisini yükleyin.

Demo sunucusunda denendi. Sistemd ajanı üzerinden şu akışlar sırayla doğrulandı:
1. Kendi sertifikasına geçiş: sertifika sunuldu.
2. Bozuk sertifika: önceki sertifika geri yüklendi.
3. Let's Encrypt'e dönüş.

## 7. Alan adını değiştirmenin etkileri
- **Oturumlar:** oturum çerezi alan adına bağlıdır; eski adla açılmış oturumlar yeni adda geçmez ve
  herkesin tekrar giriş yapması gerekir.
- **Passkey'ler:** alan adına bağlıdır; yeni adda kullanıcıların passkey'lerini yeniden eklemesi gerekir.
- **Secure çerez:** `domain` ve `behind-proxy` modları `.env`'de `PANEL_TLS=1`, `local-only` modu `0` yazar.
  Çerezin `Secure` bayrağı bu değere göre API başlarken belirlenir.
- **Origin kontrolü:** API ve Next.js, isteğin `Origin` başlığını `Host` ile karşılaştırır. Bu yüzden
  ek bir izin listesi gerekmez; ancak önünüzdeki proxy `Host` başlığını korumalıdır.
- **Panel adresi:** e-posta, sohbet ve bildirim bağlantıları sırasıyla `PANEL_PUBLIC_URL` değerini, sunulan alan
  adını (`https://<ad>`), sonra sihirbazda verilen ya da bir yöneticinin ilk girişinde kaydedilen adresi
  (`settings.public_url`) kullanır; alan adı değişince `domain` komutu `PANEL_PUBLIC_URL` değerini de yeniler. Hiçbiri
  yoksa yalnızca bu sunucudan ya da özel bir ağdan gelen isteğin adresi kullanılır; herkese açık bir host adıyla gelen
  isteğe bağlantı postası gönderilmez.
- **Konsol ve terminal:** tarayıcı konsolu (`/console/ws`) ve yöneticinin sunucu terminali aynı ad ve aynı TLS
  üzerinden WebSocket ile çalışır; ayrı bir alan adı veya sertifika gerekmez. Öndeki proxy WebSocket yükseltmesini
  geçirmelidir ([console.md](console.md)).

## 8. Güvenlik başlıkları
Caddy her yanıta şu başlıkları ekler:
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: same-origin`
- `X-Frame-Options: DENY`

`Server` başlığı kaldırılır. Caddy'nin erişim logları `Cookie`, `Set-Cookie` ve `Authorization` başlıklarını
varsayılan olarak gizler.

**Erişim günlüğünde maskeleme:** bazı sırlar URL'de taşınır: parola sıfırlama belirteci yolun bir parçasıdır
(`/api/auth/reset-password/<belirteç>`); `token`, `code`, `state` ve `session_id` ise giriş bağlantısının, tek oturum
açma dönüşünün ve ödeme dönüşünün sorgu değerleridir. Caddy bunları erişim günlüğünde `***` ile yazar (istek adresi,
`Referer` başlığı ve yönlendirmenin `Location` başlığı) ve CAPTCHA yanıtı başlığını hiç yazmaz. Günlük toplayıcısı
(`deploy/observability/otel.yaml`) ve panelin sistem sayfası için aldığı günlük kopyaları aynı maskeyi uygular.
Yükseltmeden sonra kuralın geçerli olması için proxy'yi (ve izleme açıksa toplayıcıyı) yeniden başlatın; önceden
saklanmış satırlar yeniden yazılmaz. **Önünüzdeki kendi proxy'nizin erişim günlüğü bu maskeyi uygulamaz;** orada da
sorgu dizgelerini ve `/api/auth/reset-password/` yolunu günlüğe yazmamayı değerlendirin.
