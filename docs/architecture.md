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
Uygulananlar: rol kontrolü, güvenli cookie, CSRF, hız sınırı, sahiplik kontrolü, VMware parolalarının
ayrı anahtarla şifrelenmesi. Henüz yok: MFA, çok kullanıcılı proje/ekip izolasyonu. HTTPS olmadan
yalnızca loopback üzerinde kullanılmalı.

Yedekleme, geri yükleme ve güncelleme hostta `scripts/install.sh` ile çalışır (docs/operations.md).
Web ve API container'larına Docker socket veya host yetkisi verilmez; panel sonuçları salt okunur bir
klasörden okur. Güncelleme yedek, migration uyumluluğu, iş boşaltma, sağlık kontrolü ve container
geri dönüşü içerir; veritabanı geri dönüşü yedekten elle yapılır.
