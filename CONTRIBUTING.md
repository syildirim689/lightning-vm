# Katkı
Değişiklikleri açıklayan pull request açın. Sır, .env veya gerçek müşteri verisi göndermeyin.
Her uygulama kendi package-lock.json dosyasını taşır; npm ci kullanın.
API: npm test. Web: npm test, npm run build, npm run test:e2e. Worker: npm run check.
Yeni kullanıcı metni yalnızca messages/tr.json ve en.json üzerinden eklenir (docs/i18n.md).
Docker derlemeleri CI üzerinden kontrol edilir. Yeni VM işlemleri idempotency,
yetkilendirme, hata kurtarma ve gerçek test ortamı doğrulaması gerektirir.
