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
};

export default docs;
