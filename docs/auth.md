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
| `settings.view` / `settings.manage` | Marka, e-posta, CAPTCHA, SMS ve bildirim ayarları |
| `system.view`, `audit.view` | Sistem sağlığı, yedekler ve denetim kayıtları |

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
- kullanıcı adına giriş: 1 saatlik oturumdur; panelde uyarı şeridi gösterilir ve tek tıkla kendi hesabına dönülür;
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
- Kullanıcılar mevcut `users` tablosunda kalır. better-auth tabloları `auth_sessions`,
  `auth_accounts`, `auth_verifications` ve `auth_passkeys`'tir (migration 007).
  Eski parola özetleri `auth_accounts`'a taşınır; eski hesaplar aynı parolayla girer.
- Cookie: `lvm.session_token`, imzalı, `HttpOnly`, `SameSite=Lax`, `Path=/`. Panel HTTPS ile
  sunuluyorsa (`PANEL_TLS=1`, kurulum betiği ayarlar) `Secure` ve `__Secure-` öneki eklenir.
- İmza anahtarı `secrets/master.key`'den türetilir (HMAC); ayrı bir sır gerekmez.
- Süre: varsayılan 12 saat (`SESSION_TTL_HOURS`). Süresi dolan oturumlar ve devre dışı veya
  yasaklı kullanıcılar reddedilir; devre dışı kullanıcıya yeni oturum açılmaz.
- Kullanıcı Hesap sayfasında açık oturumlarını görür ve tek tek kapatabilir. Parola
  değiştirirken diğer oturumları kapatma seçeneği vardır.
- Bir oturum hangi yolla biterse bitsin (çıkış, iptal, parola sıfırlama), o oturumla açılmış
  tarayıcı konsolları da kapatılır.

## Passkey'ler
Kullanıcı Hesap sayfasından passkey ekler (`@better-auth/passkey`, WebAuthn). Giriş sayfasında
"Passkey ile giriş yap" düğmesi ve tarayıcının otomatik doldurma önerisi kullanılır. Passkey,
panelin açıldığı alan adına bağlıdır (RP ID isteğin host'undan alınır). Alan adı değişirse
passkey'ler yeniden eklenmelidir. Tarayıcılar WebAuthn'i yalnızca HTTPS'te veya `localhost`'ta
açar. Gerçek bir doğrulayıcıyla (Touch ID, Windows Hello, güvenlik anahtarı) henüz denenmedi.

## Parola sıfırlama (e-posta)
`.env` içinde `SMTP_URL` (ör. `smtps://kullanici:parola@smtp.example.com:465`) ve `MAIL_FROM`
tanımlıysa giriş sayfasında "Parolamı unuttum" bağlantısı görünür. Bağlantı e-postayla gider
(nodemailer, kullanıcının diline göre TR/EN), tek kullanımlıktır ve sıfırlamadan sonra kullanıcının
tüm oturumları kapatılır. SMTP tanımlı değilse özellik gizlenir; API `MAIL_NOT_CONFIGURED` döner.
Gerçek bir SMTP sunucusuyla henüz denenmedi.

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

İçgörüler, iki adımlı doğrulaması kapalı yöneticileri gösterir.

## Telefon numarası
Kullanıcı numarasını SMS koduyla doğrular (better-auth `phoneNumber` eklentisi; E.164 biçimi; kod 5
dakika geçerli, en fazla 5 deneme). Doğrulanmış numaraya SMS ile iki adımlı doğrulama kodu ve SMS
bildirimleri gönderilebilir. SMS ayarlanmamışsa bu bölüm bilgilendirme gösterir.

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
- E-posta adresi doğrulama.
- SMTP ve SMS olmadan yönetici parolası kurtarma (CLI ile yeni yönetici oluşturulabilir).
- Organizasyon / bayi (reseller) yapısı.

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
eski parola özetiyle de girilemez. Yerel hesaplar (ilk yönetici gibi) etkilenmez. Testler gerçek bir OpenLDAP ile çalışır
(`LDAP_TEST_URL`).
