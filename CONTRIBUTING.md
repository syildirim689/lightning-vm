# Katkı / Contributing

Lightning VM açık kaynaktır (Apache-2.0) ve beta aşamasındadır; hata bildirimleri, düzeltmeler, çeviriler ve
belge katkıları memnuniyetle karşılanır. Katılan herkes [davranış kurallarına](CODE_OF_CONDUCT.md) uyar.

## Nereden başlanır
- **Soru ya da fikir:** [GitHub Discussions](https://github.com/syildirim689/lightning-vm/discussions).
- **Hata:** [issue](https://github.com/syildirim689/lightning-vm/issues/new/choose) açın; sürümü, adımları ve
  gördüğünüzü yazın. Güvenlik açıklarını herkese açık yazmayın: [SECURITY.md](SECURITY.md).
- **Değişiklik:** depoyu çatallayın (fork), bir dal açın, değişikliği ve nedenini açıklayan bir pull request
  gönderin. Büyük bir değişiklikten önce Discussions'ta ya da bir issue'da konuşmak boşa emeği önler.

## Kurallar
- Sır, `.env` veya gerçek müşteri verisi göndermeyin.
- Her uygulama kendi `package-lock.json` dosyasını taşır; `npm ci` kullanın.
- API: `npm test`. Web: `npm test`, `npm run build`, `npm run test:e2e`. Worker: `npm run check`.
- Yeni kullanıcı metni yalnızca `messages/tr.json` ve `en.json` üzerinden eklenir ([docs/i18n.md](docs/i18n.md)).
- Kurulum betikleri (`scripts/*.sh`) POSIX `sh` ile yazılır (dash ve busybox ash'te çalışmalı):
  `shellcheck -s sh scripts/install.sh scripts/get.sh`.
- Docker derlemeleri CI üzerinden kontrol edilir. Yeni VM işlemleri idempotency, yetkilendirme, hata kurtarma ve
  gerçek test ortamı doğrulaması gerektirir.
- Kullanıcının gördüğü her değişiklik README'ye, işletmeciyi etkileyen her değişiklik
  [docs/upgrade-notes.md](docs/upgrade-notes.md) sayfasına ve [CHANGELOG.md](CHANGELOG.md) dosyasının
  "Unreleased" bölümüne yazılır.
- Katkınız, projenin geri kalanı gibi Apache-2.0 lisansıyla yayımlanır (lisansın 5. maddesi).

---

**English.** Lightning VM is open source (Apache-2.0) and in beta; bug reports, fixes, translations and
documentation are welcome. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

- **Questions and ideas:** [GitHub Discussions](https://github.com/syildirim689/lightning-vm/discussions).
- **Bugs:** open an [issue](https://github.com/syildirim689/lightning-vm/issues/new/choose) with the version, the
  steps and what you saw. Never report a vulnerability in public: [SECURITY.md](SECURITY.md).
- **Changes:** fork the repository, make a branch and send a pull request that says what changed and why. For a
  large change, talk first in Discussions or an issue.

Rules: no secrets, `.env` files or real customer data. Each app has its own `package-lock.json`; use `npm ci`.
Tests: `npm test` in `apps/api`; `npm test`, `npm run build` and `npm run test:e2e` in `apps/web`;
`npm run check` in `apps/worker`. User-visible text goes through `messages/tr.json` and `en.json` only
([docs/i18n.md](docs/i18n.md)). The installer scripts are POSIX `sh` (they must run under dash and busybox ash):
`shellcheck -s sh scripts/install.sh scripts/get.sh`. New VM operations need idempotency, authorization, failure
recovery and a check against a real test environment. User-visible changes go into the README, changes an
operator can notice into [docs/upgrade-notes.md](docs/upgrade-notes.md), and both into the "Unreleased" section of
[CHANGELOG.md](CHANGELOG.md). Contributions are licensed under Apache-2.0 like the rest of the project (section 5
of the licence).
