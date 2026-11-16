# Ayarlar: marka, e-posta, bot koruması, SMS

Yönetim → Ayarlar sayfasındadır. Görmek için `settings.view`, değiştirmek ve test etmek için
`settings.manage` izni gerekir (docs/auth.md, Roller). Her değişiklik denetim kaydına yazılır.

Parolalar, gizli anahtarlar ve SMS hesap bilgileri `secrets/master.key` ile AES-256-GCM şifrelenip
`settings` tablosunda saklanır. API bunları hiçbir zaman geri döndürmez; panel yalnızca "kayıtlı" olduğunu
bilir. Bir gizli alanı boş bırakarak kaydetmek kayıtlı değeri korur.

## Genel
Kullanıcı kaydının açık olup olmadığı. Varsayılan olarak kapalıdır.

## Marka
- **Panel adı:** en fazla 40 karakter. Menüde, giriş sayfasında, sekme başlığında, e-postalarda ve SMS'lerde görünür.
- **Vurgu rengi:** `#rrggbb`. Düğmelerdeki yazı rengi okunabilirliğe göre otomatik seçilir. Açık veya
  koyu zeminde kontrast 3:1'in altına düşerse sayfa uyarır.
- **Logo ve favicon:** PNG, JPEG, WebP veya ICO; en fazla 256 KB. SVG kabul edilmez, çünkü script
  taşıyabilir. Dosyanın ilk baytları bildirilen türle eşleşmelidir.
- Görseller `GET /api/public/branding/logo` ve `/favicon` adreslerinden `X-Content-Type-Options: nosniff`
  ile sunulur. Her kaydedişte adresin sürüm parametresi değişir, bu yüzden tarayıcı önbelleği eski görseli göstermez.

## E-posta (SMTP)
- **Alanlar:** sunucu, port, güvenlik (STARTTLS 587, SSL/TLS 465, şifresiz 25), kullanıcı adı, parola,
  gönderen adı ve adresi.
- **Hazır profiller:** Gmail/Google Workspace, Outlook/Microsoft 365, Yandex, Zoho, SendGrid,
  Mailgun (AB), Amazon SES (Frankfurt) ve Brevo. Profil sunucu, port ve güvenliği doldurur.
- **Test:** formdaki değerlerle, kaydetmeden, bağlanır ve oturum açar, sonra bir test e-postası gönderir.
  Hata kodları ayrıdır:
  - `MAIL_AUTH_FAILED`
  - `MAIL_TLS_FAILED`
  - `MAIL_REJECTED`
  - `MAIL_HOST_NOT_FOUND`
  - `MAIL_CONNECTION_FAILED`
- **Ne için:** parola sıfırlama bağlantıları ve iki adımlı doğrulama kodları (SMS yoksa).
  Bildirim e-postaları bildirim kurallarından açılır (docs/notifications.md).
- **Eski kurulumlar:** `.env` içindeki `SMTP_URL` ve `MAIL_FROM`, burada kayıt yapılana kadar kullanılmaya devam eder.

## Bot koruması (CAPTCHA)
- **Sağlayıcılar:**
  - Cloudflare Turnstile
  - Google reCAPTCHA v2 (onay kutusu)
  - Google reCAPTCHA v3 (görünmez; en düşük skor ayarlanabilir, varsayılan 0,5)
  - hCaptcha
- **Formlar:** giriş, kayıt ve parola sıfırlama isteği için ayrı ayrı açılır.
- **Doğrulama:** tarayıcı jetonu `X-Captcha-Response` başlığıyla gönderir. API, her istekte o anki
  ayarı okuyarak jetonu sağlayıcının `siteverify` adresinde doğrular. Ayar değişikliği yeniden başlatma
  gerektirmez.
- **Sağlayıcıya ulaşılamazsa:** istek reddedilir (`CAPTCHA_UNAVAILABLE`); güvenlik kontrolü atlanmaz.
- **Test:** yönetici, girdiği site anahtarıyla widget'ı çözer. Jeton, girdiği gizli anahtarla sağlayıcıya
  doğrulatılır. Sonuçta alan adı, skor ve sağlayıcının hata kodları gösterilir.
- **Eski kurulumlar:** `.env` içindeki `TURNSTILE_*` anahtarları, burada kayıt yapılana kadar tüm formlar için kullanılır.

Cloudflare'in yayımladığı test anahtarlarıyla (her zaman geçen ve her zaman başarısız olan gizli
anahtarlar) entegrasyon testi yapıldı. reCAPTCHA ve hCaptcha gerçek anahtarlarla denenmedi.

## SMS
- **Sağlayıcı ve hesap:** sağlayıcıya göre değişen hesap alanları ve gönderici başlığı (originator) girilir.
- **İYS:** sağlayıcı destekliyorsa "ticari ileti" bayrağı vardır. Kod ve bildirimler bilgilendirme
  amaçlıdır; bu bayrağı genelde kapalı bırakın.
- **Ne için:**
  - iki adımlı doğrulama kodları (telefonu doğrulanmış kullanıcılara);
  - telefon doğrulama;
  - kullanıcının SMS'i seçtiği bildirimler.
- **Test:** formdaki değerlerle gerçek bir SMS gönderir.

Hiçbir sağlayıcı gerçek hesapla denenmedi. Her sağlayıcı, belgesinin güvenilirliğine göre işaretlidir:
- **docs:** sağlayıcının resmî API belgesine göre yazıldı.
- **partial:** resmî belge var ama yanıt biçimini tam anlatmıyor.
- **community:** herkese açık belge bulunamadı; başka projelerdeki entegrasyonlara göre yazıldı.

