# Mimari
Tarayıcı → Caddy → Next.js veya NestJS/Fastify API.
API → PostgreSQL + Redis/BullMQ. Worker uzun işleri yürütür.
Gelecek VMware adapter ve konsol geçidi yalnızca özel ağda çalışacak.

PostgreSQL kalıcı doğruluk kaynağıdır. Redis tek işlem kaydı değildir.
VMware çağrısı öncesi operation kaydı ve kaynak rezervasyonu; sonrasında task kimliği
saklanmalı. Timeout sonrası gerçek kaynak bulunmadan yeniden create çağrılmamalı.
Periyodik reconciliation ve kilitli IP/kaynak rezervasyonu zorunludur.

Şu anda worker yalnızca altyapı heartbeat'i yazar. Provisioning endpoint'i yoktur.
İş kuyruğuna dışarıdan eklenen işler desteklenmediği için reddedilir.
Kimlik doğrulama, roller, kurulum anahtarı ve denetim olayları uygulandı (docs/auth.md).

Güvenlik hedefi: müşteri/proje RBAC, MFA destekli yönetici oturumu, güvenli cookie,
CSRF koruması, secret encryption ve sınırlı servis kimlikleri.
Uygulananlar: rol kontrolü, güvenli cookie, CSRF, hız sınırı. Henüz yok: MFA, proje/müşteri
izolasyonu, secret encryption. HTTPS olmadan yalnızca loopback üzerinde kullanılmalı.

Güncellemeler GitHub kararlı sürümlerinden ileride alınacak. Web servisine Docker
socket bağlanmayacak. Migration, yedek doğrulama ve iş boşaltma uygulanmadan
otomatik updater etkinleştirilmeyecek.
