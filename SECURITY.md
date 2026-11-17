# Güvenlik

Bu sürüm üretim için uygun değildir. Kimlik doğrulama (iki adımlı doğrulama dahil, [docs/auth.md](docs/auth.md)) ve
HTTPS ([docs/domain-https.md](docs/domain-https.md)) var; **bağımsız (üçüncü taraf) bir güvenlik incelemesi henüz
yapılmadı.**

## Yapılan denetim

Kasım 2026'da `641aa4d` commit'i üzerinde yapay zekâ destekli bir güvenlik denetimi yapıldı: kaynak incelemesi ve ağ
erişimi olmayan bir sandbox'ta, sahte veriyle yapılan sınırlı denemeler. 22 bulgu doğrulandı (1 yüksek, 10 orta,
11 düşük) ve hepsi düzeltildi. Denetim **kısmidir**: tek bir tarama turu yapıldı, panelin kendi sunucusunu yöneten
bakım isteği kanalı ve 13 alan hiç incelenmedi, düzeltmeler gerçek hipervizörlerde ve gerçek bir Param üye işyeri
hesabıyla doğrulanmadı. Ayrıntı: [docs/security-audit.md](docs/security-audit.md) (İngilizce); işletmeciyi etkileyen
değişiklikler: [docs/upgrade-notes.md](docs/upgrade-notes.md).

## Açık bildirme

- Güvenlik açıklarını sır veya istismar ayrıntılarıyla **herkese açık issue olarak paylaşmayın**.
- GitHub'ın özel bildirimini kullanın: deponun **Security → Report a vulnerability** sayfası (Private Vulnerability
  Reporting). Bu düğme görünmüyorsa özellik henüz açılmamıştır; ayrıntı vermeden bir issue açıp depo sahibinden özel
  bir bildirim kanalı isteyin.
- Bildirimde etkilenen sürümü (commit), bileşeni, gereken koşulları ve gözlediğiniz sonucu yazın. Denemelerinizi
  yalnızca kendi kurulumunuzda ve kendi verinizle yapın.

---

**English.** Not production-ready and not audited by an independent third party. An AI-driven, partial security
review was run on commit `641aa4d` in November 2026; its 22 confirmed findings are fixed and its limits are listed in
[docs/security-audit.md](docs/security-audit.md). Please do not open public issues with exploit details or secrets:
use GitHub's private vulnerability reporting (Security → Report a vulnerability) or, if it is not enabled, ask the
maintainer for a private channel. Test only against your own installation.