| Sağlayıcı | Uç nokta | Kimlik doğrulama | Belge |
|---|---|---|---|
| NetGSM | `api.netgsm.com.tr/sms/rest/v2/send` (JSON) | Basic (abone no + API alt kullanıcı) | docs |
| Verimor | `sms.verimor.com.tr/v2/send.json` | gövdede kullanıcı/parola + IP izni | docs |
| VatanSMS | `api.vatansms.net/api/v1/1toN` | `api_id` / `api_key` | partial |
| İleti Merkezi | `api.iletimerkezi.com/v1/send-sms/json` | key + hash | docs |
| Mutlucell | `smsgw.mutlucell.com/smsgw-ws/sndblkex` (XML) | `ka` / `pwd` | docs |
| JetSMS (Biotekno) | `smsapi.jetsms.com.tr/api/SendSms` | gövdede kullanıcı/parola | docs |
| Telsam | `sms.telsam.com.tr:9588/sms/create` | Basic | docs |
| Posta Güvercini | `postaguvercini.com/api_http/sendsms.asp` (ISO-8859-9) | kullanıcı/parola | docs |
| Kobikom | `sms.kobikom.com.tr/api/message/send` | `api_token` | partial |
| MasGSM / SenaGSM | `api.senagsm.com.tr/api/smspost/v1` (XML) | kullanıcı + API secret | partial |
| TTMesaj (Türk Telekom) | `restapi.ttmesaj.com/api/SendSms/SendSingle` | Bearer jeton + kullanıcı/parola | docs |
| Organik Haberleşme | `api.organikhaberlesme.com/sms/send` | `X-Organik-Auth` | docs |
| Hermes / İletişim Makinesi | `live.iletisimmakinesi.com/api/SingleShotWS/...` | günlük jeton | docs |
| Codec (FastSMS) | `fastsms-api.codec.com.tr/Soap.asmx/SendSms` | kullanıcı/parola | partial |
| Dataport | `api.dataport.com.tr/restapi/api/Messages/SendSMS` | OAuth parola akışı | community |
| SMSVitrini / MesajPaneli | `api.mesajpaneli.com/json_api/` | base64 JSON | community |
| Turatel | `processor.smsorigin.com/xml/process.aspx` | kullanıcı/parola/kanal | community |
| Mobildev | `xmlapi.mobildev.com/v1/transactional/send` | HMAC-SHA256 imza | community |
| Özel HTTP API | herhangi bir adres | `{to}`, `{text}`, `{sender}` şablonları ve başarı deseni | — |

Atlananlar:
- **Asist İletişim:** yalnızca SOAP API'si var ve herkese açık belgesi bulunamadı. Özel HTTP API ile bağlanabilir.
- **ArtıSMS ve Ajans SMS:** herkese açık bir API bulunamadı.

Ayrıntılı API notları `apps/api/src/sms-providers.ts` dosyasındadır. Birim testleri
(`apps/api/test/sms-providers.test.mjs`) her sağlayıcının belgelediği isteği kurduğunu ve başarılı
yanıtı doğru tanıdığını sahte `fetch` ile kontrol eder.

## E-posta sağlayıcıları

Ayarlar → E-posta'dan bir sağlayıcı seçilir:

- **SMTP:** herhangi bir posta sunucusu. Gmail, Outlook, Yandex, Zoho, SendGrid, Mailgun, SES ve Brevo için hazır
  ayarlar vardır.
- **HTTP API ile gönderenler** (`apps/api/src/mail-providers.ts`): Resend, SendGrid (global/EU), Mailgun (US/EU),
  Postmark, Amazon SES (API v2, SigV4 imzalı), Brevo, Mailjet, SparkPost (US/EU), MailerSend, SMTP2GO, Elastic
  Email, ZeptoMail. Bunlar SMTP portu gerektirmez.

Her sağlayıcının alanları, paneli ve API belgesi ekranda gösterilir. Gizli alanlar şifrelenmiş saklanır ve hiçbir
yanıtta geri dönmez; boş bırakılırsa kayıtlı değer korunur. "Deneme e-postası gönder" seçili sağlayıcıyla gerçek bir
ileti gönderir. Hatalar şu kodlarla gösterilir: `MAIL_AUTH_FAILED`, `MAIL_REJECTED`, `MAIL_CONNECTION_FAILED`.

## SMS ve ödeme: uluslararası sağlayıcılar

- **SMS:** Türk sağlayıcılarının yanında Twilio, Vonage (Nexmo), Infobip, Plivo, Sinch (bölge seçimli), Telnyx,
  Clickatell ve MessageBird (Bird) var. Numaralar E.164 biçiminde gönderilir. Twilio'da gönderen olarak bir
  Messaging Service SID'i (`MG...`) de girilebilir.
- **Ödeme:** "Uluslararası" grubunda Stripe, PayPal, Mollie, Adyen, Checkout.com, Razorpay, Square ve Paddle var.
  Bunlardan yalnızca **Stripe** ile ödeme alınabilir; diğer yedisinin yalnızca bilgileri saklanır ve sınanır
  ([payments.md](payments.md)).
  - Kimlik kontrolü para hareket ettirmez: bakiye, yöntem veya konum listesi okunur, token istenir ya da olmayan
    bir ödeme sorgulanır.
  - Canlı anahtar test modunda (veya tersi) verilirse istek gönderilmeden uyarılır.
