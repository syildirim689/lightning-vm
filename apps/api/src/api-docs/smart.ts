// The words for the routes of the rule-based helpers added after the first set (anomalies.ts and its neighbours):
// what the panel works out from its own data and shows with the numbers behind it.
import type { Docs } from './types';

const serverId = { name: 'id', type: 'uuid', required: true, text: { tr: 'Sunucu kimliği.', en: 'Server id.' } };

const docs: Docs = {
  // ---- anomalies.ts ----
  'GET /servers/:id/anomalies': {
    tag: 'servers',
    summary: { tr: 'Sunucunun olağan dışı kullanım bulgularını ve yeterli geçmiş olup olmadığını verir.', en: 'Returns a server\'s unusual-use findings and whether there is enough history to judge.' },
    details: { tr: 'Saatte bir sunucunun işlemci (son 3 tam saat, önceki günlerin aynı saatleriyle) ve ağ kullanımı (bugün ya da dün, önceki 14 günle) kendi geçmişiyle karşılaştırılır; medyan ve medyan mutlak sapma kullanılır. Bulgu, sayıları geçerli olduğu sürece açık kalır. İşlemci ölçümü vermeyen platformlarda (XCP-ng, oVirt, libvirt, Incus) `measured` false gelir ve hiçbir sonuca varılmaz. Çağıranın gizlediği bulgular listede yer almaz, yalnızca sayılır. Sunucuda hiçbir şey değiştirmez.',
      en: 'Once an hour the server\'s CPU (the last 3 complete hours against the same hours of earlier days) and network use (today or yesterday against the 14 days before) are compared with its own history, using the median and the median absolute deviation. A finding stays open while its numbers hold. On platforms that report no CPU figures (XCP-ng, oVirt, libvirt, Incus) `measured` is false and nothing is concluded. Findings the caller hid are not listed, only counted. Changes nothing on the server.' },
    params: [serverId],
    returns: { tr: '`measured`, `days` (son 14 günde işlemci geçmişi olan gün sayısı), `minDays`, `enough`, `anomalies` (`id`, `metric`: cpu ya da network, `direction`: high ya da low, `openedAt`, `lastSeen`, `detail`: `recent` ya da `value`, `usual`, `scale`, `z`, `baseline`, `days`, `outShare`, `hint`) ve `hidden`.',
      en: '`measured`, `days` (days with CPU history in the last 14), `minDays`, `enough`, `anomalies` (`id`, `metric`: cpu or network, `direction`: high or low, `openedAt`, `lastSeen`, `detail`: `recent` or `value`, `usual`, `scale`, `z`, `baseline`, `days`, `outShare`, `hint`) and `hidden`.' },
    errors: ['NOT_FOUND'],
  },
  'GET /admin/anomalies': {
    tag: 'admin-servers',
    summary: { tr: 'Tüm sunuculardaki olağan dışı kullanım bulgularını listeler.', en: 'Lists the unusual-use findings of all servers.' },
    details: { tr: 'servers.view_all yetkisi gerekir. Açık bulgular ve son 7 günde kapananlar, en çok 500. `detail.hint`, sayılar kötüye kullanım izlemenin aradığına benzediğinde dolar (`cpu_pinned`: işlemci %90 ve üstünde; `outbound`: trafiğin en az %90\'ı giden); `abuseOpen` aynı sunucuda açık kötüye kullanım bulgularının sayısıdır. Bu liste istatistiktir, kötüye kullanım bulgusu oluşturmaz.',
      en: 'Needs servers.view_all. Open findings and those closed in the last 7 days, at most 500. `detail.hint` is set when the numbers resemble what abuse monitoring watches for (`cpu_pinned`: CPU at 90% or more; `outbound`: at least 90% of the traffic outbound); `abuseOpen` counts the abuse findings open on the same server. The list is statistics; it creates no abuse finding.' },
    returns: { tr: '`anomalies`: bulgunun alanları ile `resolvedAt`, `serverId`, `serverName`, `owner`, `location`, `abuseOpen`.', en: '`anomalies`: the finding\'s fields with `resolvedAt`, `serverId`, `serverName`, `owner`, `location`, `abuseOpen`.' },
    errors: ['FORBIDDEN'],
  },
  // ---- schedule-suggest.ts ----
  'GET /servers/:id/schedule-suggestion': {
    tag: 'operations',
    summary: { tr: 'Sunucunun kullanım geçmişinden çıkan güç zamanlaması önerisini verir.', en: 'Returns the power schedule suggested by a server\'s usage history.' },
    details: { tr: 'Son 4 haftanın saatlik işlemci geçmişinde haftanın hangi saatlerinin her hafta boşta geçtiğine bakılır (saatlik ortalama %3\'ün, en yüksek örnek %10\'un altında; en az 3 hafta görülmüş olmalı; ölçümü olmayan saat kullanımda sayılır). Gece penceresi en az 6 saat, haftalık pencere (hafta sonu) en az 24 saat olmalıdır; sunucu, kullanıldığı saatlerden bir saat önce açılır, bir saat sonra kapatılır. 21 günden kısa geçmişte `not_enough_data`, işlemci ölçümü vermeyen platformda `not_measured`, açma ya da kapatma zamanlaması zaten varsa `scheduled` döner. Kapalı sunucu aynı ücretle faturalandığı için `savesMoney` false gelir; enerji tahmini yalnızca ölçülen platformlarda dolar. Hiçbir şey değiştirmez.',
      en: 'Looks at the hourly CPU history of the last 4 weeks for the hours of the week that were idle every week (hourly average under 3%, highest sample under 10%; seen in at least 3 weeks; an hour without measurements counts as in use). A nightly window needs at least 6 hours, a weekly one (a weekend) 24; the server is started an hour before and stopped an hour after the hours it was in use. With under 21 days of history the answer is `not_enough_data`, on a platform without CPU figures `not_measured`, with a start or shutdown schedule already there `scheduled`. A switched-off server is billed the same, so `savesMoney` is false; the energy estimate is filled only where the platform measures. Changes nothing.' },
    params: [serverId],
    query: [{ name: 'timezone', type: 'string', text: { tr: 'Saatlerin hesaplanacağı IANA saat dilimi (ör. Europe/Istanbul). Verilmezse hesabın saat dilimi, o da yoksa UTC.', en: 'The IANA time zone the times are worked out in (e.g. Europe/Istanbul). Left out: the account\'s zone, else UTC.' } }],
    returns: { tr: '`state` (suggested, not_measured, not_enough_data, scheduled, always_idle, no_window), `timezone`, `days`, `minDays`, `weeks`, öneri varsa `kind` (nightly, weekly), `offHours` (haftada kapalı saat), `idleHours`, `schedules` (`action`, `days`, `time`), ayrıca `savesMoney`, `energyKwhPerWeek` ve `hidden`.',
      en: '`state` (suggested, not_measured, not_enough_data, scheduled, always_idle, no_window), `timezone`, `days`, `minDays`, `weeks`, with a suggestion `kind` (nightly, weekly), `offHours` (hours off per week), `idleHours`, `schedules` (`action`, `days`, `time`), and `savesMoney`, `energyKwhPerWeek` and `hidden`.' },
    errors: ['NOT_FOUND', 'VALIDATION_FAILED'],
  },
  'POST /servers/:id/schedule-suggestion': {
    tag: 'operations',
    summary: { tr: 'Önerilen güç zamanlamalarını oluşturur.', en: 'Creates the suggested power schedules.' },
    details: { tr: 'Öneri sunucu tarafında, o anki geçmişten yeniden hesaplanır; istekle gelen hiçbir şey neyin oluşturulacağını belirlemez. Zamanlamalar elle eklenmiş gibi oluşturulur: aynı yetki (server.power ve yöneticinin güç anahtarı), sunucu başına 10 sınırı ve denetim kaydı (`server.schedule_created`, `suggested: true`). Sonrasında sıradan zamanlamalardır; düzenlenebilir, durdurulabilir, silinebilir.',
      en: 'The suggestion is worked out again on the server, from the history as it is now; nothing in the request decides what is created. The schedules are created as if added by hand: the same permission (server.power and the administrator\'s power switch), the limit of 10 per server and the audit record (`server.schedule_created`, `suggested: true`). Afterwards they are ordinary schedules: they can be edited, paused and removed.' },
    params: [serverId],
    body: [{ name: 'timezone', type: 'string', text: { tr: 'Zamanlamaların kaydedileceği IANA saat dilimi; öneriyi okurken kullanılanla aynı olmalıdır.', en: 'The IANA time zone the schedules are saved with; the same one the suggestion was read in.' } }],
    example: { timezone: 'Europe/Istanbul' },
    returns: { tr: '`schedules`: oluşturulan zamanlamalar (201).', en: '`schedules`: the schedules created (201).' },
    errors: ['NOT_FOUND', 'NO_SUGGESTION', 'VALIDATION_FAILED', 'ACTION_NOT_PERMITTED', 'ACTION_DISABLED'],
  },
  // ---- payment-risk.ts ----
  'GET /admin/billing/risk': {
    tag: 'admin-billing',
    summary: { tr: 'Ödeme riski taşıyan hesapları, risk altındaki tutara göre sıralı verir.', en: 'Lists the accounts with payment risk, ordered by the amount at risk.' },
    details: { tr: 'billing.view yetkisi gerekir. Listeye girenler: vadesi geçmiş ödenmemiş faturası olan (itirazlı faturalar ve bakiye yüklemeleri hariç) ya da son 30 günde en az 2 başarısız tahsilatı olan hesaplar, para birimi başına bir satır. Risk altındaki tutar vadesi geçmiş toplamdır; vadesi geçmiş yoksa başarısız tahsilatların ait olduğu açık tutardır. Vadesi geçmiş tutarın bir bölümü son 7 günde eklendiyse neden OVERDUE_GROWING olur. En çok 200 satır. Kimseye bildirim göndermez, hiçbir şeyi askıya almaz.',
      en: 'Needs billing.view. Listed: accounts with unpaid invoices past their due date (disputed invoices and top-ups left out) or with at least 2 failed charges in the last 30 days, one row per currency. The amount at risk is the overdue total; with nothing overdue, the open amount the failed charges were for. When part of the overdue amount was added in the last 7 days the reason is OVERDUE_GROWING. At most 200 rows. It notifies nobody and suspends nothing.' },
    returns: { tr: '`accounts` (`userId`, `email`, `currency`, `atRisk`, `overdue`, `overdueCount`, `oldestDays`, `newOverdue`, `failedCharges`, `failedAmount`, `reasons`: OVERDUE, OVERDUE_GROWING, REPEATED_FAILURES) ve kullanılan eşikler `rule`.',
      en: '`accounts` (`userId`, `email`, `currency`, `atRisk`, `overdue`, `overdueCount`, `oldestDays`, `newOverdue`, `failedCharges`, `failedAmount`, `reasons`: OVERDUE, OVERDUE_GROWING, REPEATED_FAILURES) and the thresholds used, `rule`.' },
    errors: ['FORBIDDEN'],
  },
  // ---- support-suggest.ts ----
  'GET /admin/support/tickets/:id/similar': {
    tag: 'support',
    summary: { tr: 'Bir talebe en çok benzeyen kapanmış talepleri, kapatan yanıtlarıyla verir.', en: 'Returns the closed tickets most like a ticket, with the answers that closed them.' },
    details: { tr: 'support.view yetkisi gerekir. Talebin konusu ve müşterinin ilk mesajı, son 365 günde kapanmış ve personelin yanıtladığı en yeni 300 taleple karşılaştırılır. Sözcükler aramadaki gibi sadeleştirilir (büyük-küçük harf yok, Türkçe harfler düz: Şifre = sifre), sık geçen sözcükler atılır, benzerlik TF-IDF ağırlıklı kosinüsle ölçülür. En az 2 ortak sözcük ve 0,12 benzerlik gerekir; en çok 3 sonuç döner ve her biri ortak sözcükleri (neden gösterildiği) taşır. Hiçbir şey göndermez.',
      en: 'Needs support.view. The ticket\'s subject and the customer\'s first message are compared with the newest 300 tickets closed in the last 365 days that staff answered. Words are folded as in search (no capitals, plain letters for Turkish ones: Şifre = sifre), common words are dropped, and similarity is the TF-IDF weighted cosine. At least 2 shared words and a similarity of 0.12 are needed; at most 3 results come back, each with the shared words (why it is shown). It sends nothing.' },
    params: [{ name: 'id', type: 'uuid', required: true, text: { tr: 'Talep kimliği.', en: 'Ticket id.' } }],
    returns: { tr: '`compared` (karşılaştırılan talep sayısı) ve `similar`: `id`, `number`, `subject`, `closedAt`, `rating`, `score`, `shared`, `answer` (personelin son yanıtı, en çok 600 karakter).',
      en: '`compared` (how many tickets were compared) and `similar`: `id`, `number`, `subject`, `closedAt`, `rating`, `score`, `shared`, `answer` (the last staff answer, at most 600 characters).' },
    errors: ['NOT_FOUND', 'FORBIDDEN'],
  },
  'POST /support/suggestions': {
    tag: 'support',
    summary: { tr: 'Yeni talep yazılırken, onu yanıtlayabilecek mevcut içerikleri verir.', en: 'While a new ticket is written, returns what may already answer it.' },
    details: { tr: 'Yalnızca çağıranın zaten görebildiği kaynaklara bakılır: kendi taleplerinden personelin yanıtladıkları (en yeni 50) ve durum sayfası açıksa oradaki olaylar (açık olanların hepsi, son 7 günde çözülenlerden konuya benzeyenler). Başka müşterilerin talepleri hiçbir koşulda okunmaz. Gönderilen metin saklanmaz. Çok kısa metinde ya da 10 dakikada 60 istekten sonra hata yerine boş yanıt döner.',
      en: 'Only sources the caller can already see are read: their own tickets that staff answered (the newest 50) and, when the status page is on, its incidents (every open one, and those resolved in the last 7 days that are about the same thing). Other customers\' tickets are never read. The text sent is not stored. With too little text, or after 60 requests in 10 minutes, the answer is empty rather than an error.' },
    body: [
      { name: 'subject', type: 'string', text: { tr: 'Yazılmakta olan konu.', en: 'The subject being written.' } },
      { name: 'body', type: 'string', text: { tr: 'Yazılmakta olan mesaj (ilk 4000 karakteri okunur).', en: 'The message being written (its first 4000 characters are read).' } },
    ],
    example: { subject: 'SSH ile bağlanamıyorum', body: 'Port 22 kapalı görünüyor, connection refused hatası alıyorum.' },
    returns: { tr: '`incidents` (`id`, `title`, `impact`, `status`, `open`, `createdAt`, `resolvedAt`) ve `answers` (`id`, `number`, `subject`, `status`, `shared`, `answer`).',
      en: '`incidents` (`id`, `title`, `impact`, `status`, `open`, `createdAt`, `resolvedAt`) and `answers` (`id`, `number`, `subject`, `status`, `shared`, `answer`).' },
  },
  // ---- periodic-digest.ts ----
  'GET /account/digest': {
    tag: 'account',
    summary: { tr: 'Dönemsel özet ayarınızı verir.', en: 'Returns your periodic digest setting.' },
    details: { tr: 'Özet, olay başına bildirim yerine belirlediğiniz gün ve saatte (kendi saat diliminizde) durumu tek mesajda söyler; siz açmadıkça kapalıdır. Personel (dashboard.view) panelin özetini alır: önem derecesine göre açık bulgular, son özetten beri açılan ve kapananlar, ödeme riski altındaki hesaplar, başarısız işlemler, kapasite. Müşteriler kendi özetlerini (sunucularının bulguları, ayın tahmini, yaklaşan yenileme) yalnızca yönetici `account.digest` bildirimini açtıysa alabilir (`available`). Özet sıradan bir bildirim olarak gider: seçtiğiniz kanallar, yöneticinin kuralları ve sessiz saatler geçerlidir. Söyleyecek bir şeyi olmayan özet gönderilmez.',
      en: 'The digest says where things stand in one message, on the day and hour you choose (in your own time zone), instead of one notice per event; it is off until you turn it on. Staff (dashboard.view) get the digest of the panel: open findings by severity, what opened and closed since the last digest, accounts at payment risk, failed operations, capacity. Customers can have their own (findings on their servers, the forecast for the month, the upcoming renewal) only where the administrator has turned the `account.digest` notification on (`available`). It is sent as an ordinary notification: the channels you chose, the rules of the administrator and quiet hours apply. A digest with nothing to say is not sent.' },
    returns: { tr: '`kind` (staff, customer), `event`, `available`, `enabled`, `frequency` (weekly, daily), `day` (1 = Pazartesi), `hour` (0-23), `timezone`, `nextAt`, `lastSentAt` ve `channels` (özetin şu an gideceği kanallar).',
      en: '`kind` (staff, customer), `event`, `available`, `enabled`, `frequency` (weekly, daily), `day` (1 = Monday), `hour` (0-23), `timezone`, `nextAt`, `lastSentAt` and `channels` (where the digest goes as things stand).' },
  },
  'PUT /account/digest': {
    tag: 'account',
    summary: { tr: 'Dönemsel özeti açar, kapatır ya da zamanını değiştirir.', en: 'Turns the periodic digest on or off, or changes when it is sent.' },
    details: { tr: 'Sonraki özet, saatiniz seçilen saati bir sonraki geçtiğinde gönderilir. Yaz saatine geçişte atlanan saat, boşluktan sonraki ilk an sayılır; geri alınan saatte özet bir kez gider. Başka bir kullanıcı adına hareket edilirken değiştirilemez.',
      en: 'The next digest goes out the next time your clock passes the chosen hour. An hour skipped by a clock change counts as the first moment after the gap; an hour that comes twice sends once. Cannot be changed while acting as another user.' },
    body: [
      { name: 'enabled', type: 'boolean', required: true, text: { tr: 'Açık ya da kapalı.', en: 'On or off.' } },
      { name: 'frequency', type: 'string', values: ['weekly', 'daily'], text: { tr: 'Varsayılan weekly.', en: 'Defaults to weekly.' } },
      { name: 'day', type: 'integer', text: { tr: 'Haftalık özetin günü, 1 (Pazartesi) - 7 (Pazar). Varsayılan 1.', en: 'The day of a weekly digest, 1 (Monday) to 7 (Sunday). Defaults to 1.' } },
      { name: 'hour', type: 'integer', text: { tr: 'Saat, 0-23. Varsayılan 8.', en: 'The hour, 0-23. Defaults to 8.' } },
      { name: 'timezone', type: 'string', required: true, text: { tr: 'IANA saat dilimi, ör. Europe/Istanbul.', en: 'IANA time zone, e.g. Europe/Istanbul.' } },
    ],
    example: { enabled: true, frequency: 'weekly', day: 1, hour: 8, timezone: 'Europe/Istanbul' },
    returns: { tr: '`GET /account/digest` ile aynı.', en: 'The same as `GET /account/digest`.' },
    errors: ['VALIDATION_FAILED', 'DIGEST_NOT_AVAILABLE', 'NOT_WHILE_IMPERSONATING'],
  },
  'POST /account/digest/preview': {
    tag: 'account',
    summary: { tr: 'Özetin şu anki halini size hemen gönderir.', en: 'Sends you the digest as it would be written now.' },
    details: { tr: 'Aynı kanallardan, başlığında "Önizleme" ile gider; dönem sayılmaz (sonraki özet yine son gerçek özetle karşılaştırır). Söylenecek bir şey yoksa hiçbir şey gönderilmez ve yanıt `empty: true` der. Saatte 5 önizleme.',
      en: 'It goes through the same channels with "Preview" in its title and does not count as a period (the next digest still compares with the last real one). With nothing to say nothing is sent and the answer says `empty: true`. Five previews an hour.' },
    returns: { tr: '`sent`, `empty`, `channels`, ayrıca özetin hesabın dilindeki `title` ve `body` metni ve iki dildeki hali (`texts.tr`, `texts.en`).', en: '`sent`, `empty`, `channels`, and the `title` and `body` of the digest in the language of the account, with both languages in `texts.tr` and `texts.en`.' },
    errors: ['DIGEST_NOT_AVAILABLE', 'NOT_WHILE_IMPERSONATING', 'RATE_LIMITED'],
  },
  // ---- maintenance-hours.ts ----
  'GET /admin/maintenance/quiet-hours': {
    tag: 'admin-system',
    summary: { tr: 'Kurulumdaki sunucuların en sakin saatlerini, otomatik güncelleme penceresi için öneri olarak verir.', en: 'Returns the hours in which the installation\'s servers are least busy, as a suggestion for the automatic update window.' },
    details: { tr: 'system.view veya dashboard.view yetkisi gerekir. Son 4 haftanın saatlik işlemci geçmişi (meşgul vCPU: her sunucunun saatlik ortalaması × vCPU sayısı, toplanır) haftanın 168 saatine dağıtılır; en az 3 haftada görülmüş saatler karşılaştırılır ve en sakin 2 saatlik dilim bulunur: haftanın tamamında (`weekly`) ve her gün aynı saatte (`daily`). 21 günden kısa geçmişte `not_enough_data`, işlemci ölçümü veren hiçbir bağlantı yoksa `not_measured` döner. Saatler panel sunucusunun saat dilimindedir (güncelleme penceresi orada okunur); ajan saat dilimini kaydetmemişse UTC kullanılır ve `zoneKnown` false olur. Yalnızca öneridir: pencere `POST /admin/maintenance/requests` (`action: auto-update`) ile değişir. Yanıt 30 dakika saklanır.',
      en: 'Needs system.view or dashboard.view. The hourly CPU history of the last 4 weeks (busy vCPUs: each server\'s hourly average times its vCPUs, summed) is laid over the 168 hours of the week; hours seen in at least 3 weeks are compared and the quietest 2-hour stretch is found: in the whole week (`weekly`) and at the same time every day (`daily`). With under 21 days of history the answer is `not_enough_data`, without any connection that reports CPU figures `not_measured`. Times are in the panel server\'s time zone (where the update window is read); when the agent has not recorded it they are in UTC and `zoneKnown` is false. It only suggests: the window changes through `POST /admin/maintenance/requests` (`action: auto-update`). The answer is kept for 30 minutes.' },
    returns: { tr: '`state` (suggested, not_enough_data, not_measured), `days`, `minDays`, `weeks`, `timezone`, `zoneKnown`, `current` (kayıtlı pencere), öneri varsa `window` ("HH:00-HH:00"), `servers` (saat başına ölçülen sunucu), `usual` ve `peak` (haftanın ortalama ve en yüksek saatlik yükü), `weekly` (`day` 1 = Pazartesi, `time`, `end`, `hours`, `load`) ve `daily` (`time`, `end`, `hours`, `load`, `worst`: en yoğun günündeki yük).',
      en: '`state` (suggested, not_enough_data, not_measured), `days`, `minDays`, `weeks`, `timezone`, `zoneKnown`, `current` (the saved window), and with a suggestion `window` ("HH:00-HH:00"), `servers` (servers measured per hour), `usual` and `peak` (the week\'s mean and highest hourly load), `weekly` (`day` 1 = Monday, `time`, `end`, `hours`, `load`) and `daily` (`time`, `end`, `hours`, `load`, `worst`: the load on its busiest day).' },
    errors: ['FORBIDDEN'],
  },
  'GET /admin/vmware/connections/:id/quiet-hours': {
    tag: 'admin-vmware',
    summary: { tr: 'Bir bağlantının ve host\'larının sunucularının en sakin saatlerini verir (bakım planlamak için).', en: 'Returns the hours in which the servers of a connection and of each of its hosts are least busy (for planning maintenance).' },
    details: { tr: 'vmware.view, vmware.manage veya catalog.manage yetkisi gerekir. Kural `GET /admin/maintenance/quiet-hours` ile aynıdır; yalnızca bu bağlantının sunucuları, host başına da o host\'ta şu anda çalışan panel sunucuları sayılır (taşınmış bir sunucu, taşınmadan önceki saatleriyle birlikte şimdiki host\'una yazılır). İşlemci ölçümü vermeyen platformlarda (XCP-ng, oVirt, libvirt, Incus) `not_measured` döner. Hiçbir şey taşımaz ya da zamanlamaz.',
      en: 'Needs vmware.view, vmware.manage or catalog.manage. The rule is that of `GET /admin/maintenance/quiet-hours`; only this connection\'s servers count, and per host the panel servers running on it now (a server that was moved counts for its present host, with the hours before the move). Platforms without CPU figures (XCP-ng, oVirt, libvirt, Incus) answer `not_measured`. Nothing is moved or scheduled.' },
    params: [{ name: 'id', type: 'uuid', required: true, text: { tr: 'Bağlantı kimliği.', en: 'Connection id.' } }],
    query: [{ name: 'timezone', type: 'string', text: { tr: 'Saatlerin hesaplanacağı IANA saat dilimi. Verilmezse hesabın saat dilimi, o da yoksa UTC.', en: 'The IANA time zone the times are worked out in. Left out: the account\'s zone, else UTC.' } }],
    returns: { tr: '`timezone`, `connection` (yukarıdaki öneri alanları) ve `hosts` (panel sunucusu çalıştıran her host için `moref`, `name` ve aynı alanlar).', en: '`timezone`, `connection` (the suggestion fields above) and `hosts` (for every host that runs panel servers: `moref`, `name` and the same fields).' },
    errors: ['NOT_FOUND', 'VALIDATION_FAILED', 'FORBIDDEN'],
  },
};

export default docs;
