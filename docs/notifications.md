# Bildirimler

Tek bir olay kataloğu (`apps/api/src/notify.ts`) ve beş kanal: panel içi, tarayıcı, e-posta, SMS ve mesajlaşma
uygulamaları (`chat`; 13 uygulama, aşağıda). Tek tek sayıldığında 17 teslimat yolu eder.

- **Panel içi:** sağ üstteki zil. Okunmamış sayısı gösterilir, panel açıkken yeni bildirim kısa bir uyarı olarak çıkar.
- **Tarayıcı (Web Push):** panel kapalıyken bile sistem bildirimi gelir. Kullanıcı bunu Hesabım →
  Bildirimler'den cihaz başına açar. VAPID anahtarları ilk kullanımda üretilir ve özel anahtar şifreli
  saklanır. Süresi dolmuş abonelikler (404/410) otomatik silinir. Web Push için HTTPS gerekir.
  Abonelik kuralları: adres (endpoint) herkese açık bir HTTPS adresi ve hostu **düz bir DNS adı** olmalıdır (harf,
  rakam, nokta, tire; sayıyla yazılmış bir IP adresi ya da yüzde kodlu / olağan dışı bir host reddedilir; özel / iç
  ağ adresleri reddedilir ve bağlantı kurulurken yeniden denetlenir); kullanıcı başına en çok 20 abonelik (`LIMIT_REACHED`); başka bir hesabın
  aboneliği yalnızca aynı tarayıcı anahtarlarıyla devralınır (`PUSH_ENDPOINT_IN_USE`); kullanıcı adına oturum açmış
  personel abonelik ekleyemez (`NOT_WHILE_IMPERSONATING`). Çıkış yapmak ya da oturumun sona ermesi o tarayıcıdaki
  aboneliği kapatır; birinin oturumları hangi yolla kapatılırsa kapatılsın (personelin yasaklaması, oturum iptali,
  parola ataması; kişinin parola sıfırlaması ya da diğer oturumlarını kapatması) kapatılan tarayıcıların
  abonelikleri de silinir.
- **E-posta:** e-posta ayarlıysa çalışır (docs/settings.md). Bildirim e-postaları bir süre Node 22'de bir tarih
  biçimi seçeneği hatası yüzünden **hiç gönderilmiyordu** (parola sıfırlama, giriş bağlantısı ve kod postaları
  etkilenmiyordu); ikinci güvenlik turunda düzeltildi ([upgrade-notes.md](upgrade-notes.md)).
