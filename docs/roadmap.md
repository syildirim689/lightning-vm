# Ne var, ne yok

Bu sayfa eskiden sekiz maddelik bir yol haritasıydı; o maddelerin hepsi yazıldı ve ürün çok ötesine geçti
(faturalandırma, destek, bayiler, altı ek hipervizör). Var olanların listesi [README](../README.md)'dedir. Burada
yalnızca **olmayanlar** ve **denenmemiş olanlar** durur. Tarih ya da söz verilmiş bir sıra yoktur.

## Gerçek ortamda denenmemiş olanlar
- **VMware:** testlerin çoğu govmomi simülatörüyle yapıldı; gerçek vCenter'daki kabul testleri
  ([provisioning.md](provisioning.md), [console.md](console.md)) yapılmadı.
- **Tarayıcı konsolu:** VMware HTML Console SDK depoda yok; akış gerçek SDK ile hiç denenmedi.
- **Proxmox VE, XCP-ng, oVirt, Hyper-V, KVM (libvirt):** gerçek bir sunucuda çalıştırılmadı. Incus yalnızca
  konteynerlerle, tek bir Incus 6.0 sunucusunda denendi (sanal makine, LXD ve küme denenmedi).
- **Ödeme:** beş tahsilat entegrasyonundan (iyzico, PayTR, Craftgate, Param, Stripe) hiçbiri gerçek bir üye işyeri
  hesabıyla denenmedi.
- **e-Fatura:** İzibiz ve Uyumsoft dışındaki entegratörler denenmedi; mükellef alıcıya e-Fatura gönderimi hiçbirinde
  denenmedi.
- **WISECP modülü** bir WISECP kurulumunda, **IP yönetimi** gerçek bir colocation bloğunda denenmedi.
- Bağımsız (üçüncü taraf) bir güvenlik denetimi yapılmadı. Yapay zekâ destekli, kısmi bir iç denetim yapıldı ve
  bulguları düzeltildi; kapsamı ve bakılmayan alanlar: [security-audit.md](security-audit.md).

## Yazılmamış olanlar
- **Altı yeni platformda** konsol, firewall, hız sınırlama, yedek ve geri yükleme, kişisel imaj, ISO kitaplığı, özel
  ağ, taşıma, ağ taraması. XCP-ng, oVirt, Hyper-V, KVM ve Incus'ta kullanım grafikleri ve trafik sayımı; XCP-ng,
  oVirt, KVM ve Incus'ta sunucu başına işlemci ölçümü. Hyper-V, KVM ve Incus'ta Windows misafir özelleştirmesi.
- **Ödeme:** listedeki 46 sağlayıcıdan 41'iyle tahsilat. Stripe için webhook (ödeme bugün müşterinin
  tarayıcısı panele dönünce ya da tahsilat çalıştırması Stripe'a yeniden sorunca işlenir). Param dönüşünün Param'a sorularak doğrulanması (o zamana kadar Param ödemeleri personelce elle onaylanır). PayTR ve Param'da kayıtlı
  kartla otomatik yenileme.
- **Kimlik:** bir projeyi birden çok kullanıcının paylaştığı ekip yapısı. Proje başına kota (okuyan kod var, tanımlayan ekran ya da API yok).
- **Ağ:** çalışan bir sunucuya sonradan ek IP ekleme. Ayrı IPv6 havuzları ve sunucu başına birden çok IPv6 adresi
  (bugün: IPv4 havuzuna eklenen önekten tek adres). Yük dengeleyici.
- **İşletim:** izlemeyi kurulumdan sonra panelden açıp kapatma (yalnızca `install.sh monitoring on|off`). Birden çok
  sunucuda çalışma (cluster; [cluster.md](cluster.md) yalnızca tasarımdır). GHCR imajlarıyla sürümlü, imzalı kurulum
  paketi (kurulum ve güncelleme kaynak koddan derler). Panel sunucusunda Debian / Ubuntu dışındaki dağıtımlar için
  işletim sistemi güncellemeleri; müşteri sunucularında Windows güncellemeleri.
- **API belgelerinde** tarayıcıdan istek çalıştırma.
- GPU geçişi, NUMA ayarları.
