# oVirt / RHV

Panel; VMware, Proxmox VE ve XCP-ng'nin yanında **oVirt Engine**'i de yönetir (aynı API'yi kullanan Red Hat
Virtualization ve Oracle Linux Virtualization Manager dahil). Arkada Engine'in REST API'siyle konuşan ayrı bir
adaptör (`services/ovirt`) çalışır; VMware adaptörüyle aynı sözleşmeyi konuşur:
[adapter-contract.md](adapter-contract.md).

> [!WARNING]
> oVirt desteği **ilk sürümdür**. Adaptör, Engine'in davranışını taklit eden testlerle sınandı ve kullandığı her
> alan ile çağrı resmî API başvurusuyla karşılaştırıldı; **gerçek bir oVirt Engine'de henüz denenmedi.** Üretimde
> kullanmadan önce bir test ortamında deneyin.

## Bağlantı eklemek

Yönetim → Bağlantılar → Yeni bağlantı → **oVirt / RHV**.

| Alan | Değer |
|---|---|
| Adres | Engine'in adresi (yönetim arayüzünün açıldığı ad) |
| Port | `443` (varsayılan) |
| Kullanıcı | Alanıyla birlikte kullanıcı; genellikle `admin@internal` |
| Sertifika | Sistem CA'ları, verilen CA (Engine'in CA'sı) ya da sabit parmak izi |

Parmak izini Engine sunucusunda şu komutla karşılaştırın:

```bash
openssl x509 -in /etc/pki/ovirt-engine/certs/apache.cer -noout -fingerprint -sha256
```

Adaptör varsayılan olarak loopback ve bağlantı-yerel adresleri, ayrıca **kendi Docker ağlarındaki** adresleri
reddeder (panelin PostgreSQL, Redis ve API'si o ağlardadır; hata `ENDPOINT_BLOCKED`). Engine böyle bir ağdaysa o
ağa izin verin (`.env`):

```bash
OVIRT_ALLOW_NETWORKS=10.20.0.0/16
```

Hiç bağlanılmaması gereken ağlar için `OVIRT_DENY_NETWORKS` vardır (virgülle ayrılmış CIDR'ler; izin listesi
yasak listesinin önüne geçer).

## Panel Engine'i nasıl görür

| Panelde | oVirt'te |
|---|---|
| İşlem kaynağı | Küme (cluster) |
| Host | Kümedeki her host |
| Veri deposu | Veri (data) türündeki depolama alanları |
| Ağ | vNIC profili (`ağ / profil` olarak görünür) |
| Şablon imajı | Şablon (Blank hariç) |
| Sunucu | `lvm-<sunucu kimliği>` adlı VM |

## Şablon hazırlama

- Bir VM kurun, içine **cloud-init** ve **qemu-guest-agent** kurun, sonra şablon yapın.
- Misafirdeki ilk ağ arayüzünün adı **`eth0`** olmalı: panel ağ ayarlarını bu adla verir. Çoğu bulut imajında
  öyledir; değilse çekirdek satırına `net.ifnames=0` ekleyin. Engine ağ ayarlarını `eth0` için yazdığından arayüzü
  başka adla gelen imaj adres alamaz; keşif bunu her oVirt bağlantısında uyarı olarak gösterir
  (`GUEST_NIC_NAME_ETH0`).

Panel sunucunun ayarlarını Engine'in kendi cloud-init desteğiyle verir: sunucu adı, SSH anahtarları, adresler ve
DNS ayrı alanlar olarak; root parolası, uygulama kurulumu ve güncelleme bildiricisi "özel betik" olarak. Bunlar
VM oluşturulurken saklanır ve **ilk açılışta** uygulanır. Guest agent yoksa sunucu, açıldıktan dört dakika sonra
kendisine verilen adreslerle hazır sayılır.

## Bu sürümde çalışanlar

Keşif ve kapasite · şablondan sunucu oluşturma (tam kopya; CPU, bellek, disk, ağ, cloud-init) · açma / kapatma /
yeniden başlatma / temiz kapatma · silme · boyut değiştirme · anlık görüntü alma, geri dönme, silme · ek disk
ekleme ve kaldırma · mevcut VM'i devralma · sunucu ayrıntıları · topoloji (host işlemci ve bellek kullanımıyla) ·
tutarlılık denetimi.

## Henüz olmayanlar

Bu işlemler oVirt bağlantılarında "henüz desteklenmiyor" yanıtı verir: tarayıcı konsolu, firewall ve hız
sınırlama, yedekleme ve geri yükleme, kişisel imaj, ISO kitaplığı ve CD takma, özel ağlar, canlı taşıma.

Ayrıca:

- **Grafikler boş gelir:** Engine anlık değer verir, geçmiş tutmaz; trafik sayımı da yoktur.
- **Sunucudan sunucu kopyalanmaz:** kopya yalnızca şablondan çıkar; bir sunucuyu çoğaltmak için önce şablonunu
  alın.
- Yalnız ilk IPv4 ve ilk IPv6 adresi yapılandırılır.
- **Anlık görüntüye geri dönme sunucuyu önce kapatır:** Engine yalnızca kapalı bir VM'e geri yükler. Sunucu
  çalışıyorsa panel onu geri yüklemeden sonra yeniden başlatır.
- **16'dan fazla vCPU** soket × çekirdek olarak bölünür (Engine en çok 16 soket kabul eder): 16'ya kadar her vCPU
  bir sokettir; üstünde sayıyı tam bölen en büyük soket sayısı seçilir (32 vCPU = 16 × 2, 17 vCPU = 1 × 17).
