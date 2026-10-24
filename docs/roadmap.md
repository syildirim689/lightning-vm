# Yol haritası
1. Tamamlanan başlangıç: panellerin kabuğu, API sağlık kontrolleri, DB/Redis,
   worker heartbeat, Compose, metrik endpoint'i ve CI dosyaları.
2. Kullanıcı oturumları, RBAC, proje sahipliği ve denetim kayıtları.
3. ESXi/vCenter bağlantı doğrulama ve gerçek envanter keşfi.
4. Yönetici/kullanıcı konsol erişimi ve WebMKS geçidi.
5. Kaynak havuzları, paket/özel kaynak, atomik kapasite ve IP rezervasyonu.
6. cloud-init imajları, provisioning ve reconciliation.
7. Merkezi log aktarımı, panolar, alarmlar ve bağımsız yedekler (tamamlandı, docs/operations.md).
8. Güvenli otomatik güncelleme (kaynak checkout ile tamamlandı). Sırada: GHCR imajlarıyla sürümlü
   deployment paketi, imzalı kurulum paketi ve release notları.

İlk gerçek entegrasyon kabul testi: test VM oluşturma, IP/SSH hazırlığı,
her iki yetkiyle konsol erişimi, yetkisiz erişim reddi ve güvenli silme.
