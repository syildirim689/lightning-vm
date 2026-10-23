# Katkı
Değişiklikleri açıklayan pull request açın. Sır, .env veya gerçek müşteri verisi göndermeyin.
Her uygulama kendi package-lock.json dosyasını taşır; npm ci kullanın.
API: npm test. Web: npm run build. Worker: npm run check.
Docker derlemeleri CI üzerinden kontrol edilir. Yeni VM işlemleri idempotency,
yetkilendirme, hata kurtarma ve gerçek test ortamı doğrulaması gerektirir.
