# VMware adapter — henüz uygulanmadı
Hedef: Go + govmomi. Ayrı container daha sonra eklenecek.

API sözleşmesi: discover, listServers, createServer, getOperation, powerOn,
shutdownGuest, reset, reinstall, deleteServer ve acquireConsoleTicket.

Bağlantı türü ESXi veya vCenter; gerçek yetenekler sürüm/lisans kontrolüyle belirlenir.
Her çağrıda işlem kimliği, idempotency key ve sunucu kimliği gerekir.
TLS doğrulama varsayılan açık; özel CA desteği olmalı.
Yönetim kimlik bilgileri şifreli tutulmalı; hiçbir sır loglanmamalı.
