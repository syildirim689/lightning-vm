# Yerel doğrulama

- Next.js production build: başarılı.
- NestJS TypeScript build: başarılı.
- Worker ve health script JavaScript söz dizimi: başarılı.
- Kurulum betiği sh söz dizimi: başarılı.
- Compose, CI, release ve izleme YAML dosyalarının ayrıştırılması: başarılı.
- Her uygulama için package-lock.json oluşturuldu.

Bu ortamda Docker Engine bulunmadığından container derlemeleri, Compose ayağa
kaldırma, PostgreSQL/Redis entegrasyonu ve izleme servisleri çalıştırılarak
doğrulanmadı. CI bu temel container/Compose kontrollerini yapmak üzere eklendi;
GitHub üzerinde henüz çalıştırılmış değildir.

VMware ve konsol henüz uygulanmadığı için gerçek ESXi testi yapılmadı.
