# Incus / LXD

Panel; VMware, Proxmox VE, XCP-ng, oVirt, Hyper-V ve KVM (libvirt)'in yanında **Incus** sunucularını ve kümelerini
de yönetir; aynı API'yi konuşan **LXD** de çalışır. Adaptör (`services/incus`) Incus'un REST API'sine bir
**istemci sertifikasıyla** bağlanır ve VMware adaptörüyle aynı sözleşmeyi konuşur:
[adapter-contract.md](adapter-contract.md).

Incus hem **sanal makine** hem **sistem konteyneri** çalıştırır. Panel ikisini de "sunucu" olarak satar: hangisi
olacağını seçtiğiniz **imajın türü** belirler.

> [!WARNING]
> Incus desteği **ilk sürümdür**. API yolları ve alan adları Incus'un yayımladığı API tanımıyla karşılaştırıldı;
> adaptör sahte bir Incus API'siyle, istemcisi de istemci sertifikası isteyen gerçek bir TLS sunucusuyla sınandı.
> **Gerçek bir Incus ya da LXD sunucusunda henüz hiç çalıştırılmadı.** Üretimde kullanmadan önce bir test
> sunucusunda deneyin.

## Sunucuyu hazırlamak

API'yi ağa açın (yalnızca yerel soket dinliyorsa panel bağlanamaz):

```bash
incus config set core.https_address :8443
```

Panel için bir istemci sertifikası üretin (herhangi bir makinede):

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 -subj "/CN=lightning-vm" -keyout lightning-vm.key -out lightning-vm.crt
```

Sertifikayı Incus sunucusuna tanıtın:

```bash
incus config trust add-certificate lightning-vm.crt
```

Yalnız bir projeye yetki vermek isterseniz:

```bash
incus config trust add-certificate lightning-vm.crt --restricted --projects musteriler
```

LXD'de komutlar `lxc config set core.https_address :8443` ve `lxc config trust add lightning-vm.crt` biçimindedir.

## Bağlantı eklemek

Yönetim → Bağlantılar → Yeni bağlantı → **Incus / LXD**.

| Alan | Değer |
|---|---|
| Adres | Incus sunucusunun (kümede herhangi bir üyenin) adresi |
| Port | `8443` (varsayılan) |
| Proje | Sunucuların oluşturulacağı Incus projesi; ayrı projeniz yoksa `default` |
| İstemci sertifikası ve anahtarı | `lightning-vm.crt` ve `lightning-vm.key` dosyalarının içeriği, art arda yapıştırılır |
| Sertifika | Sunucunun sertifikası kendinden imzalıdır: "sabit parmak izi" seçilir |

İki dosyayı tek metin olarak almak için:

```bash
cat lightning-vm.crt lightning-vm.key
```

Parmak izini sunucuda şu komutla karşılaştırın:

```bash
openssl x509 -in /var/lib/incus/server.crt -noout -fingerprint -sha256
```

Sertifika ve anahtar, diğer bağlantıların parolaları gibi şifrelenmiş saklanır. Sunucu panel sunucusuyla aynı
yerel ağdaysa adaptörün o ağa erişmesine izin verin (`.env`):

```bash
INCUS_ALLOW_NETWORKS=10.20.0.0/16
```

## Panel sunucuyu nasıl görür

| Panelde | Incus'ta |
|---|---|
| Host | Sunucunun kendisi; kümede her üye |
| İşlem kaynağı ve kaynak havuzu | Sunucu ya da küme; seçtiğiniz proje |
| Veri deposu | Depolama havuzu (`incus storage list`) |
| Ağ | Yönetilen ağlar ve köprüler (`incus network list`) |
| Şablon imajı | İmaj deposundaki imajlar (`incus image list`) |
| Sunucu | `lvm-<sunucu kimliği>` adlı instance (sanal makine ya da konteyner) |

## İmaj hazırlama

İmajlar Incus'un kendi imaj deposundan gelir; ayrıca şablon VM hazırlamak gerekmez. cloud-init içeren **cloud**
türevlerini indirin:

```bash
incus image copy images:ubuntu/24.04/cloud local: --vm --alias ubuntu-24
```

```bash
incus image copy images:debian/12/cloud local: --alias debian-12-konteyner
```

`--vm` ile indirilen imajdan **sanal makine**, onsuz indirilenden **konteyner** oluşur. Sonra panelde bağlantıyı
yenileyip imajı Yönetim → İmajlar'da eşleyin.

Panel her yeni sunucuya ağ ayarlarını, sunucu adını, SSH anahtarlarını, root parolasını, uygulama kurulumunu ve
güncelleme bildiricisini Incus'un cloud-init ayarlarıyla (`cloud-init.user-data`, `cloud-init.network-config`)
verir. IP adresi, sanal makinelerde imajın içindeki **Incus ajanı** ile okunur (cloud imajlarında vardır); ajan
yoksa sunucu, açıldıktan dört dakika sonra kendisine verilen adreslerle hazır sayılır.

Müşterilere genel IP verecekseniz sunucuları, hostun köprüsüne bağlı bir ağa koyun (NAT'lı `incusbr0` dışarıdan
erişilemez).

## Bu sürümde çalışanlar

Keşif ve kapasite (küme üyeleriyle) · imajdan sunucu oluşturma (CPU, bellek, disk, ağ, cloud-init'in tamamı) ·
açma / kapatma / yeniden başlatma / temiz kapatma · silme (ek disk birimleriyle) · boyut değiştirme · snapshot
alma, geri dönme, silme · ek disk ekleme ve kaldırma · mevcut instance'ı devralma · sunucu ayrıntıları · topoloji.

## Henüz olmayanlar

Bu işlemler Incus bağlantılarında "henüz desteklenmiyor" yanıtı verir: tarayıcı konsolu, firewall ve hız
sınırlama, yedekleme ve geri yükleme, kişisel imaj, ISO kitaplığı ve CD takma, özel ağlar, canlı taşıma.

Ayrıca:

- **Kümede yerleşim Incus'a bırakılır:** yeni sunucunun hangi üyede açılacağını Incus seçer.
- **Grafikler boş gelir:** Incus anlık kullanımı verir ama geçmiş tutmaz; anlık bellek kullanımı gösterilir.
- **Snapshot'a geri dönmek ayarları da geri alır:** sonradan alınmış snapshot'ların panelde verdiğiniz adları
  kaybolabilir (snapshot'ların kendisi durur).
- **Konteynerlerde ek disk** `/mnt/disk<n>` altına bağlanır; sanal makinelerde ham disk olarak görünür.
- Boyut değiştirme ve devralma için sunucu kapalı olmalıdır (boyut değiştirmede panel bunu kendisi yapar).
- **Windows misafirler yapılandırılmaz:** özelleştirme cloud-init ile yapılır.
- İsimlerde yalnız harf, rakam ve `-` kullanılabildiği için panelin verdiği `lvm-…` adları değiştirilmemelidir.
