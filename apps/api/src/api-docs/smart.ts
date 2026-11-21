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
};

export default docs;
