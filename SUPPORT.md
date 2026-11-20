# Destek / Support

Lightning VM ücretsiz ve açık kaynaktır (Apache-2.0) ve **beta** aşamasındadır. Ücretli destek ya da yanıt süresi
taahhüdü yoktur; aşağıdaki yollar gönüllülük esasıyla izlenir.

| Ne için | Nereye |
|---|---|
| Soru, "nasıl yapılır", kurulum yardımı, fikir | [GitHub Discussions](https://github.com/syildirim689/lightning-vm/discussions) |
| Hata (yeniden üretilebilen, beklenmeyen davranış) | [Hata bildirimi](https://github.com/syildirim689/lightning-vm/issues/new?template=bug_report.yml) |
| Özellik isteği | [Özellik isteği](https://github.com/syildirim689/lightning-vm/issues/new?template=feature_request.yml) |
| Güvenlik açığı | **Herkese açık yazmayın.** [Özel bildirim](https://github.com/syildirim689/lightning-vm/security/advisories/new) ([SECURITY.md](SECURITY.md)) |
| Belgeler | [README](README.md), [`docs/`](docs/), <https://lightningvm.app> |

Yazmadan önce:

1. `sh scripts/install.sh check` çıktısına bakın: ön kontroller ve kurulu sistemin durumu (hiçbir şeyi değiştirmez).
2. Sürümü not edin: Yönetim → Sistem sayfasında ya da `git -C /opt/lightning-vm describe --tags --always`.
3. Kurulum ya da güncelleme sorunlarında betiğin kaydı `data/logs/` altındadır (yalnızca root okur); servis
   günlükleri: `docker compose logs --tail 100 SERVİS`.
4. Paylaştığınız çıktıdan parolaları, anahtarları, alan adlarını ve müşteri verisini çıkarın. `.env` ve `secrets/`
   içeriğini hiçbir zaman göndermeyin.

---

**English.** Lightning VM is free and open source (Apache-2.0) and in **beta**. There is no paid support and no
promised response time; the channels below are watched on a best-effort basis.

| For | Where |
|---|---|
| Questions, how-to, help with installing, ideas | [GitHub Discussions](https://github.com/syildirim689/lightning-vm/discussions) |
| Bugs (unexpected behaviour you can reproduce) | [Bug report](https://github.com/syildirim689/lightning-vm/issues/new?template=bug_report.yml) |
| Feature requests | [Feature request](https://github.com/syildirim689/lightning-vm/issues/new?template=feature_request.yml) |
| Security vulnerabilities | **Not in public.** [Private report](https://github.com/syildirim689/lightning-vm/security/advisories/new) ([SECURITY.md](SECURITY.md)) |
| Documentation | [README in English](README.en.md), [`docs/`](docs/) (mostly Turkish), <https://lightningvm.app> |

Before you write:

1. Look at `sh scripts/install.sh check`: the pre-flight checks and the state of the installation (it changes nothing).
2. Note the version: Admin → System, or `git -C /opt/lightning-vm describe --tags --always`.
3. For installer or update problems the script's log is under `data/logs/` (root only); service logs:
   `docker compose logs --tail 100 SERVICE`.
4. Remove passwords, keys, domain names and customer data from what you share. Never post `.env` or anything
   from `secrets/`.
