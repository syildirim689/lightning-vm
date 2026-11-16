# XCP-ng / XenServer

Panel, VMware ve Proxmox VE'nin yanında **XCP-ng** ve **XenServer / Citrix Hypervisor** havuzlarını da yönetir.
Arkada XAPI ile konuşan ayrı bir adaptör (`services/xcpng`) çalışır; VMware adaptörüyle aynı sözleşmeyi
konuşur: [adapter-contract.md](adapter-contract.md).

> [!WARNING]
> XCP-ng desteği **ilk sürümdür**. Adaptör, XAPI'nin davranışını taklit eden testlerle sınandı ve kullandığı her
> çağrı resmî XAPI tanımıyla karşılaştırıldı; **gerçek bir XCP-ng havuzunda henüz denenmedi.** Üretimde
> kullanmadan önce bir test hostunda deneyin.

## Bağlantı eklemek

Yönetim → Bağlantılar → Yeni bağlantı → **XCP-ng / XenServer**.

| Alan | Değer |
|---|---|
| Adres | **Havuz yöneticisinin (master)** adresi. Başka bir host verilirse panel, yöneticinin adresini söyler. |
| Port | `443` (varsayılan) |
| Kullanıcı | Havuz yöneticisi yetkisi olan kullanıcı; genellikle `root` |
| Sertifika | Sistem CA'ları, verilen CA ya da sabit parmak izi (kendinden imzalı sertifika için) |

Parmak izini hostta şu komutla karşılaştırın:

```bash
openssl x509 -in /etc/xensource/xapi-ssl.pem -noout -fingerprint -sha256
```

Havuz panel sunucusuyla aynı yerel ağdaysa adaptörün o ağa erişmesine izin verin (`.env`):

```bash
XCPNG_ALLOW_NETWORKS=10.20.0.0/16
```

## Panel havuzu nasıl görür

| Panelde | XCP-ng'de |
|---|---|
| İşlem kaynağı | Havuz (tek kaynak; konum havuzu gösterir) |
| Host | Havuzdaki her host |
| Veri deposu | Disk tutan depolama (SR); ISO kitaplıkları hariç |
| Ağ | Köprüsü olan her ağ |
| Şablon imajı | Kendi oluşturduğunuz şablon (hazır gelen yerleşik şablonlar listelenmez) |
| Sunucu | `lvm-<sunucu kimliği>` adlı VM |

## Şablon hazırlama

- Bir VM kurun, içine **cloud-init** ve **guest tools** (xe-guest-utilities) kurun, sonra şablona çevirin.
- cloud-init'in **NoCloud** veri kaynağı açık olmalı (çoğu bulut imajında öyledir).

Panel her yeni sunucuya `cidata` etiketli küçük bir **yapılandırma diski** takar. cloud-init ağ ayarlarını, sunucu
adını, SSH anahtarlarını, root parolasını, uygulama kurulumunu ve güncelleme bildiricisini bu diskten okur; yani
VMware'deki her özelleştirme XCP-ng'de de çalışır. Guest tools kurulu değilse sunucu, açıldıktan dört dakika sonra
kendisine verilen adreslerle hazır sayılır.

## Bu sürümde çalışanlar

Keşif ve kapasite · şablondan sunucu oluşturma (CPU, bellek, disk, ağ, cloud-init'in tamamı) · açma / kapatma /
yeniden başlatma / temiz kapatma · silme (diskleriyle) · boyut değiştirme · anlık görüntü alma, geri dönme, silme ·
ek disk ekleme ve kaldırma · mevcut VM'i devralma · sunucu ayrıntıları · topoloji · tutarlılık denetimi.

## Henüz olmayanlar

Bu işlemler XCP-ng bağlantılarında "henüz desteklenmiyor" yanıtı verir: tarayıcı konsolu, firewall ve hız
sınırlama, yedekleme ve geri yükleme, kişisel imaj, ISO kitaplığı ve CD takma, özel ağlar, canlı taşıma.

Ayrıca:

- **Grafikler boş gelir:** kullanım geçmişi XAPI'nin RRD dosyalarında durur ve bu sürüm onları okumaz. Aynı
  nedenle trafik sayımı ve host işlemci kullanımı yoktur.
- Sunucu kopyası her zaman **tam kopyadır** (seçilen depolamaya); hızlı klon kullanılmaz.
- Boyut değiştirme için sunucu kapalı olmalıdır (panel bunu kendisi yapar).