- **SMS:** SMS ayarlıysa ve kullanıcının telefonu doğrulanmışsa çalışır.
- **Mesajlaşma uygulamaları:** kullanıcının bağladığı Telegram, Slack, webhook ve benzerleri
  ([aşağıda](#mesajlaşma-uygulamaları-kanal-chat)).

## Önce yönetici, sonra kullanıcı
Ayarlar → Bildirim kuralları'nda her olay için şunlar belirlenir:
- açık mı;
- hangi kanallar kullanılabilir;
- hangileri varsayılan olarak açık;
- kullanıcı kendi seçimini değiştirebilir mi.

Kullanıcı, Hesabım → Bildirimler'de yalnızca izin verilen kanallar arasından seçim yapar.
Yönetici bir olayı sabitlerse ("kullanıcı değiştiremez"), kullanıcıların önceki seçimleri yok sayılır ve
varsayılanlar uygulanır.

## Olaylar
Tablo olayların yalnızca bir bölümünü gösterir (sunucu, fatura, destek, itiraz, uygulama kurulumu, trafik, bütçe ve
diğerleri eklendi). Güncel ve tam liste koddaki katalogdur; panelde Ayarlar → Bildirim kuralları hepsini gösterir.

| Olay | Kime | Varsayılan kanallar |
|---|---|---|
| `server.ready` (sunucu hazır) | sahibi | panel, tarayıcı, e-posta |
| `server.failed` (işlem başarısız) | sahibi | panel, tarayıcı, e-posta |
| `server.deleted` | sahibi | panel |
| `server.power` (güç işlemi tamamlandı) | sahibi | panel |
| `auth.sign_in` (yeni giriş) | kullanıcı | panel, e-posta |
| `auth.password_changed` | kullanıcı | panel, e-posta |
| `auth.two_factor_changed` | kullanıcı | panel, e-posta |
| `admin.user_registered` | `users.view` izni olanlar | panel |
| `admin.operation_failed` | `servers.view_all` izni olanlar | panel, tarayıcı |
| `admin.insight` (kritik içgörü) | `dashboard.view` izni olanlar | panel, e-posta |

Kritik içgörüler 10 dakikada bir hesaplanır ve her biri en fazla günde bir kez gönderilir. Bunlar:
- havuz dolmak üzere;
- boş IP kalmadı;
- bağlantı erişilemiyor;
- takılmış işlem;
- worker durdu;
- yedek başarısız.

Parola sıfırlama bağlantısı, iki adımlı doğrulama kodu ve telefon doğrulama kodu bildirim değildir;
her zaman kendi kanallarından gider.

## Teslimat
API ve worker yalnızca `notifications` BullMQ kuyruğuna iş bırakır. Kuyruğu API süreci tüketir:
1. alıcıları bulur;
2. her alıcı için kanalları hesaplar (yönetici kuralı ∩ kullanıcı seçimi ∩ kanalın hazır olması);
3. kanal kanal gönderir.

Bir kanalın hatası diğerlerini durdurmaz ve loglanır. İş, geçici hatalar için 3 kez denenir.

Kullanıcı her kanalı Hesabım → Bildirimler'deki "Test gönder" düğmesiyle deneyebilir. Test gönderimleri sınırlıdır:
hesap başına saatte 6 (bütün kanallar birlikte), SMS'te ayrıca numara başına saatte 6; aşılırsa `429` döner.

## Yeni bir bildirim eklemek
1. Olayı `catalog`a ekleyin: kime gideceği, kullanılabilir ve varsayılan kanallar, bağlantı ve TR/EN metin.
2. Olayın olduğu yerden `notify('olay', alıcılar, veri)` çağırın. Worker'da bunun yerine `notifications` kuyruğuna iş ekleyin.
3. Panel metinlerini (`Notify.events.<olay>`) iki dile ekleyin.
4. Entegrasyon testi yazın (`apps/api/test/integration/platform.test.mjs`).

## Mesajlaşma uygulamaları (kanal: `chat`)
Kullanıcı Hesap → Bildirimler → Mesajlaşma uygulamaları'ndan Telegram, WhatsApp, Slack, Discord, Microsoft Teams,
Google Chat, Mattermost, Rocket.Chat, Matrix, ntfy, Gotify, Pushover veya JSON webhook bağlar (en fazla 10).
Bağlantı yalnızca ilk mesaj ulaşırsa kaydedilir; her biri duraklatılabilir, test edilebilir, kaldırılabilir.
Yönetici Ayarlar → Mesajlaşma'dan sunulan uygulamaları seçer ve hesap gerektirenleri kurar: Telegram botu
(BotFather anahtarı; kullanıcı `t.me/<bot>?start=<kod>` ile eşleşir), WhatsApp Cloud API (kalıcı anahtar, telefon
numarası kimliği, gövdesi `{{1}}` başlık `{{2}}` metin olan onaylı şablon) ve Pushover uygulama anahtarı.
Kullanıcının verdiği adresler herkese açık HTTPS olmalıdır; özel/iç ağ adresleri reddedilir. Webhook'a imza
anahtarı verilirse istek `X-Lightning-Signature: sha256=<HMAC>` başlığıyla gelir. Kod: `apps/api/src/chat*.ts`.

Destek: `support.reply` (yanıt geldi), `support.rate` (talebi destek ya da 7 günlük sessizlik kapattığında puan
isteği; müşteri kendisi kapattıysa gönderilmez), personele `support.ticket_opened`, `support.customer_message`,
`account.message` (yöneticinin kullanıcılar listesinden toplu gönderdiği mesaj), `support.assigned`, `support.overdue` (yanıt süresi geçen talep; her süre için bir kez, 5 dakikada bir kontrol) ve `support.low_rating` (1–2 puan; yalnızca **ilk** puanda, sonradan değiştirilen puan kimseye bildirilmez). Uygulama içi bildirimler iki dilde saklanır (`notifications.texts`); zil, panelin o anki diline
göre gösterir. E-posta, SMS ve sohbet kanalları hesabın dilini kullanır.

Destek bildirimlerinin kuralları:
- **Atanan kişi:** bir talep yalnızca `support.manage` izni olan birine atanabilir. Sahibi `support.view` iznini
  kaybettiğinde ya da yasaklandığında talepleri atanmamış duruma döner. Personel olayları, ister ekibe ister tek
  tek hesaplara gönderilsin, yalnızca o olayın iznini hâlâ taşıyan etkin hesaplara gider; atanan kişi artık göremiyorsa
  bildirim ekibe gider.
- **Müşteri yanıtları ve puanlar sınırlıdır:** talep başına 10, müşteri başına 30 (10 dakikada); aşılırsa `429`.
- **Art arda yanıtlar tek bildirimdir:** aynı talepte art arda gelen müşteri yanıtları için personele bir bildirim
  gider; sonraki bildirim iki dakika sonra ya da personel arada yanıt verdiyse gönderilir.
