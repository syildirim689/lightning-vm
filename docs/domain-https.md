# Alan adı, reverse proxy ve HTTPS

Panel üç erişim modundan biriyle çalışır. Mod `scripts/install.sh` ile seçilir. Seçilen değerler
`.env` dosyasına yazılır ve yalnızca Caddy (`proxy` servisi) yeniden başlatılır. Bu işlem
güvenlik duvarına, SSH'ye veya sunucudaki diğer web sunucularına dokunmaz.

| Mod | Komut | Dinlediği adres | TLS |
|---|---|---|---|
| Yalnızca yerel (varsayılan) | `sh scripts/install.sh local-only` | `127.0.0.1:8080` | Yok; SSH tüneli kullanılır |
| Alan adı | `sh scripts/install.sh domain panel.example.com [--acme-staging]` | `0.0.0.0:80` ve `:443` | Caddy, Let's Encrypt |
| Mevcut proxy arkasında | `sh scripts/install.sh behind-proxy [--port 8080] [--trusted-cidr CIDR]` | `127.0.0.1:8080` | Önünüzdeki Nginx/Caddy/Traefik |

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
   `HTTPS_PORT=443` ve `ACME_CA`. Ardından yalnızca Caddy'yi yeniden başlatır.
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
sudo sh scripts/install.sh behind-proxy
```
Panel `127.0.0.1:8080` üzerinde düz HTTP dinler; TLS'i önünüzdeki proxy sonlandırır.

**Güvenilen proxy sınırı:**
- Caddy, `X-Forwarded-For` ve `X-Forwarded-Proto` başlıklarına yalnızca `TRUSTED_PROXY_CIDRS`
  içindeki kaynaklardan güvenir.
- Varsayılan değer, Docker ağının geçidi olarak otomatik bulunur. Sunucudaki proxy panele Docker'ın
  port yayını üzerinden bağlandığı için Caddy bağlantıyı bu adresten gelmiş görür.
- `trusted_proxies_strict` açıktır: başlık sağdan sola okunur. Bu yüzden istemcinin kendisinin
  eklediği sahte değerler kullanılmaz.

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
- **`X-Forwarded-Proto: https`:** iletilmezse oturum çerezleri `Secure` bayrağı almaz.
- **`X-Forwarded-For`:** iletilmezse denetim kayıtları ve hız sınırı istemcinin IP'sini değil,
  proxy'nin IP'sini görür.

Traefik veya başka bir Caddy kullanıyorsanız aynı başlıkları iletin ve WebSocket desteğini açın.

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

## 7. Alan adını değiştirmenin etkileri
- **Oturumlar:** oturum çerezi alan adına bağlıdır; eski adla açılmış oturumlar yeni adda geçmez ve
  herkesin tekrar giriş yapması gerekir.
- **Passkey'ler:** alan adına bağlıdır; yeni adda kullanıcıların passkey'lerini yeniden eklemesi gerekir.
- **Secure çerez:** `domain` ve `behind-proxy` modları `.env`'de `PANEL_TLS=1`, `local-only` modu `0` yazar.
  Çerezin `Secure` bayrağı bu değere göre API başlarken belirlenir.
- **Origin kontrolü:** API ve Next.js, isteğin `Origin` başlığını `Host` ile karşılaştırır. Bu yüzden
  ek bir izin listesi gerekmez; ancak önünüzdeki proxy `Host` başlığını korumalıdır.
- **Panel adresi:** sihirbazdaki "erişim adresi" (`settings.public_url`) ayarını yeni adla
  güncelleyin. Bunun için gerekirse sihirbazı `sh scripts/install.sh recover-setup` ile yeniden açın.
- **Konsol:** tarayıcı konsolu (7. aşama) aynı ad ve aynı TLS üzerinden WebSocket ile çalışacak.
  Ayrı bir alan adı veya sertifika gerekmeyecek.

## 8. Güvenlik başlıkları
Caddy her yanıta şu başlıkları ekler:
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: same-origin`
- `X-Frame-Options: DENY`

`Server` başlığı kaldırılır. Caddy'nin erişim logları `Cookie` ve `Authorization` başlıklarını
varsayılan olarak gizler.
