# Lightning VM ürün kapsamı

## Dağıtım hedefi
Önce GitHub kaynak deposu hazırlanır. Daha sonra başka bir Ubuntu sunucuda .sh
kurucuyla yüklenir. İleride kullanıcıya ait alan adından kurulum betiği sunulabilir.
Şu anda alan adı, indirme URL'si veya GitHub kullanıcı adı varsayılmamıştır.
Claude için aktarım promptu bu paketin parçası değildir.

## Paneller
Tek uygulamada kullanıcı ve yönetici paneli, ayrı yetkiler.
Kullanıcı hazır paket veya özel CPU/RAM/disk ile sunucu oluşturabilir.
Özel kaynak seçimi fiziksel ayrılmış kaynak garantisi anlamına gelmez.
Yönetici tüm sunucuları, müşterileri, paketleri, imajları ve kaynakları yönetir.

## Altyapı
Doğrudan ESXi ve vCenter bağlantısı hedeflenir. vCenter hostları çift sayılmaz.
Kaynak havuzu host, datastore, ağ, IP havuzu ve satılabilir kapasite içerir.
Yönetici kapasiteyi satışa açar; fiziksel kaynak yaratmaz.
Gerçek yetenekler lisans/sürüm keşfiyle belirlenir. Ücretsiz ESXi API yazma
kısıtları kurulumdan önce gerçek ortamda kontrol edilir.

## Otomasyon
İşlem kaydı, atomik kapasite/IP rezervasyonu, BullMQ işi, imaj dağıtımı,
cloud-init, açılış ve readiness kontrolü. Yeniden denemede çift VM üretilmez.
VM durumuyla panel durumu düzenli uzlaştırılır. Yeniden kurulum, silme,
snapshot ve paket değişimi sonraki modüllerdir. Snapshot yedek değildir.

## Konsol
Kullanıcı kendi VM konsoluna; yönetici yetkili olduğu tüm VM konsollarına ulaşır.
WebMKS, kısa ömürlü erişim ve özel ağ geçidi hedeflenir. Konsol işletim sistemi
kimlik doğrulamasını atlamaz. Sahiplik, origin ve oturum iptali kontrol edilir.

## İşletim
JSON log, işlem kimliği, ayrı audit kayıtları; Prometheus/Grafana/Loki/OTel.
İleri aşamada Tempo, Alertmanager, host/VM metrikleri ve gerçek bildirim kanalları.
Yedekleme ve kurtarma testi; sürüm doğrulama, migration ve bakım penceresiyle
kararlı GitHub sürümlerinden otomatik güncelleme. Çalışan VM'ler panel
servislerinden bağımsızdır. Konsol bağlantısı güncellemede kopabilir.

## İlk kabul hedefi
Kimlik doğrulamalı test ortamında ESXi/vCenter keşfi, tek Linux VM oluşturma,
IP/SSH hazırlığı, kullanıcı ve yönetici konsolu, yetkisiz erişim reddi ve silme.
