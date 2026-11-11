# better-auth eklentileri: değerlendirme ve entegrasyon

Kurulu sürüm: **better-auth 1.7.12** (`apps/api`). Her bağlantı kurulu paketin kaynağıyla karşılaştırıldı. Panelde
açılıp kapatılabilenler **Ayarlar → Giriş yöntemleri** sekmesindedir. Değişiklik kaydedilince better-auth yeniden
kurulur, yeniden başlatma gerekmez.

## Entegre edilenler

| Eklenti / özellik | Nerede | Nasıl korunuyor |
|---|---|---|
| **Sosyal giriş** (Google, Microsoft Entra ID, GitHub, GitLab, Discord, Facebook, LinkedIn) | `social-providers.ts`, `sign-in-methods.ts`; giriş sayfası, Hesap → Güvenlik → Bağlı hesaplar | Örtük bağlama kapalı (`disableImplicitLinking`): aynı e-postayı bildiren sağlayıcı mevcut hesabı ele geçiremez. Bağlama yalnızca oturum açıkken, kişinin kendisi tarafından yapılır. Yeni hesap yalnızca yönetici izin verirse ve kayıt açıksa açılır. Yasak, rol IP sınırı, hız sınırı ve yeni cihaz bildirimi geçerlidir. |
| **Google One Tap** | Giriş sayfası (Google açıkken) | Aynı Google istemcisi kullanılır. Yeni hesap kuralı sosyal girişle aynıdır. |
| **Magic link** (e-postayla giriş bağlantısı) | `better-auth.ts`, `mail.ts` | Yalnızca mevcut hesaplar (`disableSignUp`). Belirteç özetlenmiş (hash) saklanır; 10 dakika geçerli ve tek kullanımlıktır. Captcha ve e-posta başına hız sınırı uygulanır. Dizin/SSO hesapları reddedilir. Bilinmeyen adrese de aynı yanıt verilir. |
| **Username** (kullanıcı adıyla giriş) | Hesap → Profil, giriş formu | Yalnızca panel parolası olan hesaplar (dizin hesabı dizini atlayamaz). `/is-username-available` kapalıdır (hesap varlığı sızmaz). Hız sınırı ve IP sınırı uygulanır. |
| **Have I Been Pwned** | Kayıt, parola değiştirme/sıfırlama, yönetici parolası | Yalnızca SHA-1 özetinin ilk 5 karakteri dışarı gider (k-anonymity). Servise ulaşılamazsa parola kabul edilir. Eklentinin kendisi yerine `isPasswordCompromised` bu amaçla kullanıldı. |
| **Geçici e-posta engeli** (better-auth-harmony'nin kullandığı `mailchecker` listesi) | Kayıt | Harmony'nin şema değişikliği (benzersiz `normalizedEmail` sütunu) gerekmediği için yalnızca liste kullanıldı. |
| **Generic OAuth / OIDC** | Ayarlar → Dizin ve SSO | Önceden vardı. Bu turda ilk SSO girişinde hesap kaydının atlanması hatası düzeltildi. |

## Zaten karşılananlar

| Bağlantı | Karşılığı |
|---|---|
| admin | Kullanıcı yönetimi, yasak, oturumlar, adına giriş (`checkAdminEndpoint` ile yetki denetimi). |
| phone-number | SMS ile telefon doğrulama ve iki adımlı doğrulama. |
| email-otp | E-posta koduyla giriş (Ayarlar → Giriş güvenliği). |
| last-login-method | Giriş sayfasındaki "son kullanılan" etiketi. |
| captcha | Kendi captcha'mız (Turnstile, reCAPTCHA, hCaptcha); form bazında açılıp kapatılır. Yeni yollara da eklendi. |
| credentials-plugin (üçüncü taraf) | LDAP/Active Directory girişi `directory-signin.ts` ile. |
| audit-logs (infrastructure) | Kendi denetim kaydımız (`audit_events`); veri dışarı gitmez. |
| email / sms service (infrastructure) | Kendi e-posta (SMTP + 13 API sağlayıcısı) ve SMS sağlayıcılarımız. |
| sso (eklenti paketi) | Tek OIDC sağlayıcısı için generic-oauth + `sso.ts`. |
| i18n | Web hata kodlarını kendisi çeviriyor (Türkçe/İngilizce). |

## Bilinçli olarak eklenmeyenler

| Bağlantı | Neden |
|---|---|
| anonymous | Kimliği belirsiz hesaplar sunucu sipariş edip çalıştırabilir; bir barındırma paneli için zararlı. |
| sentinel (infrastructure) | Better Auth'un ücretli bulut servisine ve API anahtarına bağlı; giriş trafiği dışarı gider. Karşılığı: captcha, Redis hız sınırları, 2FA kilidi, rol IP sınırı, yeni cihaz bildirimi. |
| audit-logs / email / sms (infrastructure) | Ücretli ve barındırılan servis; panel verisi dışarı çıkar. Kendi karşılıkları var (yukarıda). |
| organization | Büyük bir model değişikliği; mevcut rol ve sınır sistemiyle çakışır. Çok kullanıcılı müşteri hesapları planlanırsa ayrı bir iş olarak ele alınmalı. |
| api-key | Panelin kendi kişisel API anahtarları var (Geliştirici sayfası, `Authorization: Bearer lvm_…`; `apps/api/src/developer.ts`). Eklentiye gerek yok. |
| oauth-provider, cimd, jwt | Panel başka uygulamalar için kimlik sağlayıcı değil; oturumlarımızı dışarıda doğrulayan bir servis yok. |
| scim | Kurumsal dizin eşitlemesi; LDAP girişi ve grup → rol eşlemesi bunu karşılıyor. |
| bearer | Çerez + CSRF başlığı kullanılıyor; bearer token, tarayıcıda saklandığında çalınma riski ekler. |
| device-authorization | Panel için bir CLI aracı yok. |
| multi-session | Konsol oturumu iptali, adına giriş ve denetim kaydı modelini karmaşıklaştırır; faydası düşük. |
| oauth-proxy | Önizleme dağıtımları için; panel kendi sunucusunda çalışıyor. |
| one-time-token | Şu an ihtiyaç yok (ileride konsol devri için düşünülebilir). |
| open-api | Üretimde tüm uç noktaları listeler. |
| test-utils | Yalnızca test içindir; üretim örneğine eklenmemeli. |
| validation-better-auth | better-auth kendi gövdelerini doğruluyor, ek alanları kendi kancalarımız denetliyor. |
| better-auth-cloudflare | Yalnızca Cloudflare Workers/D1 üzerinde çalışır. |
| better-auth-harmony (tamamı) | Şema değişikliği ve mevcut tekrar eden adresler riski. Geçici alan adı engeli listesi `mailchecker` ile ayrıca eklendi. |

## Oturumlar ve çevrimiçi durum

- **Çevrimiçi:** panel sekmesi açık. Bunu canlı bağlantı (SSE) her 25 saniyede tazeler; kayıt Redis'te 70 saniye tutulur.
- **Az önce aktif:** son 15 dakikada bir istek var.
- **Çevrimdışı:** ikisi de yoksa.
- **Kayıtlar:** her oturumun son etkinliği ve son IP adresi (`auth_sessions.last_active_at`, `last_ip`) ile kişinin son görülme zamanı (`users.last_seen_at`) dakikada en fazla bir kez yazılır.
- **Oturum listesi:** Yönetim → Kullanıcılar → Oturumlar ile Hesap → Güvenlik'te her oturum için cihaz, ilk ve son IP, başlangıç, son etkinlik, bitiş ve "şu an açık" bilgisi gösterilir.
- **Oturum sonlandırma:** oturumlar tek tek sonlandırılabilir. Belirteç hiçbir zaman ekrana gönderilmez.
