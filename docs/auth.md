# Kimlik doğrulama, roller ve ilk kurulum

## Roller ve izinler
Yetki, izinler üzerinden verilir (`apps/api/src/permissions.ts`). Rol, izinlerin adlandırılmış bir
kümesidir. Bir kullanıcının birden fazla rolü olabilir (`users.role`, virgülle ayrılmış); rollerin
izinleri birleşir. Bunun üstüne kişiye özel istisnalar tanımlanabilir: tek bir izin eklenir (`allow`)
veya çıkarılır (`deny`).

| İzin | Ne verir |
|---|---|
| `dashboard.view` | Yönetim panosu ve içgörüler |
| `servers.create` | Kendi hesabına sunucu sipariş etme |
| `servers.view_all` / `servers.manage_all` | Tüm sunucuları görme / yönetme (güç, silme) |
| `operations.retry`, `reconcile.run`, `consoles.any` | İşlemi yeniden deneme, uzlaştırma, her VM'in konsolu |
| `catalog.view` / `catalog.manage` | Havuz, paket, imaj, IP havuzu ve kotalar |
| `vmware.view` / `vmware.manage` | VMware bağlantıları |
| `users.view`, `users.manage`, `users.roles`, `users.ban`, `users.sessions`, `users.impersonate` | Kullanıcı yönetimi |
| `roles.manage` | Rolleri oluşturma ve değiştirme |
| `settings.view` / `settings.manage` | Marka, e-posta, CAPTCHA, SMS ve bildirim ayarları (bazıları yalnızca yöneticiye açıktır, [aşağıda](#yalnızca-yöneticinin-değiştirebildiği-ayarlar)) |
| `system.view`, `audit.view` | Sistem sağlığı, yedekler ve denetim kayıtları (sistem sayfasındaki servis günlüklerini yalnızca yöneticiler görür) |

Hazır roller:
- **Yönetici** (`admin`): her izin (`*`); değiştirilemez.
- **Müşteri** (`user`): yalnızca sunucu sipariş etme.
- **Operatör, Destek, Denetçi:** düzenlenebilir veya silinebilir.

Yönetici Roller sayfasından yeni roller oluşturabilir.

Kurallar:
- **Varsayılan ret:** her yönetim uç noktası gerektirdiği izni `@Can(...)` ile bildirir. İzni belirtilmemiş
  bir uç nokta reddedilir; ret `admin.access / denied` olarak denetim kaydına yazılır. better-auth'un
  `/api/auth/admin/*` uç noktaları da aynı tablodan (`adminEndpointPermission`) denetlenir.
- **Yetki yükseltme yok:** kimse kendinde olmayan bir izni bir role veya kullanıcıya veremez. Kimse
  izinleri kendisininkinden geniş olan bir hesabı yasaklayamaz, silemez, parolasını değiştiremez ya da onun adına giriş yapamaz.
- **Kilitlenmeme:** yönetici kendi hesabını yasaklayamaz, silemez ve kendi rolünü değiştiremez. En az bir yönetici her zaman kalır (`LAST_ADMIN`).
- **Kaynak sahipliği:** sahibi kendi sunucularını her zaman görür ve yönetir. Başkasının sunucusuna erişmek için
  `servers.view_all` (görme) veya `servers.manage_all` (işlem) gerekir.

Web arayüzündeki kontroller yalnızca açılamayacak sayfaları göstermemek içindir. Güvenlik sınırı API'dir.

## Kullanıcı yönetimi
Kullanıcılar sayfası better-auth'un admin eklentisini kullanır. Her işlem ilgili izni gerektirir ve
denetim kaydına `admin.user.<işlem>` olarak yazılır:
- arama ve filtreleme;
- kullanıcı oluşturma (güçlü ilk parola üretilir);
- rol ve kişiye özel izin atama (etkin izinler canlı önizlenir);
- süreli veya kalıcı yasaklama (gerekçeyle); yasaklanınca oturumlar ve konsollar hemen kapanır;
- parola belirleme;
- oturumları listeleme ve kapatma;
- kullanıcı adına giriş: 1 saatlik oturumdur; panelde uyarı şeridi gösterilir ve tek tıkla kendi hesabına dönülür.
  Oturum, başladıktan **bir saat sonra** biter; tarayıcının gönderdiği çerezler bunu uzatamaz. Oturumu başlatan
  personelin yetkisi kalktığında da biter: rolü düşürüldüğünde (artık `users.impersonate` izni yoksa ya da izinleri o
  kullanıcıyı kapsamıyorsa), yasaklandığında, hesabı silindiğinde ve oturumları kapatıldığında, başlattığı "kullanıcı
  adına" oturumlar ve onlarla açılmış konsollar kapanır. Aynı denetim bu oturumların her isteğinde de yapılır.
  Bu oturumda hesapta kalıcı iz bırakan işlemler reddedilir (`NOT_WHILE_IMPERSONATING`): passkey ve bağlı hesap
  ekleme, API anahtarı, webhook, tarayıcı bildirimi ve mesajlaşma bağlantısı oluşturma, parola, telefon ve iki adımlı
  doğrulama değişikliği, fatura e-postasını değiştirme, kayıtlı görünüm kaydetme, değiştirme ve silme (kullanıcının
  görünümleri uygulanabilir), hesabı bayiden ayırma (`POST /reseller/leave`) ve devredilen bir sunucuyu kabul etme
  (ikisi de `403`: kimin yönettiği ve kimin ödediği hesabın sahibinin kararıdır). Bu oturum başlarken ve biterken tarayıcıdaki içerik (taslaklar, son açılanlar, yarım
  sipariş) silinir: personelinki müşterinin paneline, müşterininki personele geçmez
  ([operations-modules.md](operations-modules.md#tarayıcıda-tutulanlar-ve-oturum-sonu));
- silme: kullanıcının sunucusu varsa reddedilir (`USER_HAS_SERVERS`).

## İlk yönetici
Varsayılan kurulumda (`sudo sh scripts/install.sh`) yöneticiyi betik oluşturur:
- E-posta `--admin-email` ile verilir; verilmezse `admin@<alan adı>` (yerel modda `admin@lightning.local`) kullanılır.
- Parola rastgele üretilir. Kurulum sonunda ekrana yazılır ve `secrets/initial-admin.txt`
  dosyasına (yalnız root okuyabilir) kaydedilir. İlk girişten sonra parolayı değiştirip bu
  dosyayı silin.
- Elle oluşturmak için: `docker compose exec api node dist/cli.js create-admin EPOSTA [tr|en]`.
  Bu komut yalnızca henüz yönetici yoksa çalışır.

### Tarayıcı sihirbazıyla (`--setup-wizard`)
1. Betik terminale **1 saat geçerli** bir kurulum anahtarı yazar. Anahtar log dosyasına yazılmaz.
   Yeni anahtar üretmek için:
   ```sh
   docker compose exec api node dist/cli.js bootstrap-token
   ```
   Yeni anahtar bir öncekini geçersiz kılar. Veritabanında yalnızca SHA-256 özeti tutulur.
2. `/setup` sihirbazında önce anahtar girilir (HttpOnly çerezde tutulur). Yönetici hesabı
   adımında API kurulum satırını `FOR UPDATE` ile kilitler, anahtarı sabit sürede karşılaştırır,
   yöneticiyi better-auth ile oluşturur ve anahtarı siler. Aynı anda gelen istekler arasından
   yalnızca biri yönetici oluşturabilir; bu durum test edildi.
3. Yönetici oluştuktan sonra `POST /setup/admin` `409 SETUP_CLOSED` döner, CLI yeni anahtar
   üretmez ve sihirbaza yalnızca yönetici oturumuyla devam edilir (docs/setup.md).

Kurulum betiği tekrar çalıştırıldığında yöneticiye ve sırlara dokunmaz.
`sh scripts/install.sh recover-setup` yalnızca sihirbazı yeniden açar.

## Oturumlar (better-auth)
Kayıt, giriş, çıkış, oturumlar, parola değiştirme/sıfırlama ve passkey'ler
[better-auth](https://www.better-auth.com) ile yönetilir (`apps/api/src/better-auth.ts`).
Uç noktalar `/api/auth/*` altındadır; Fastify bunları better-auth'a iletir.
- **Yalnızca panelin kullandığı rotalar açıktır.** better-auth ve eklentilerinin getirdiği rotalardan panelin
  kullandıkları bir izin listesindedir (`panelPaths`, `better-auth.ts`; `/admin/*` rotalarının kendi listesi vardır).
  Listede olmayan her rota `404` döner: telefon numarasıyla giriş, telefonla parola sıfırlama, e-posta değiştirme,
  hesap silme ve benzerleri. Sonradan eklenen bir eklentinin rotası listeye yazılana kadar kapalıdır. Sağlayıcının
  kimlik belirtecini (ID token) `/sign-in/social` ya da `/link-social` rotasına göndererek giriş reddedilir.
- **Gövde ve alan sınırları:** `/api/auth/*` istek gövdesi 64 KB, API'nin geri kalanında JSON gövdesi 256 KB ile
  sınırlıdır (talep ve itiraz ekleri 9 MB, marka dosyaları 1 MB; Caddy `/api/*` için 10 MB üst sınır koyar). Ek
  rotalarındaki büyük gövde yalnızca oturum çerezi ya da API anahtarı gösteren bir istekten okunur; diğerleri gövde
  okunmadan reddedilir. E-posta, kullanıcı adı ve telefon alanları **metin** olmalıdır ve 254 karakteri aşamaz;
  denetim kaydına yazılan metinler kısaltılır.
- **Bağlantılar ve yönlendirmeler:** parola sıfırlama ve giriş bağlantıları isteğin geldiği host adını değil, panelin
  kendi adresini taşır: `.env` içindeki `PANEL_PUBLIC_URL`, yoksa alan adı, yoksa kurulumda verilen ya da bir
  yöneticinin ilk girişinde kaydedilen adres. Hiçbiri yoksa isteğin adresi yalnızca bu sunucudan ya da özel bir ağdan
  geliyorsa kullanılır; herkese açık bir host adıyla gelen istek için **posta gönderilmez** ve API günlüğüne
  `auth_mail_not_sent_panel_address_unknown` yazılır ([domain-https.md](domain-https.md)). Yönlendirme hedefleri
  (`callbackURL` ve benzerleri) yalnızca panel içi bir yol olabilir.
- **İstek günlüğü:** API'nin istek günlüğü başlık yazmaz ve URL'deki belirteçleri (sıfırlama belirteci, giriş
  bağlantısı, SSO `code` / `state`) maskeler.
- Kullanıcılar mevcut `users` tablosunda kalır. better-auth tabloları `auth_sessions`,
  `auth_accounts`, `auth_verifications` ve `auth_passkeys`'tir (migration 007).
  Eski parola özetleri `auth_accounts`'a taşınır; eski hesaplar aynı parolayla girer.
- Cookie: `lvm.session_token`, imzalı, `HttpOnly`, `SameSite=Lax`, `Path=/`. Panel HTTPS ile
  sunuluyorsa (`PANEL_TLS=1`, kurulum betiği ayarlar) `Secure` ve `__Secure-` öneki eklenir.
- İmza anahtarı `secrets/master.key`'den türetilir (HMAC); ayrı bir sır gerekmez.
- Süre: 12 saat. `.env` dosyasındaki `SESSION_TTL_HOURS` ile değiştirilir (1-720). "Beni hatırla" ile açılan
  oturumun çerezi girişte bu süreyle yazılır ve istekler onu yeniden yazmaz: kullanım veritabanındaki oturumu uzatsa da
  çerez girişten (ya da son "Oturumu açık tut"tan) bu süre sonra biter. Panel bitişten 5 dakika önce uyarır;
  "Oturumu açık tut" (`POST /auth/stay`, yalnız tıklamayla) oturumu ve çerezi şimdiden itibaren yeniler. Sabit
  bitişler (kullanıcı olarak gir, dizin/SSO, rolün oturum süresi) uzatılamaz. Ayrıntı:
  [smart-features.md](smart-features.md#bağlantı-ve-oturum).
  Bir rolün "oturum süresi"
  sınırı (aşağıda, Rol sınırları) üyelerinin oturumunu daha erken bitirir. Süresi dolan oturumlar ve devre dışı veya
  yasaklı kullanıcılar reddedilir; devre dışı kullanıcıya yeni oturum açılmaz.
- **Dizin ve SSO hesaplarında süre sabittir:** yerel bir hesabın oturumu kullanıldıkça uzar; dizin (`ldap`) ya da SSO
  (`oidc`) hesabının oturumu ise, kullanılsa da kullanılmasa da, açıldıktan `SESSION_TTL_HOURS` saat sonra biter ve
  silinir. Panel, hesabın dizinde ya da sağlayıcıda kapatıldığını öğrenemez; böylece dizine ya da sağlayıcıya en geç bu
  aralıkla yeniden sorulur. Dizin hesabında iki adımlı doğrulama değişikliği oturumu yenisiyle değiştirir; yeni oturum
  yerine geçtiği oturumun yaşını taşır, yani bu yolla süre uzatılamaz. "Kullanıcı adına" oturumların kendi bir saati
  vardır.
- Kullanıcı Hesap sayfasında açık oturumlarını görür ve tek tek kapatabilir. Parola
  değiştirirken diğer oturumları kapatma seçeneği vardır.
- Bir oturum hangi yolla biterse bitsin (çıkış, iptal, parola sıfırlama), o oturumla açılmış
  tarayıcı konsolları da kapatılır. Kullanıcının erişimi daraldığında (rol ya da izin azaltma) ve iki adımlı
  doğrulaması kapatıldığında ya da sıfırlandığında da açık konsolları ve host terminalleri kapanır.
- Birinin oturumları hangi yolla kapatılırsa kapatılsın (personelin yasaklaması, oturum iptali, parola ataması,
  iki adımlı doğrulama sıfırlaması; kişinin kendi parola sıfırlaması, diğer oturumları kapatan parola değişikliği ya
  da "diğer oturumları kapat") o tarayıcıların bildirim abonelikleri de silinir.
- Bir iptalden **önce** alınmış ama henüz kullanılmamış konsol ya da terminal bileti de reddedilir
  (`CONSOLE_REVOKED` / `TERMINAL_REVOKED`; [console.md](console.md)).

## Passkey'ler
Kullanıcı Hesap sayfasından passkey ekler (`@better-auth/passkey`, WebAuthn). Giriş sayfasında
"Passkey ile giriş yap" düğmesi ve tarayıcının otomatik doldurma önerisi kullanılır. Passkey,
panelin açıldığı alan adına bağlıdır (RP ID isteğin host'undan alınır). Alan adı değişirse
passkey'ler yeniden eklenmelidir. Tarayıcılar WebAuthn'i yalnızca HTTPS'te veya `localhost`'ta
açar. Gerçek bir doğrulayıcıyla (Touch ID, Windows Hello, güvenlik anahtarı) henüz denenmedi.
Passkey ile giriş denetim kaydına yazılır ve giriş bildirimi gönderir; passkey ekleme ve kaldırma
`auth.passkey_added` / `auth.passkey_removed` olarak kaydedilir ve ekleme hesaba bildirilir. Dizin ve SSO hesapları
passkey ile giremez.

## Parola sıfırlama (e-posta)
E-posta gönderimi ayarlıysa giriş sayfasında "Parolamı unuttum" bağlantısı görünür. E-posta panelden ayarlanır
(Yönetim → Ayarlar → E-posta: SMTP ya da 12 API sağlayıcısından biri; [settings.md](settings.md)). Panelde e-posta
ayarı kaydedilmemişse `.env` içindeki `SMTP_URL` (ör. `smtps://kullanici:parola@smtp.example.com:465`) ve `MAIL_FROM`
kullanılır; bu, ayar sayfasından önceki kurulumlar için bırakılmış yedek yoldur. Bağlantı e-postayla gider
(kullanıcının diline göre TR/EN), tek kullanımlıktır ve sıfırlamadan sonra kullanıcının tüm oturumları kapatılır.
E-posta ayarlı değilse özellik gizlenir; API `MAIL_NOT_CONFIGURED` döner. Adresi henüz kanıtlanmamış bir hesapta
postayla gelen bağlantıyla yapılan **ilk** sıfırlama adresin kanıtı sayılır ve hesapta önceden kurulanları siler
([aşağıda](#adresin-ilk-kanıtı)).

E-postası çalışmayan bir kurulumda parolasını unutan yönetici için sunucuda:

```bash
sudo sh scripts/install.sh reset-password eposta@ornek.com
```

Komut yeni parolayı bir kez gösterir; `--disable-2fa` eklenirse iki adımlı doğrulamayı da kapatır.

## İki adımlı doğrulama
Hesabım → Güvenlik'ten açılır (better-auth `twoFactor` eklentisi):
- **Doğrulayıcı uygulama (TOTP):** kurulumda QR kod ve elle girilecek anahtar gösterilir. Açmadan önce
  ilk kod doğrulanır.
- **Yedek kodlar:** 10 adet, her biri bir kez kullanılır. Kopyalanabilir, indirilebilir ve parolayla yeniden üretilebilir.
- **SMS veya e-posta kodu:** telefonu doğrulanmış kullanıcıya SMS ile, yoksa e-postayla gider (docs/settings.md).
  Kod 5 dakika geçerlidir.
- **Bu cihaza güven:** 30 gün boyunca bu tarayıcıda ikinci adım sorulmaz.
- **Kilitlenme:** 10 hatalı denemeden sonra doğrulama 15 dakika kilitlenir.
- Passkey ile giriş, iki adımlı doğrulamanın yerini tutar.
- İki adımlı doğrulaması açık hesaplar e-posta koduyla ya da giriş bağlantısıyla giremez (`TWO_FACTOR_USE_PASSWORD`):
  posta kutusundaki bir bağlantı tek etkendir.
- **Denetim kaydı:** iki adımlı doğrulaması olan bir hesabın doğru parolası henüz bir giriş değildir; ayrı bir
  eylemle, `auth.password_step` olarak yazılır ve giriş bildirimi göndermez. `auth.login / success` her zaman bir
  oturumun gerçekten açıldığı anlamına gelir (ikinci adımdan sonra).

İçgörüler, iki adımlı doğrulaması kapalı yöneticileri gösterir.

## Telefon numarası
Kullanıcı numarasını SMS koduyla doğrular (better-auth `phoneNumber` eklentisi; E.164 biçimi; kod 5
dakika geçerli, en fazla 5 deneme). Eklenti yalnızca bunun için açıktır: kod yalnızca oturum açmış kişiye gönderilir
ve yalnızca onun numarasını doğrular; telefon numarasıyla giriş ve telefonla parola sıfırlama rotaları kapalıdır
(`404`). Doğrulanmış numaraya SMS ile iki adımlı doğrulama kodu ve SMS
bildirimleri gönderilebilir. SMS ayarlanmamışsa bu bölüm bilgilendirme gösterir.

## E-posta adresi doğrulama
Kayıtla açılan hesap, adresi doğrulanmamış olarak başlar. Panel posta gönderebiliyorsa (Ayarlar → E-posta açık ve
orada "Adres doğrulama" işaretli; varsayılan işaretlidir) kayıttan hemen sonra adrese **altı haneli bir kod**
gönderir. Kod 30 dakika geçerlidir; postadaki bağlantı Hesabım → Profil'i kodu doldurulmuş olarak açar.

- **Kod yalnızca o hesabın oturumunda geçer** (`POST /api/account/email-verification/confirm`). Böylece hesabın
  parolasını bilen kişinin posta kutusunu da okuduğu gösterilmiş olur: hesabı kuran ile adresin sahibi aynı kişidir,
  bu yüzden **hesapta hiçbir şey silinmez** ([ilk kanıt](#adresin-ilk-kanıtı)'ın tersine). Bağlantıyı oturumu
  olmayan biri açarsa giriş sayfasına düşer; adresi başkasının kaydettiği kişi hesabı yine "Parolamı unuttum" ile
  alır ve o zaman ilk kanıtın temizliği işler.
- **Hesabım → Profil** doğrulanmamış adresi uyarıyla gösterir; "Doğrulama kodu gönder" / "Yeni kod gönder" düğmesi
  ve kod alanı oradadır. Hesap menüsünde Profil işaretlenir. Yeni kod öncekini geçersiz kılar.
- **Sınırlar (hesap başına):** dakikada 1, saatte 5, günde 10 posta (kayıt sırasında giden ilk posta da sayılır);
  bir kod 5 kez, hesap günde 20 kez denenebilir. Yanlış, süresi dolmuş, kullanılmış ya da hiç gönderilmemiş kod
  aynı yanıtı alır (`VERIFICATION_CODE_INVALID`). Kod Redis'te özet olarak, hesaba ve gönderildiği adrese bağlı
  tutulur: adres bu arada değiştirildiyse eski adrese giden kod yeni adresi doğrulamaz.
- **Adres taraması yapılamaz:** üç rota da yalnızca oturum açmış hesabın kendisi hakkında yanıt verir; oturumsuz
  istek `401` alır ve hiçbiri bir adresin kayıtlı olup olmadığını söylemez.
- Kullanıcı adına oturum açmış personel ve API anahtarları doğrulama yapamaz (`NOT_WHILE_IMPERSONATING`,
  `TOKEN_NOT_ALLOWED`). Personel bir adresi Yönetim → Kullanıcılar → kullanıcı → "Doğrulanmış işaretle" ile,
  kendi adıyla denetim kaydına geçerek işaretler.
- **Sipariş kuralı (varsayılan kapalı):** Ayarlar → Giriş güvenliği → "Yalnızca e-posta adresi doğrulanmış hesaplar
  sipariş verebilsin" açıldığında adresi doğrulanmamış hesabın siparişi `403 EMAIL_NOT_VERIFIED` ile reddedilir
  ve sipariş sayfası nedenini, Profil'e bağlantıyla söyler. Bayinin müşterisi için verdiği siparişte bayinin kendi
  adresine bakılır; dış faturalama sisteminin (WISECP / WHMCS) siparişlerine bakılmaz.
- **E-posta ayarlı değilse özellik görünmez:** Profil'de bölüm çıkmaz, rotalar `MAIL_NOT_CONFIGURED` döner ve
  sipariş kuralı açık olsa bile uygulanmaz (kimse doğrulayamazdı). `.env` içindeki eski `SMTP_URL` ile çalışan
  kurulumlarda da böyledir: doğrulama postası için e-postanın Ayarlar → E-posta'dan açılması gerekir.
- Eski yollarla kanıtlanmış adresler (aşağıdaki ilk kanıt; kurulum yöneticisi; personelin, dizinin, SSO'nun ve
  faturalama entegrasyonunun açtığı hesaplar) doğrulanmış kalır.
- Denetim kaydı: `auth.email_verification_sent`, `auth.email_verified` (başarı ve hatalı kod).

Kod: `apps/api/src/address-check.ts` (kurallar), `email-verification.ts` (rotalar); testler
`apps/api/test/integration/email-verification.test.mjs`.

**Denenmeyen:** gerçek bir posta sunucusuyla gönderim (testler bu makinedeki sahte bir SMTP sunucusunu kullanır) ve
tarayıcıda kodun girilip adresin doğrulanması (tarayıcı testlerinin kurulumunda posta alan bir sunucu yoktur; orada
bölümün görünmesi, gönderimin başarısızlığı, yanlış kod, sipariş kuralı ve personel işaretleyince bölümün kalkması
denenir).

## Adresin ilk kanıtı
Kayıttaki doğrulama kodu girilene kadar adres doğrulanmamıştır; bu yüzden bir hesabı ilk açan kişi adresin sahibi olmayabilir (açık
kayıtta herkes başkasının adresiyle hesap açabilir; bayi müşterisinin adresini kendisi yazar). Adresi hiç
doğrulanmamış bir hesapta, posta kutusuna ulaşabildiğini gösteren **ilk** işlem adresi sahibi tarafından kanıtlanmış
sayar. Kanıt sayılan üç yol:

- giriş bağlantısıyla giriş (Ayarlar'dan açılır, varsayılan kapalıdır);
- e-posta koduyla giriş (Ayarlar'dan açılır, varsayılan kapalıdır);
- postayla gelen bağlantıyla **parola sıfırlama** ("Parolamı unuttum"). Adresi başkasının kaydettiği bir hesaba gerçek
  sahibinin girmesinin en yaygın yolu budur. Aynı anda gelen iki sıfırlama ya da bir sıfırlamayla bir bağlantı kanıtı
  yalnızca bir kez işler.

O anda, hesapta o zamana kadar kurulmuş olanlar **bir kez** silinir:

- parola (sıfırlamada az önce belirlenen yeni parola kalır) ve bağlı girişler (sosyal hesaplar), diğer oturumlar;
- API anahtarları, passkey'ler, webhook'lar;
- mesajlaşma uygulaması bağlantıları ve tarayıcı bildirimi abonelikleri;
- telefon numarası;
- kurulmuş ama **açılmamış** bir iki adımlı doğrulama. Açık olan kalır: böyle bir hesap zaten bağlantı ya da kodla
  giremez, ikinci etkenini de bu yolla yitirmez (onu personel sıfırlar);
- **kayıtlı SSH anahtarları:** yeni sunucuya ve yeniden kuruluma verilen anahtarlar bunlardır; önceki kişinin anahtarı
  onu sunucunun içine sokardı;
- **kayıtlı kartlar:** önceki kişinin kartı, sahibin siparişleri ve otomatik tahsilat için çekilirdi. Otomatik
  yenileme için müşterinin yeniden kart eklemesi gerekir; o zamana kadar yenileme yalnızca bakiyeden denenir;
- **fatura e-postası ve telefonu** (faturaların ve ödeme bildirimlerinin hesabın adresi dışında gittiği yer). Fatura
  bilgilerinin geri kalanı durur;
- yarıda kalmış **ikinci adım** (parolası girilmiş, kodu bekleyen giriş) ve "bu cihaza güven" kayıtları;
- hesabın başka hesaplara yaptığı, **henüz kabul edilmemiş sunucu devri teklifleri** (iptal edilir; sahibi yeniden
  karar verir).

**Kalanlar ve personele not.** Sunucular, kişisel imajlar, bakiye, talepler, faturalar ve fatura bilgileri hesabındır
ve geri alınamayacağı için silinmez; sahibi hepsini panelde görür. Ama bunları başka biri kurmuş olabilir (bir root
parolasını biliyor ya da sunucunun içinde anahtarı duruyor olabilir). Bu yüzden kalanların sayıları denetim olayına
(`auth.address_proven`, `kept`) yazılır ve hesapta sunucu, imaj ya da bakiye hareketi varsa kullanıcıya bir **ekip
notu** düşülür (Yönetim → Kullanıcılar → kullanıcı). Böyle bir hesapta sunucuların parolalarını ve anahtarlarını
değiştirmek ya da sunucuyu yeniden kurmak sahibine kalır; panel bunu kendiliğinden yapmaz.

Olay denetim kaydına `auth.address_proven` olarak, hangi yolla kanıtlandığıyla (`magic-link`, `email-code`,
`password-reset`) yazılır; sonrasında adres doğrulanmıştır ve bir daha hiçbir şey silinmez. Parolayla kaydolup
sonradan bağlantı ya da kodla giren müşteri "Parolamı unuttum" ile yeni bir parola belirler. Hesaptan bir şey
silindiyse kullanıcıya `auth.credentials_reset` ("Giriş bilgileri sıfırlandı") bildirimi gider (varsayılan kanallar
panel ve e-posta): ne olduğunu, neyin kaldırıldığını, yeni parolanın nasıl belirleneceğini ve otomatik yenileme için
yeniden kart eklenmesi gerektiğini söyler. Silinecek hiçbir şeyi olmayan hesaba bildirim gitmez.

**Baştan kanıtlanmış sayılan hesaplar.** Bir yabancının önceden kaydedemeyeceği hesaplarda silinecek "önceki kişi"
yoktur; bunlar açılırken kanıtlanmış işaretlenir:

- kurulum yöneticisi (kurulum anahtarını ya da betiği elinde tutan kişi açar);
- personelin Yönetim → Kullanıcılar'dan açtığı hesaplar;
- SSO, dizin ve faturalama entegrasyonu üzerinden gelen hesaplar (önceden de böyleydi).

Bayinin açtığı müşteri hesapları kanıtlanmamış başlar: adresi bayi yazmıştır, kimse kanıtlamamıştır.

**Yükseltmeden önce açılmış hesaplar.** Migration `085`, personelin zaten kefil olduğu hesapları yükseltme sırasında
kanıtlanmış işaretler: müşteri rolü (`user`) dışında bir rolü olan her hesabı (rolü personel, kurulum sihirbazı ya da
dizin eşlemesi verir; kayıt vermez) ve denetim kaydında `admin.user.create` satırı bulunan, yani Yönetim →
Kullanıcılar'dan açılmış hesapları. Böylece bir yöneticinin ilk "Parolamı unuttum" sıfırlaması passkey'lerini ve API
anahtarlarını silmez. Diğerlerinin işareti değişmez: kayıtla açılmış müşteri hesapları ve bayinin açtığı müşteri
hesapları kanıtlanmamış kalır ve yukarıdaki silme, adreslerini ilk kanıtladıklarında bir kez uygulanır. Faturalama
entegrasyonunun hesaplarına migration dokunmaz; entegrasyon onları açarken işaretler. Personelin bir adresi Yönetim →
Kullanıcılar'dan elle doğrulanmış işaretlemesi sahibin kanıtı değildir ve hiçbir şeyi silmez; işaretlenen hesapta
sonraki sıfırlama da bir şey silmez.

**Sunucu devralma kanıt ister.** Devir teklifi bir adrese yapılır; sunucu (diski ve konsoluyla) o adresi ilk
kaydedene değil, adresin kendisine ait olduğunu kanıtlayana gider. Adresi kanıtlanmamış bir hesap teklifi kabul
edemez: `403 ADDRESS_NOT_PROVEN`. Hiçbir şey taşınmadan reddedilir ve teklif bir haftalık süresi boyunca açık kalır;
kullanıcı adresini yukarıdaki yollardan biriyle kanıtlayıp yeniden kabul eder.

Parola sıfırlamanın kanıt sayılması, silinenler, baştan kanıtlanmış hesaplar ve migration `085` üç `security-auth`
entegrasyon testindedir; devir kuralı `security-servers` testlerine eklendi. Hepsi 2026-11-18 tarihli tam çalıştırmada
geçti (`eaa0a4e`; 196 testten 192'si geçti, 4'ü atlandı).

## Yalnızca yöneticinin değiştirebildiği ayarlar
E-posta ve SMS kanalları, yöneticiler dahil her hesabın sıfırlama bağlantısını ve kodunu taşır. Bu yüzden
`settings.manage` izni olan ama yönetici (`*`) olmayan personel şunları yapamaz (`403`):

- e-posta ayarlarını ve SMS ayarlarını kaydetmek;
- giriş bağlantısıyla ya da e-posta koduyla girişi **açmak** (kapatabilir);
- iki adımlı doğrulama zorunluluğunu **düşürmek** (herkes → personel → hiç kimse yönünde);
- CAPTCHA'yı zayıflatmak: kaldırmak, bir formdan almak ya da en düşük skoru indirmek;
- kaydedilmemiş bir özel (HTTP) SMS sağlayıcısını test etmek. Kayıtlı olanı test edebilir ve yalnızca testin geçip
  geçmediğini öğrenir.

Dizin ve SSO ayarlarındaki rol eşleme kuralı ayrıdır (aşağıda, `FORBIDDEN_TARGET`).

## Son giriş yöntemi
Giriş sayfası son kullanılan yöntemi (parola veya passkey) işaretler. Bu bilgi kullanıcı listesinde de görünür.

## Bot koruması (isteğe bağlı)
Ayarlar → Bot koruması'ndan yönetilir: Turnstile, reCAPTCHA v2/v3 veya hCaptcha; giriş, kayıt ve
parola sıfırlama formları için ayrı ayrı açılır (docs/settings.md).

## CSRF
GET/HEAD/OPTIONS dışındaki her istekte (`/api/auth/*` dahil) iki koşul aranır:
- `X-Lightning-CSRF: 1` başlığı zorunludur. Başka bir siteden bu başlıkla istek atmak
  CORS ön kontrolü (preflight) gerektirir ve API buna hiç izin vermez.
- `Origin` başlığı varsa, `Host` ile aynı olmalıdır.

Bu koşullar sağlanmazsa API `403 CSRF_REJECTED` döner. better-auth ayrıca çerezli isteklerde
`Origin` başlığını kendisi de kontrol eder.

## Parolalar
- Algoritma: Node.js `crypto.scrypt` (N=2^17, r=8, p=1; OWASP önerisi). Ek bir native
  bağımlılık gerekmez.
- Parametreler her hash'in içinde saklanır; ileride güçlendirilebilir.
- Uzunluk: en az 12, en fazla 256 karakter. Doğrulama sunucuda yapılır; alan hata kodları
  arayüzde çevrilir.
- Yanlış parola ve kayıtlı olmayan e-posta için yanıt aynıdır: `401 INVALID_EMAIL_OR_PASSWORD`.
  İkisi de denetim kaydına `auth.login / failure` olarak yazılır.

## Hız sınırları (Redis, sabit pencere)
| Uç nokta | Sınır |
|---|---|
| Giriş, IP başına | 30 / 15 dk |
| Giriş, e-posta başına | 10 / 15 dk |
| Kayıt, IP başına | 5 / saat |
| Parola sıfırlama isteği, IP başına | 5 / saat |
| Parola sıfırlama postası, posta kutusu başına (hesap olsun olmasın sayılır) | 5 / saat |
| Telefon doğrulama kodu (SMS), hesap başına ve numara başına | 5 / gün |
| İki adımlı doğrulama kodu (SMS ya da e-posta), hesap başına | 8 / saat |
| Adres doğrulama postası, hesap başına | 1 / dk, 5 / saat, 10 / gün |
| Adres doğrulama kodu denemesi, hesap başına (ayrıca kod başına 5) | 20 / gün |
| Bildirim testi, hesap başına (SMS'te ayrıca numara başına, mesajlaşmada ayrıca adres başına) | 6 / saat |
| Mesajlaşma bağlantısı kurma ve bağlantı testi, hesap başına | 20 / saat |
| Kart ödemesi başlatma, hesap başına (bütün faturaları için ortak) | 20 / saat |
| Dizin ayarı testi (e-posta ve parolayla), e-posta başına | girişin e-posta sınırından düşer (10 / 15 dk, ortak) |
| Kayıtlı görünüm kaydetme, değiştirme, silme, kişi başına | 120 / 10 dk |
| Müşterinin talep yanıtı ve puanı | talep başına 10, müşteri başına 30 / 10 dk |
| Diğer `/api/auth/*`, IP başına | 100 / dk |
| Kurulum, IP başına | 10 / 15 dk |

Sınır aşılırsa `429` döner. Redis'e ulaşılamazsa istek reddedilir; sınırlayıcı devre dışı kalıp
girişe izin vermez.

## Kayıt
Varsayılan olarak kapalıdır (`settings.registration_open = false`). Yönetici panelden açar;
bu değişiklik denetim kaydına yazılır. Kayıtta aynı e-posta varsa `USER_ALREADY_EXISTS` döner.
Bu, e-postanın kayıtlı olduğunu açığa çıkarır; açık kayıtlı bir panel için kabul edilen bir
ödünleşimdir.

## Migration'lar
- Dosyalar `apps/api/migrations/NNN_ad.sql` biçimindedir.
- Compose'daki `migrate` servisi bunları `node dist/cli.js migrate` ile uygular. API ve worker
  ancak bu servis başarıyla bitince başlar.
- Her dosya kendi transaction'ında çalışır ve `schema_migrations` tablosuna kaydedilir.
  `pg_advisory_lock` aynı anda iki migration çalışmasını engeller.
- Uygulanmış bir migration dosyası değiştirilmez; düzeltme için yeni dosya eklenir.
- `001_init.sql` eski `docker-entrypoint-initdb.d` şemasını `IF NOT EXISTS` ile devralır.
  Böylece önceki kurulumlar da bozulmadan migration sistemine geçer.

## Testler
- `apps/api`, `npm test`: veritabanı gerektirmeyen kontroller (CSRF, doğrulama, 401, hata kodları).
- `apps/api`, `npm run test:integration`: gerçek PostgreSQL ve Redis ile çalışır.
  `TEST_DATABASE_URL` adı `*_test` ile biten bir veritabanını, `REDIS_DB` ise `15`'i
  göstermelidir; yoksa test başlamaz. Test şemayı ve o Redis DB'sini **siler**.
- `apps/web`, `npm run test:e2e`: çalışan bir Compose kurulumuna karşı Playwright testleri.
  Boş kurulumda `E2E_BOOTSTRAP_TOKEN` gerekir.

## Henüz yok
- Organizasyon / ekip yapısı: bir projeyi ya da sunucuyu birden çok kullanıcı paylaşamaz. (Bayiler vardır: bayi kendi
  müşteri hesaplarını açar ve onların sunucularını yönetir; `apps/api/src/reseller.ts`. Müşteri hesabını kimin
  yönettiğini Hesabım → Profil'de görür, bir kez bildirim alır ve bayiden ayrılabilir;
  [billing.md](billing.md#bayiler-kim-öder).)
- SSO sağlayıcısında kapatılan bir hesabın **kişisel API anahtarları** panele hemen bildirilmez: en geç
  `DIRECTORY_TOKEN_DAYS` gün sonra durur. Dizin (LDAP) hesaplarında panel dizine kendisi sorar
  ([aşağıda](#dizin-ldap--active-directory-ile-giriş)).

## Hesap verileri ve ekip notları
- **Verilerimi indir** (Hesap sayfası, `GET /api/account/export`): oturum açan kişi hakkında panelin tuttuğu her şey
  tek bir JSON dosyası olarak iner: profil, sunucular, favoriler, projeler, SSH anahtarları, konsol komutları,
  firewall'lar, kayıtlı görünümler, bildirim tercihleri ve son bildirimler, bağlı mesajlaşma uygulamaları, oturumlar,
  etkinlik kaydı ve benzerleri. Parola özetleri, oturum anahtarları, root parolaları, iki adımlı doğrulama sırları ve mesajlaşma
  uygulaması adresleri dosyada yoktur.
- **Ekip notları** (Yönetim → Kullanıcılar → kullanıcı): personel bir kullanıcıya not düşer; notlar sabitlenebilir,
  sabitlenen not kullanıcı listesinde görünür. Müşteri bu notları görmez; dışa aktarılan verilere de girmez.

## Rol sınırları
Rol, izinlerin yanında sınırlar da taşır (Roller → Düzenle → Sınırlar; kod: `apps/api/src/role-limits.ts`). Boş alan sınırsızdır;
birden çok rolü olan kullanıcıya en geniş olanı uygulanır (iki adımlı doğrulama ise herhangi bir rol isterse zorunludur).
Yöneticiler (`*`) sınırsızdır. API'nin uyguladıkları:
- **Kota:** en fazla sunucu, vCPU, RAM, disk (kullanıcının veya projenin kendi kotası varsa o geçerli).
- **Adetler:** sunucu başına anlık görüntü (varsayılan 5), firewall, SSH anahtarı.
- **Hız:** kendi sunucularında saatte başlatılabilen işlem sayısı (oluşturma, güç, snapshot).
- **Oturum:** girişten sonra oturumun en uzun süresi; zorunlu iki adımlı doğrulama.
- **Erişim:** sipariş verilebilecek konumlar; giriş yapılabilecek IP/CIDR listesi (kaydeden kişi kendini dışarıda bırakamaz).

Sunucu üzerindeki müşteri işlemleri de izindir: `server.power`, `server.console`, `server.delete`, `server.snapshots`,
`server.iso`, `server.root_password`. Ayarlar → Sunucular'daki genel anahtar kapalıysa izin olsa da işlem yapılamaz.
Bu müşteri izinleri "personel" sayılmaz ve personelin bir kullanıcı üzerinde işlem yapabilme kontrolüne girmez.

## Anlık değişiklikler
Açık sekmeler `GET /api/live` (Server-Sent Events) ile dinler (`live.ts`, `live-bus.ts`, web: `components/live-events.tsx`).
Yasaklama, yöneticinin parola ataması (hesabın tüm oturumları kapanır), parola değişikliği, oturum iptali ve hesap silme
sekmeyi gerekçesiyle giriş sayfasına gönderir; rol/izin ve giriş politikası değişiklikleri menüyü ve sayfayı yeniler;
yeni bildirim zili hemen çaldırır. Birden çok API kopyası Redis yayınıyla haberleşir.

## Dizin (LDAP / Active Directory) ile giriş
Ayarlar → Dizin (kod: `ldap.ts`, `directory-signin.ts`, `directory.ts`). Giriş formundaki e-posta ve parola, dizin hesapları
(ve "ilk girişte oluştur" açıksa hiç hesabı olmayanlar) için dizinde doğrulanır: salt okuma servis hesabı kişiyi e-postasıyla
bulur, ardından kişinin kendi parolasıyla bind denenir. Başarılı girişte hesap oluşturulur ya da adı ve (grup eşlemesi varsa)
rolleri güncellenir; ardından better-auth'un normal girişi sürer, böylece iki adımlı doğrulama, oturumlar, hız sınırları ve
denetim kaydı herkes için aynıdır. Dizin hesaplarının parolası panelde değiştirilemez veya sıfırlanamaz; dizin hata verirse
eski parola özetiyle de girilemez. Kural oturumun oluşturulduğu yerde uygulanır: dizin hesabına yalnızca dizinin o
girişi kabul ettiği anda oturum açılır; e-posta kodu, giriş bağlantısı, passkey, bağlı sosyal hesap ya da kullanıcı
adıyla girilemez (`PASSWORD_MANAGED_BY_DIRECTORY`) ve dizin girişi kapalıyken dizin hesapları hiç giremez. Dizine,
adres kuralı, CAPTCHA ve e-posta başına hız sınırından **sonra** sorulur. Dizin ayarını kaydeden kişinin
izinleri, eşlenen her rolün (varsayılan rol ve grup eşlemeleri) izinlerini kapsamalıdır; yalnızca yöneticiler
`admin` rolüne eşleyebilir (`403 FORBIDDEN_TARGET`). LDAP adresi değişirse bind parolası yeniden girilir; test
sonucunda dizin sunucusunun metni gösterilmez, ayrıntı API günlüğüne `ldap_test_failed` olarak yazılır. Yerel hesaplar (ilk yönetici gibi) etkilenmez. Testler gerçek bir OpenLDAP ile çalışır
(`LDAP_TEST_URL`).

Dizin ve SSO için ortak, sonradan eklenen kurallar:

- **Oturum süresi sabittir:** dizin ve SSO hesabının oturumu açıldıktan `SESSION_TTL_HOURS` saat sonra biter
  ([yukarıda](#oturumlar-better-auth)). Dizinde kapatılan bir hesabın paneldeki oturumu en geç o kadar sürer.
- **Sunucuyu adlandıran kişi, arkasındaki her hesabı kapsamalıdır.** Burada kaydedilen sunucu, panelde zaten hesabı
  olan herkesin kim olduğunu da söyler; böyle bir hesap paneldeki rolleriyle ve kişiye özel istisnalarıyla girer.
  Sunucuyu adlandırabilen biri oraya kendi sunucusunu yazıp o hesaplardan biri olarak girebilirdi. Bu yüzden dizin
  ya da SSO ayarını kaydeden kişinin izinleri, eşlemenin yanında, o kaynaktan giren (`auth_source` `ldap` ya da
  `oidc`) **her hesabın** etkin izinlerini kapsamalıdır; aksi halde `403 FORBIDDEN_TARGET` döner (alan hatası
  `ACCOUNTS_NOT_COVERED`) ve ret `settings.directory` / `settings.sso` olarak denetim kaydına yazılır. Her kayıtta
  denetlenir; yöneticiler her hesabı kapsar. Dizinden giren bir yönetici varsa ayarı yalnızca yöneticiler
  kaydedebilir.
- **Silinen rol eşlemelerden çıkar.** Bir rol silindiğinde dizin ve SSO eşlemeleri de güncellenir: o rolü veren grup
  satırları rolü kaybeder, hiç rolü kalmayan satır kalkar, varsayılan rol o rolse `user` olur. Böylece sonradan aynı
  anahtarla açılan bir rol, eski eşlemenin verdiği herkese kendiliğinden geçmez.
- **Hesabı olmayan adres dizine tek yazımla sorulur.** Hesabı olan kişi tam adresiyle bulunur ve denemeleri tek
  anahtarda sayılır. Dizin ise adresleri gevşek karşılaştırır (görünmez karakterler yok sayılır, her tür boşluk tek
  boşluktur, uyumluluk biçimleri katlanır); aynı posta kutusu, her biri kendi giriş sınırına sahip sayısız biçimde
  yazılabilirdi. "İlk girişte oluştur" açıkken hesabı olmayan bir adres dizine yalnızca düz yazımıyla sorulur: boşluk,
  denetim ya da görünmez karakter içermeyen ve birleşik (NFKC) biçimindeki adres. Başka yazımlar dizine sorulmadan
  "hatalı e-posta ya da parola" yanıtı alır.
- **Ayar testi giriş denemesi sayılır.** Ayarlar → Dizin'deki test bir e-posta ve parolayla yapıldığında o kişinin
  dizin parolasına bir tahmindir; adresin giriş sınırından düşer (15 dakikada 10, giriş formuyla ortak sayaç).
  Parolasız test (yalnızca bağlantı ve arama) sayılmaz.
- **Kimlik belirteciyle giriş reddi sürüyor:** sağlayıcının kimlik belirtecini doğrudan göndererek giriş ya da bağlama
  yeniden denetlendi ve reddediliyor.
- **API anahtarları kaynağın doğrulamasına bağlıdır (`DIRECTORY_TOKEN_DAYS`).** Kişisel API anahtarı oturum değildir:
  her oturumdan uzun yaşar ve kullanmak için kimse giriş yapmaz; panele de kişinin dizinden çıkarıldığı bildirilmez.
  Bu yüzden dizin (`ldap`) ya da SSO (`oidc`) hesabının anahtarı yalnızca hesap, kaynağında son
  `DIRECTORY_TOKEN_DAYS` gün içinde doğrulanmışsa kabul edilir (`.env`; varsayılan 30, 0-3650, `0` kuralı kapatır).
  Değilse istek `401 TOKEN_ACCOUNT_UNCONFIRMED` yanıtı alır. Anahtar silinmez, **uykudadır:** bir sonraki doğrulamada
  yeniden çalışır. Yerel hesapların (parolası panelin olanların) anahtarları hiç uyumaz.
  - **Doğrulama** `users.source_confirmed_at` alanına yazılır (migration `086`): dizinin ya da sağlayıcının kabul
    ettiği her giriş onu şimdiye çeker. Yükseltme anında var olan dizin ve SSO hesapları o an doğrulanmış sayılır,
    yani süre yükseltmeden başlar.
  - **LDAP'ta panel dizine kendisi sorar** (`reconfirmDirectory`, `directory-signin.ts`): anahtar kullanıldığında,
    son doğrulamanın üstünden bir gün geçtiyse ya da anahtar uykudaysa, servis hesabıyla kişiyi e-postasından arar;
    hesap başına en çok saatte bir. **Bulunursa** doğrulama yenilenir: yalnızca API kullanan bir dizin hesabının
    panele girmesi gerekmez. **Arama çalışır ve kimseyi bulamazsa** doğrulama alınır: hesabın anahtarları o andan
    itibaren uykudadır (kişi dizinin kabul ettiği bir giriş yapana kadar) ve denetim kaydına
    `auth.directory_user_missing` yazılır. **Diğer her durumda** (dizin girişi kapalı, dizin yanıt vermedi, yanıt
    belirsiz, aynı saat içinde zaten soruldu) hiçbir şey değişmez ve yaş sınırı karar verir. Uykuda olmayan bir
    anahtarda soru arka planda sorulur: hesabın bulunamadığını öğrenen istek yanıtını alır, sonraki istekler
    reddedilir.
  - **SSO'da sorulacak bir yer yoktur:** bu hesaplarda yalnızca yaş sınırı vardır; kişi en az o kadar sık panele SSO
    ile girmelidir.
  - **Panelde:** Hesabım → Geliştirici'deki anahtar listesi ve Ayarlar → API'deki "Tüm anahtarlar" listesi uykudaki
    anahtarı "Uykuda" diye işaretler (`asleep` alanı, değeri ret kodu). Dizin ya da SSO hesabı kendi sayfasında
    anahtarlarının ne zamana kadar çalışacağını okur (`GET /account/api-tokens` yanıtında `confirmation`: `source`,
    `days`, `confirmedAt`, `until`).
  - Dizinden çıkardığınız kişinin erişimini hemen kesmek istiyorsanız yine panelde yasaklayın ya da anahtarlarını
    silin: dizine en çok saatte bir ve son doğrulamadan bir gün sonra sorulur.

Bu kurallar `ldap` birim testlerinde ve iki `security-auth` entegrasyon testindedir; ikisi de 2026-11-18 tarihli tam
çalıştırmada geçti. API anahtarının yaş kuralı `ldap` birim testlerinde ve bir `security-leftovers-2` entegrasyon
testindedir (2026-11-19 tarihli tam çalıştırmada geçti); bu test doğrulama tarihini veritabanında doğrudan değiştirir,
dizin kurulu değildir.
Gerçek bir dizin sunucusunda (Active Directory, OpenLDAP) ve gerçek bir SSO sağlayıcısında denenmedi. **Dizine sorma
yolunun (`reconfirmDirectory`) kendi testi yoktur** ve gerçek bir LDAP sunucusuna karşı çalıştırılmadı: dizinin
"bulundu", "bulunamadı" ve hata yanıtlarında olanlar yalnızca kaynaktan okundu.

## Tek oturum açma (OpenID Connect)
Ayarlar → Dizin → Tek oturum açma: issuer adresi (panel `/.well-known/openid-configuration` belgesini okur), client ID
ve secret (şifreli saklanır), kapsamlar, grup alanı ve grup → rol eşlemesi. Sağlayıcıya kaydedilecek yönlendirme
adresi `https://<panel>/api/auth/callback/oidc`. Akışı better-auth'un `genericOAuth` eklentisi yürütür (kod akışı,
PKCE, kimlik belirtecinin imzası sağlayıcının anahtarlarıyla doğrulanır); ayar kaydedilince better-auth yeniden
kurulur, yeniden başlatma gerekmez. SSO hesapları kendine aittir (`auth_source = 'oidc'`): bir panel ya da dizin
hesabının e-posta adresi sağlayıcı tarafından ele geçirilemez, bağlama reddedilir. Roller her girişte gruplara
göre güncellenir (eşleme varsa), rolün adres sınırları uygulanır; parola panelde değiştirilemez/sıfırlanamaz ve
panel bu hesaplardan kendi iki adımlı doğrulamasını istemez. SSO hesabına yalnızca sağlayıcının geri dönüş
(`/callback`) akışından oturum açılır; e-posta kodu, giriş bağlantısı, passkey ya da gönderilen bir kimlik belirteci
ile girilemez. Ayarı kaydetmek için dizindeki aynı rol kuralı ve hesapları kapsama kuralı geçerlidir
(`FORBIDDEN_TARGET`; [yukarıda](#dizin-ldap--active-directory-ile-giriş)); issuer değişirse
client secret yeniden girilir. SSO hesabının oturumu da açıldıktan `SESSION_TTL_HOURS` saat sonra biter. Testler süreç içinde çalışan sahte bir sağlayıcıyla
(RS256 imzalı belirteç) yapılır. Kod: `apps/api/src/sso.ts`, `directory.ts`.
