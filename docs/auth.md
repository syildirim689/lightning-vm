# Kimlik doğrulama, roller ve ilk kurulum

## Roller
- `admin`: yönetim paneli ve `/api/admin/*` uç noktaları.
- `user`: kullanıcı paneli. Yönetici API'leri `403 FORBIDDEN` döner; her ret
  `audit_events` tablosuna `admin.access / denied` olarak yazılır.

Rol kontrolü API'de yapılır (`AdminGuard`). Web arayüzündeki kontrol yalnızca gereksiz sayfa
göstermemek içindir; güvenlik sınırı değildir.

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

## Bot koruması (isteğe bağlı)
`TURNSTILE_SITE_KEY` ve `TURNSTILE_SECRET_KEY` tanımlıysa giriş, kayıt ve parola sıfırlama
formları Cloudflare Turnstile doğrulaması ister. Tanımlı değilse kapalıdır.

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
- TOTP tabanlı iki adımlı doğrulama (MFA).
- E-posta doğrulama.
- SMTP olmadan yönetici parolası kurtarma.
