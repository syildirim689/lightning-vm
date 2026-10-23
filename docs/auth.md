# Kimlik doğrulama, roller ve ilk kurulum

## Roller
- `admin`: yönetim paneli ve `/api/admin/*` uç noktaları.
- `user`: kullanıcı paneli. Yönetici API'leri `403 FORBIDDEN` döner; her ret
  `audit_events` tablosuna `admin.access / denied` olarak yazılır.

Rol kontrolü API'de yapılır (`AdminGuard`). Web arayüzündeki kontrol yalnızca gereksiz sayfa
göstermemek içindir; güvenlik sınırı değildir.

## İlk yönetici (güvenli bootstrap)
1. `scripts/install.sh` servisleri başlatır. Henüz yönetici yoksa terminale **1 saat geçerli**
   bir kurulum anahtarı yazar. Anahtar log dosyasına yazılmaz.
2. Anahtarı yalnızca sunucuda komut çalıştırabilen kişi alabilir. Yeni anahtar üretmek için:
   ```sh
   docker compose exec api node dist/cli.js bootstrap-token
   ```
   Yeni anahtar bir öncekini geçersiz kılar. Veritabanında anahtarın kendisi değil,
   yalnızca SHA-256 özeti tutulur.
3. `/setup` sihirbazında önce anahtar girilir (HttpOnly çerezde tutulur). Yönetici hesabı
   adımında e-posta ve parola girilir. API şunları yapar:
   - kurulum satırını `FOR UPDATE` ile kilitler;
   - anahtarı sabit sürede karşılaştırır ve süresini kontrol eder;
   - yöneticiyi oluşturur ve anahtarı siler.

   Aynı anda gelen istekler arasından yalnızca biri yönetici oluşturabilir; bu durum test edildi.
4. Yönetici oluştuktan sonra:
   - `POST /setup/admin` her istekte `409 SETUP_CLOSED` döner;
   - CLI yeni anahtar üretmez;
   - sihirbaza yalnızca yönetici oturumuyla devam edilir;
   - sihirbaz tamamlanınca `/setup` sayfası `/login` sayfasına yönlendirir (docs/setup.md).

   Kurulum betiği tekrar çalıştırıldığında yöneticiye ve sırlara dokunmaz.

`sh scripts/install.sh recover-setup` yalnızca sihirbazı yeniden açar. Yönetici parolasını
unutma durumu için kontrollü bir kurtarma işlemi henüz yok.

## Oturumlar
- Girişte 32 baytlık rastgele bir anahtar üretilir. Cookie (`lvm_session`) bu anahtarı taşır;
  veritabanında yalnızca SHA-256 özeti saklanır.
- Cookie bayrakları: `HttpOnly`, `SameSite=Lax`, `Path=/`. İstek HTTPS ile geldiyse `Secure`
  da eklenir. Bunu Caddy'nin `X-Forwarded-Proto` başlığı belirler; yalnızca `TRUSTED_PROXIES`
  içindeki adreslerden gelen başlığa güvenilir.
- Süre: varsayılan 12 saat (`SESSION_TTL_HOURS`). Çıkış yapınca oturum veritabanında iptal edilir.
  Süresi dolan oturumlar ve devre dışı bırakılan kullanıcılar anında reddedilir.
- Her girişte yeni bir anahtar üretilir; bu, oturum sabitleme (session fixation) saldırısını önler.

## CSRF
GET/HEAD/OPTIONS dışındaki her istekte iki koşul aranır:
- `X-Lightning-CSRF: 1` başlığı zorunludur. Başka bir siteden bu başlıkla istek atmak
  CORS ön kontrolü (preflight) gerektirir ve API buna hiç izin vermez.
- `Origin` başlığı varsa, `Host` ile aynı olmalıdır.

Bu koşullar sağlanmazsa API `403 CSRF_REJECTED` döner. Dil seçimi Next.js Server Action ile
yapılır; Next.js'in kendi Origin kontrolü buna uygulanır.

## Parolalar
- Algoritma: Node.js `crypto.scrypt` (N=2^17, r=8, p=1; OWASP önerisi). Ek bir native
  bağımlılık gerekmez.
- Parametreler her hash'in içinde saklanır; ileride güçlendirilebilir.
- Uzunluk: en az 12, en fazla 256 karakter. Doğrulama sunucuda yapılır; alan hata kodları
  arayüzde çevrilir.
- Kayıtlı olmayan bir e-postayla giriş denendiğinde de sahte bir parola doğrulaması yapılır.
  Böylece yanıt süresinden hesabın var olup olmadığı anlaşılamaz. İki durumda da yanıt aynıdır:
  `401 INVALID_CREDENTIALS`.

## Hız sınırları (Redis, sabit pencere)
| Uç nokta | Sınır |
|---|---|
| Giriş, IP başına | 30 / 15 dk |
| Giriş, e-posta başına | 10 / 15 dk |
| Kayıt, IP başına | 5 / saat |
| Kurulum, IP başına | 10 / 15 dk |

Sınır aşılırsa `429 RATE_LIMITED` döner. Redis'e ulaşılamazsa giriş reddedilir
(`503 DEPENDENCY_UNAVAILABLE`); sınırlayıcı devre dışı kalıp girişe izin vermez.

## Kayıt
Varsayılan olarak kapalıdır (`settings.registration_open = false`). Yönetici panelden açar;
bu değişiklik denetim kaydına yazılır. Kayıtta aynı e-posta varsa `409 EMAIL_TAKEN` döner.
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
- Yöneticiler için MFA.
- Parola sıfırlama ve e-posta doğrulama.
- Kullanıcı bazlı dil ve saat dilimi kaydı.
- Proje ve müşteri modeli (8. aşama).
- Oturum listesi ve "tüm oturumları kapat".
- Yönetici parolası kurtarma.
