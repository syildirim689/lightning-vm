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

Adaptör varsayılan olarak loopback ve bağlantı-yerel adresleri, ayrıca **kendi Docker ağlarındaki** adresleri
reddeder (panelin PostgreSQL, Redis ve API'si o ağlardadır; hata `ENDPOINT_BLOCKED`). Havuz böyle bir ağdaysa o
ağa izin verin (`.env`):

```bash
XCPNG_ALLOW_NETWORKS=10.20.0.0/16
```

Hiç bağlanılmaması gereken ağlar için `XCPNG_DENY_NETWORKS` vardır (virgülle ayrılmış CIDR'ler; izin listesi
yasak listesinin önüne geçer).

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
- İmajda **netplan gerekmez**: adaptör ağ ayarlarında arayüzü MAC adresiyle eşler ve ona `eth0` adını verir;
  cloud-init'in kendi ağ yazıcıları (NetworkManager, ifupdown) da bu ayarları okur.

Panel her yeni sunucuya `cidata` etiketli küçük bir **yapılandırma diski** takar. cloud-init ağ ayarlarını, sunucu
adını, SSH anahtarlarını, root parolasını, uygulama kurulumunu ve güncelleme bildiricisini bu diskten okur; yani
VMware'deki her özelleştirme XCP-ng'de de çalışır. Guest tools kurulu değilse sunucu, açıldıktan dört dakika sonra
kendisine verilen adreslerle hazır sayılır. Aynı kural, çekirdeğinde PV sürücüleri olup guest utilities kurulu
olmayan imajlar için de geçerlidir (hazır bulut imajlarının çoğu): içeriden adres bildirilmedikçe dört dakika beklenir.

## Bu sürümde çalışanlar

Keşif ve kapasite · şablondan sunucu oluşturma (CPU, bellek, disk, ağ, cloud-init'in tamamı) · açma / kapatma /
yeniden başlatma / temiz kapatma · silme (diskleri ve anlık görüntüleriyle) · boyut değiştirme · anlık görüntü alma, geri dönme, silme ·
ek disk ekleme ve kaldırma · mevcut VM'i devralma · sunucu ayrıntıları · topoloji · tutarlılık denetimi.

## Henüz olmayanlar

Bu işlemler XCP-ng bağlantılarında "henüz desteklenmiyor" yanıtı verir: tarayıcı konsolu, firewall ve hız
sınırlama, yedekleme ve geri yükleme, kişisel imaj, ISO kitaplığı ve CD takma, özel ağlar, canlı taşıma.

Ayrıca:

- **Grafikler boş gelir:** kullanım geçmişi XAPI'nin RRD dosyalarında durur ve bu sürüm onları okumaz. Aynı
  nedenle trafik sayımı ve host işlemci kullanımı yoktur.
- Sunucu kopyası her zaman **tam kopyadır** (seçilen depolamaya); hızlı klon kullanılmaz.
- Boyut değiştirme için sunucu kapalı olmalıdır (panel bunu kendisi yapar).
- **Sabit parmak izi ve 8.2'den eski havuzlar:** yapılandırma diski, bir havuz üyesinin kendi (yerel) deposuna o
  üyeye yönlendirilerek yüklenir. Sabit parmak izi yöneticinin sertifikasını tanır; üyelerin sertifikalarını panel
  havuzdan okur ve bu yalnızca XCP-ng / XenServer 8.2 ve sonrasında vardır. Daha eski havuzlarda sabit parmak iziyle
  bir üyenin yerel SR'sine yapılandırma diski yüklenemez (`TLS_PIN_MISMATCH`); paylaşımlı SR ya da CA ile doğrulama
  kullanın.
