# Lightning VM ürün kapsamı

Bu sayfa projenin başındaki kapsam notudur; aşağıda her bölüm bugünkü duruma göre düzeltildi. Var olanların ve
olmayanların güncel listesi: [README](../README.md) ve [roadmap.md](roadmap.md).

## Dağıtım hedefi
Kaynak GitHub deposundadır; bir Ubuntu sunucuya tek komutla (`scripts/get.sh`) ya da depoyu klonlayıp
`scripts/install.sh` ile kurulur. Kurulum ve güncelleme imajları kaynak koddan derler; hazır imajlarla sürümlü bir
kurulum paketi yoktur.

## Paneller
Tek uygulamada kullanıcı ve yönetici paneli, ayrı yetkiler.
Kullanıcı hazır paket veya özel CPU/RAM/disk ile sunucu oluşturabilir.
Özel kaynak seçimi fiziksel ayrılmış kaynak garantisi anlamına gelmez.
Yönetici tüm sunucuları, müşterileri, paketleri, imajları ve kaynakları yönetir.

## Altyapı
VMware (ESXi ve vCenter) ile başladı; Proxmox VE, XCP-ng, oVirt, Hyper-V, KVM (libvirt) ve Incus / LXD aynı
adaptör sözleşmesiyle, ilk sürüm olarak ve daha dar bir kapsamla eklendi. vCenter hostları çift sayılmaz.
Kaynak havuzu host, datastore, ağ, IP havuzu ve satılabilir kapasite içerir.
Yönetici kapasiteyi satışa açar; fiziksel kaynak yaratmaz.
Gerçek yetenekler lisans/sürüm keşfiyle belirlenir. Ücretsiz ESXi API yazma
kısıtları kurulumdan önce gerçek ortamda kontrol edilir.

## Otomasyon
İşlem kaydı, atomik kapasite/IP rezervasyonu, BullMQ işi, imaj dağıtımı,
cloud-init, açılış ve readiness kontrolü. Yeniden denemede çift VM üretilmez.
VM durumuyla panel durumu düzenli uzlaştırılır. Yeniden kurulum, silme (bekleme süresiyle), snapshot, boyut ve
paket değişimi, ek disk, kopyalama ve devretme vardır ([provisioning.md](provisioning.md)). Yedekleme yalnız
VMware'dedir. Snapshot yedek değildir.

## Konsol
Kullanıcı kendi VM konsoluna; yönetici yetkili olduğu tüm VM konsollarına ulaşır. Yalnız VMware'de vardır:
WebMKS, kısa ömürlü tek kullanımlık erişim ve ayrı bir ağ geçidi. VMware'in HTML Console SDK'sı depoda değildir ve
akış gerçek SDK ile denenmedi ([console.md](console.md)). Konsol işletim sistemi
kimlik doğrulamasını atlamaz. Sahiplik, origin ve oturum iptali kontrol edilir.

## İşletim
JSON log, işlem kimliği, ayrı audit kayıtları; isteğe bağlı Prometheus, Alertmanager, Grafana, Loki ve OTel
toplayıcısı (Tempo yok). Alarmlar panel bildirimi olarak gelir; bildirimler panel, tarayıcı, e-posta, SMS ve
mesajlaşma uygulamalarından gider. Şifreli yedek ve geri yükleme; migration denetimi ve bakım penceresiyle
kararlı GitHub sürümlerinden otomatik güncelleme. Çalışan VM'ler panel
servislerinden bağımsızdır. Konsol bağlantısı güncellemede kopabilir.

## İlk kabul hedefi (gerçek ortamda henüz yapılmadı)
Kimlik doğrulamalı test ortamında ESXi/vCenter keşfi, tek Linux VM oluşturma,
IP/SSH hazırlığı, kullanıcı ve yönetici konsolu, yetkisiz erişim reddi ve silme. Bu akış govmomi simülatörüyle
sınandı; gerçek vCenter'daki kabul testleri [provisioning.md](provisioning.md) ve [console.md](console.md) sonunda
"henüz yapılmadı" olarak listelidir.
