import type { Docs } from './types';

// The API's own routes: its reference, and the administrator's rules, token list and request log (api-access.ts).
export default {
  'GET /docs/reference': {
    tag: 'account',
    summary: { tr: 'API başvuru belgesini getirir.', en: 'Returns the API reference.' },
    details: { tr: 'Panelin her rotası, Türkçe ve İngilizce açıklaması, gereken yetki ve çağıranın kullanıp kullanamayacağı (allowed). Panelin belge sayfası ve PDF buradan üretilir.',
      en: 'Every route of the panel with its words in Turkish and English, the permission it needs and whether the caller may use it (allowed). The panel\'s reference page and PDF are made from it.' },
    returns: { tr: 'baseUrl, version, tags, commonErrors ve endpoints listesi.', en: 'baseUrl, version, tags, commonErrors and the endpoints list.' },
  },
  'GET /docs/openapi.json': {
    tag: 'account',
    summary: { tr: 'OpenAPI 3.1 belgesini getirir.', en: 'Returns the OpenAPI 3.1 document.' },
    details: { tr: 'İstemci kodu üreten araçlar (openapi-generator, Postman, Insomnia) için. Panelin kendi iç rotaları yer almaz.',
      en: 'For tools that generate client code (openapi-generator, Postman, Insomnia). The panel\'s own internal routes are left out.' },
    query: [
      { name: 'lang', type: 'string', values: ['tr', 'en'], text: { tr: 'Açıklamaların dili; varsayılan en.', en: 'Language of the descriptions; en by default.' } },
      { name: 'mine', type: 'string', values: ['1'], text: { tr: '1 ise yalnızca çağıranın yetkisinin yettiği rotalar.', en: '1: only the routes the caller\'s permissions reach.' } },
    ],
    returns: { tr: 'OpenAPI 3.1 JSON belgesi.', en: 'An OpenAPI 3.1 JSON document.' },
  },
  'GET /admin/api/settings': {
    tag: 'admin-settings',
    summary: { tr: 'API erişim kurallarını getirir.', en: 'Returns the API access rules.' },
    returns: { tr: 'who, maxDays, staffExpiry, rateLimit, networks, log, logDays.', en: 'who, maxDays, staffExpiry, rateLimit, networks, log, logDays.' },
  },
  'PUT /admin/api/settings': {
    tag: 'admin-settings',
    summary: { tr: 'API erişim kurallarını kaydeder.', en: 'Saves the API access rules.' },
    details: { tr: 'Kurallar yeni istekler için hemen geçerli olur. Süre kuralları yalnızca yeni anahtarlara uygulanır; var olan anahtarlar silinene veya süresi dolana kadar çalışır.',
      en: 'The rules apply to new requests at once. Lifetime rules apply to new tokens only; existing ones work until removed or expired.' },
    body: [
      { name: 'who', type: 'string', required: true, values: ['everyone', 'staff', 'off'], text: { tr: 'Kimler anahtar oluşturabilir: herkes, yalnızca personel veya kimse.', en: 'Who may create tokens: everyone, staff only, or nobody.' } },
      { name: 'maxDays', type: 'integer', text: { tr: 'Bir anahtarın en uzun ömrü (gün, 0–3650). 0: sınır yok; 0\'dan büyükse süresiz anahtar oluşturulamaz.', en: 'The longest life of a token in days (0–3650). 0: no limit; above 0, tokens without expiry are refused.' } },
      { name: 'staffExpiry', type: 'boolean', text: { tr: 'Personelin anahtarlarına bitiş tarihi zorunlu.', en: 'Staff tokens must have an expiry.' } },
      { name: 'rateLimit', type: 'integer', text: { tr: 'Anahtar başına dakikalık istek sınırı (0–100000, 0: sınır yok). Varsayılan 600.', en: 'Requests per token and minute (0–100000, 0: no limit). 600 by default.' } },
      { name: 'networks', type: 'string[]', text: { tr: 'Tüm anahtarların kullanılabileceği adresler (CIDR, en fazla 50). Boş: her adres.', en: 'Addresses every token may be used from (CIDR, at most 50). Empty: any address.' } },
      { name: 'log', type: 'boolean', text: { tr: 'Anahtarla yapılan istekleri kaydet.', en: 'Log requests made with tokens.' } },
      { name: 'logDays', type: 'integer', text: { tr: 'Günlüğün saklanacağı gün (1–365). Varsayılan 14.', en: 'Days the log is kept (1–365). 14 by default.' } },
    ],
    example: { who: 'staff', maxDays: 365, staffExpiry: true, rateLimit: 600, networks: ['203.0.113.0/24'], log: true, logDays: 30 },
    returns: { tr: 'Kaydedilen kurallar.', en: 'The saved rules.' },
  },
  'GET /admin/api/tokens': {
    tag: 'admin-settings',
    summary: { tr: 'Tüm hesapların API anahtarlarını listeler.', en: 'Lists the API tokens of every account.' },
    details: { tr: 'Anahtarın kendisi hiçbir zaman döndürülmez; yalnızca son dört karakteri (hint). Son 24 saatteki istek ve hata sayısı da gelir.',
      en: 'The token itself is never returned, only its last four characters (hint). Requests and errors in the last 24 hours come with it.' },
    returns: { tr: 'tokens: ad, kapsam, yetkiler, izinli adresler, sahip, son kullanım, bitiş, 24 saatlik sayılar.', en: 'tokens: name, scope, permissions, allowed addresses, owner, last use, expiry, 24-hour counts.' },
  },
  'DELETE /admin/api/tokens/:id': {
    tag: 'admin-settings',
    summary: { tr: 'Bir hesabın API anahtarını iptal eder.', en: 'Revokes an account\'s API token.' },
    details: { tr: 'Anahtar hemen çalışmaz olur ve denetim kaydına yazılır. Geri alınamaz; sahibi yeni anahtar oluşturmalıdır.', en: 'The token stops working at once and the audit log records it. Cannot be undone; the owner has to create a new one.' },
    params: [{ name: 'id', type: 'uuid', required: true, text: { tr: 'Anahtarın kimliği.', en: 'The token\'s id.' } }],
    returns: { tr: 'İçerik yok (204).', en: 'No content (204).' },
  },
  'GET /admin/api/log': {
    tag: 'admin-settings',
    summary: { tr: 'API anahtarlarıyla yapılan istekleri listeler.', en: 'Lists the requests made with API tokens.' },
    details: { tr: 'En yeniler önce. Yalnızca anahtarla yapılan istekler kaydedilir; panelin tarayıcı istekleri kaydedilmez. İstek ve yanıt gövdeleri saklanmaz.',
      en: 'Newest first. Only requests made with a token are logged, not the panel\'s browser requests. Request and response bodies are never stored.' },
    query: [
      { name: 'token', type: 'uuid', text: { tr: 'Yalnızca bu anahtarın istekleri.', en: 'Only this token\'s requests.' } },
      { name: 'status', type: 'string', values: ['errors'], text: { tr: 'errors: yalnızca 400 ve üstü yanıtlar.', en: 'errors: only answers of 400 and above.' } },
      { name: 'q', type: 'string', text: { tr: 'Yolda veya rota kalıbında geçen metin.', en: 'Text in the path or the route pattern.' } },
      { name: 'limit', type: 'integer', text: { tr: 'En fazla kaç kayıt (1–500, varsayılan 200).', en: 'How many rows at most (1–500, 200 by default).' } },
    ],
    returns: { tr: 'requests (yöntem, rota, yol, durum, süre, adres, anahtar, sahip), son 24 saatin özeti ve en çok çağrılan rotalar.',
      en: 'requests (method, route, path, status, duration, address, token, owner), a summary of the last 24 hours and the most called routes.' },
  },
} satisfies Docs;
