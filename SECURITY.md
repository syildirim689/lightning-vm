# Güvenlik

Bu sürüm üretim için uygun değildir. Kimlik doğrulama (iki adımlı doğrulama dahil, [docs/auth.md](docs/auth.md)) ve
HTTPS ([docs/domain-https.md](docs/domain-https.md)) var; **bağımsız (üçüncü taraf) bir güvenlik incelemesi henüz
yapılmadı.**

## Yapılan denetim

Kasım 2026'da yapay zekâ destekli bir güvenlik denetimi iki tur hâlinde yapıldı (`641aa4d` ve `d9f90d3` commit'leri
üzerinde): kaynak incelemesi ve ağ erişimi olmayan bir sandbox'ta, sahte veriyle yapılan sınırlı denemeler.

- **İlk tur** (deponun tamamı): 22 bulgu doğrulandı (1 yüksek, 10 orta, 11 düşük) ve hepsi düzeltildi.
- **İkinci tur** (ilk turun incelemediği alanlar ve ilk turun düzeltmelerinin yeniden denetimi): 26 bulgu doğrulandı
  (10 orta, 15 düşük, 1 bilgi amaçlı) ve hepsi düzeltildi. İlk turun 22 düzeltmesinin 17'si gerçek PostgreSQL
  üzerinde yeniden denetlendi ve tutuyor; 4'ü (dizin ve SSO girişi) yeniden denetlenemedi (projenin entegrasyon
  testleri kapsar); yeniden denetimin bulduğu beş eksik düzeltme tamamlandı. İlk turda incelenemeyen bakım isteği
  kanalı bu turda incelendi: bulgu yok.

Toplam 48 doğrulanmış bulgu düzeltildi. Denetim **kısmidir**: her turda tek bir tarama dalgası yapıldı; ikinci turda
dizin / SSO yeniden denetimi ve altı alan incelenmedi, dört aday bağımsız bir doğrulama almadı (ikisi değiştirilmedi).
Düzeltmeler gerçek hipervizörlerde, gerçek bir Proxmox kümesinde ve gerçek bir Param üye işyeri hesabıyla
doğrulanmadı; kurulum betiğinin yolları yalnızca sahte dosyalarla denendi. Ayrıntı: [docs/security-audit.md](docs/security-audit.md) (İngilizce); işletmeciyi etkileyen
değişiklikler: [docs/upgrade-notes.md](docs/upgrade-notes.md).

## Açık bildirme

- Güvenlik açıklarını sır veya istismar ayrıntılarıyla **herkese açık issue olarak paylaşmayın**.
- GitHub'ın özel bildirimini kullanın: deponun **Security → Report a vulnerability** sayfası
  (<https://github.com/syildirim689/lightning-vm/security/advisories/new>; Private Vulnerability Reporting bu depoda
  açıktır). Bildirim yalnızca depo sahibine ulaşır. Düğmeyi göremiyorsanız ayrıntı vermeden
  [Discussions](https://github.com/syildirim689/lightning-vm/discussions) üzerinden özel bir kanal isteyin.
- Desteklenen sürüm yalnızca en son yayımlanan sürümdür (şu an 0.x, beta); düzeltmeler `main` dalına ve bir
  sonraki sürüme girer.
- Bildirimde etkilenen sürümü (commit), bileşeni, gereken koşulları ve gözlediğiniz sonucu yazın. Denemelerinizi
  yalnızca kendi kurulumunuzda ve kendi verinizle yapın.

---

**English.** Not production-ready and not audited by an independent third party. An AI-driven, partial security
review was run in two rounds in November 2026 (commits `641aa4d` and `d9f90d3`); its 48 confirmed findings (22 in
round one, 26 in round two) are fixed and its limits are listed in [docs/security-audit.md](docs/security-audit.md). Please do not open public issues with exploit details or secrets:
use GitHub's private vulnerability reporting (Security → Report a vulnerability,
<https://github.com/syildirim689/lightning-vm/security/advisories/new>; it is enabled for this repository and reaches
only the maintainer). Only the latest release (0.x, beta) is supported; fixes land on `main` and in the next release.
Test only against your own installation.
